/*!
 * iamLamprey contact relay + mailing list + ratings — worker/src/index.js
 *
 * Five routes and one cron on one Worker, all on free tiers (the Workers
 * runtime, Turnstile, D1, KV and Resend's 3,000 emails a month):
 *
 *   /            the /contact/ form: check the origin, drop bots, verify a
 *                Turnstile token (mandatory), then hand the message to Resend.
 *                It stays the default route, so contact_endpoint in _config.yml
 *                needs no change.
 *   /subscribe   the site-wide newsletter form: the same origin/honeypot/mandatory
 *                Turnstile shape, but the address is written to the Resend contact
 *                list rather than emailed to an inbox.
 *   /polar       Polar's order webhook: verify the Standard Webhooks signature,
 *                add the buyer to that same list when the checkout's opt-in
 *                checkbox was ticked, mint the single-use rating invite from the
 *                order itself, and retire a rating when that order is refunded.
 *   /reviews     the form behind /reviews/: one rating, for one invite token.
 *   /api/ratings the live aggregates, read by the product page at load, and
 *                blended in the browser with the baseline.
 *
 * The cron in wrangler.toml's [triggers] sends the invite a day after the order,
 * so a rating posted thirty seconds after checkout never reaches the figures —
 * one email, one rating, and nothing to unsubscribe from.
 *
 * Only upsertContact() knows the list provider is Resend, so swapping it for Kit
 * or MailerLite later is one function. Secrets (RESEND_API_KEY,
 * RESEND_CONTACTS_KEY, TURNSTILE_SECRET, POLAR_WEBHOOK_SECRET) are Worker
 * secrets set in the Cloudflare dashboard; the topic and segment ids and the
 * rest are in wrangler.toml's [vars] block.
 */

const TURNSTILE_VERIFY = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';
const RESEND_API = 'https://api.resend.com';
const RESEND_ENDPOINT = `${RESEND_API}/emails`;
const EMAIL_SHAPE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

// how far a signed webhook's timestamp may drift before it counts as a replay
const WEBHOOK_TOLERANCE = 300;

// the no-js round trip lands back on the page with one of these flags in the
// query string. /contact/ keeps the pair ibl-contact.js already reads; the
// newsletter form and /reviews/ use their own, so one page's submission cannot
// light up another page's form. flags[0] is success.
const CONTACT = { flags: ['sent', 'error'], fallback: '/contact/' };
const NEWSLETTER = { flags: ['subscribed', 'subscribe_error'], fallback: '/' };

// `used` is its own answer rather than a failure: the token was spent, and a
// buyer who reloads the link deserves to be told that rather than "error".
const REVIEW = { flags: { rated: 'rated=1', used: 'used=1', invalid: 'rated=0' }, fallback: '/reviews/' };

// a minted token is 32 random bytes written in hex, which is also everything the
// rating route will accept back
const TOKEN_SHAPE = /^[0-9a-f]{64}$/;
const RATING_SHAPE = /^[1-5]$/;

// the invite goes out a day after the order, in seconds. It is the only email
// this feature sends: there is no reminder pass, so a buyer who ignores it is
// never chased again.
const INVITE_DELAY = 86400;

// how many emails one hourly tick will send. A backlog drains over a few ticks
// rather than walking past Resend's 100-a-day ceiling in one.
const EMAIL_BATCH = 25;

// the aggregate is published at four decimal places: the star fill uses that
// value while the caption rounds it to one, and this is the precision the
// page's script writes into data-ibl-average
const RATING_PRECISION = 10000;
const RATINGS_CACHE = 'public, max-age=300, s-maxage=600';

// a resolved config.json is held for a day, so a day's orders cost one request
// rather than one each
const CONFIG_TTL = 86400;

export default {
  async fetch(request, env) {
    const { pathname } = new URL(request.url);

    if (pathname === '/polar') return handlePolar(request, env);
    if (pathname === '/subscribe') return handleSubscribe(request, env);
    if (pathname === '/reviews') return handleReview(request, env);
    if (pathname === '/api/ratings') return handleRatings(request, env);

    return handleContact(request, env); // the root path stays the contact form
  },

  // the hourly tick from [triggers] in wrangler.toml
  async scheduled(controller, env) {
    await sendRatingEmails(env);
  },
};

// the origin allowlist the browser-facing routes share. A preflight is answered
// before anything else so it is never a hard error, then the method, then the
// origin itself — the order the contact handler already used. The allowlist is
// a CORS/bot filter and not authentication — a non-browser client sets its own
// Origin header — so the Turnstile token is what actually gates these routes,
// and the logic below stays as it is.
function gate(request, env) {
  const origin = request.headers.get('Origin') || '';
  const allowedOrigins = (env.ALLOWED_ORIGINS || '').split(',').map((value) => value.trim()).filter(Boolean);
  const allowOrigin = allowedOrigins.indexOf(origin) !== -1 ? origin : '';

  if (request.method === 'OPTIONS') {
    return { allowOrigin, response: new Response(null, { status: 204, headers: corsHeaders(allowOrigin) }) };
  }

  if (request.method !== 'POST') {
    return { allowOrigin, response: new Response('Method not allowed', { status: 405, headers: corsHeaders(allowOrigin) }) };
  }

  if (!allowOrigin) {
    return { allowOrigin, response: new Response('Origin not allowed', { status: 403, headers: corsHeaders('') }) };
  }

  return { allowOrigin, response: null };
}

// the Turnstile token is required on both browser-facing routes: an absent or
// invalid one is a rejection. Turnstile cannot run without javascript, so the
// allowlist and the honeypot are secondary controls — a submission with no
// token is refused rather than waved through.
async function turnstileGate(form, request, env) {
  const token = field(form, 'cf-turnstile-response');

  if (!token) return false;

  return turnstileOk(token, request, env);
}

// the per-IP ceiling on the two public routes: Turnstile stops a script, and this
// bounds a script that solves Turnstile and then loops. A missing binding — a
// local dev run, say — allows the request, because the token gate is the real
// control and this one only protects the sending quota.
async function withinRateLimit(env, request) {
  if (!env.RATE_LIMITER) return true;

  try {
    const { success } = await env.RATE_LIMITER.limit({ key: request.headers.get('CF-Connecting-IP') || 'unknown' });

    return success === true;
  } catch (error) {
    console.error(`ratelimit: ${error}`);
    return true;
  }
}

async function handleContact(request, env) {
  const { allowOrigin, response } = gate(request, env);
  if (response) return response;

  if (!(await withinRateLimit(env, request))) {
    return respond(request, allowOrigin, false, 429, CONTACT);
  }

  const form = await request.formData();

  if (field(form, '_honey')) {
    return respond(request, allowOrigin, true, 200, CONTACT); // decoy: never tell a bot it was caught
  }

  // the token is required rather than optional, so a request carrying none — a
  // script, or a browser with javascript off — is refused here
  if (!(await turnstileGate(form, request, env))) {
    return respond(request, allowOrigin, false, 400, CONTACT);
  }

  const name = `${field(form, 'firstName')} ${field(form, 'lastName')}`.trim();
  const email = field(form, 'email');
  const message = field(form, 'message');

  if (!EMAIL_SHAPE.test(email) || !message) {
    return respond(request, allowOrigin, false, 400, CONTACT);
  }

  const sent = await fetch(RESEND_ENDPOINT, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      from: env.FROM_EMAIL,
      to: [env.TO_EMAIL],
      reply_to: email,
      subject: `Contact form — ${name}`,
      text: plainBody(name, email, message),
      html: htmlBody(name, email, message),
    }),
  });

  if (!sent.ok) {
    console.error(`resend rejected the message: ${sent.status}`);
    return respond(request, allowOrigin, false, 502, CONTACT);
  }

  return respond(request, allowOrigin, true, 200, CONTACT);
}

async function handleSubscribe(request, env) {
  const { allowOrigin, response } = gate(request, env);
  if (response) return response;

  if (!(await withinRateLimit(env, request))) {
    return respond(request, allowOrigin, false, 429, NEWSLETTER);
  }

  const form = await request.formData();

  if (field(form, '_honey')) {
    return respond(request, allowOrigin, true, 200, NEWSLETTER); // the same decoy as the contact form
  }

  // the same mandatory token as the contact route
  if (!(await turnstileGate(form, request, env))) {
    return respond(request, allowOrigin, false, 400, NEWSLETTER);
  }

  const email = field(form, 'email');
  if (!EMAIL_SHAPE.test(email)) {
    return respond(request, allowOrigin, false, 400, NEWSLETTER);
  }

  const saved = await upsertContact(env, {
    email,
    firstName: field(form, 'firstName'),
    source: 'footer-form',
    products: [],
  });

  if (!saved) return respond(request, allowOrigin, false, 502, NEWSLETTER);

  return respond(request, allowOrigin, true, 200, NEWSLETTER);
}

async function handlePolar(request, env) {
  // Polar's own servers call this, so there is no Origin header and no CORS to answer
  if (request.method !== 'POST') {
    return new Response('Method not allowed', { status: 405 });
  }

  // the raw text, not json(): the signature is over the exact bytes sent
  const raw = await request.text();

  if (!(await signatureOk(request, raw, env))) {
    return new Response('Invalid signature', { status: 401 });
  }

  let event;
  try {
    event = JSON.parse(raw); // only parsed once the signature has passed
  } catch {
    return new Response('Invalid payload', { status: 400 });
  }

  const order = event.data || {};

  // a refunded order carries status "refunded", so that event is routed before
  // the paid-only guard below rather than being swallowed by it
  if (event.type === 'order.refunded') return revokeRating(env, order);

  // order.paid always carries status "paid", so this only bites if the endpoint
  // is also subscribed to order.created as the documented $0-order fallback —
  // an unpaid order that ticked the box must not join the list
  if (order.status && order.status !== 'paid') {
    return new Response(null, { status: 200 });
  }

  const customer = order.customer || {};
  const email = (customer.email || '').trim();

  // the rating invite is minted for every paid order whether or not the
  // newsletter box was ticked, so it happens before the early exit below.
  // A failed write answers 500 so Polar retries: the invite, not the email, is
  // the one thing an order can never come back for once it is lost.
  if (!(await mintInvite(env, order, email))) {
    return new Response('Rating invite write failed', { status: 500 });
  }

  // most orders take this path: a 2xx is what stops Polar retrying
  if ((order.custom_field_data || {}).newsletter_optin !== true) {
    return new Response(null, { status: 200 });
  }

  if (!EMAIL_SHAPE.test(email)) {
    console.error(`polar: order ${order.id} opted in but carries no usable email`);
    return new Response(null, { status: 200 });
  }

  const saved = await upsertContact(env, {
    email,
    firstName: firstNameOf(customer.name),
    source: 'polar-checkout',
    products: productNames(order),
  });

  // 500 rather than a silent success: a failed write has to come back as a retry,
  // and the upsert is idempotent, so the retry cannot double up
  if (!saved) return new Response('Contact write failed', { status: 500 });

  return new Response(null, { status: 200 });
}

// POST /reviews — one rating for one invite token. The token is the gate and the
// order is what minted it, so there is no Turnstile here and no captcha to solve.
async function handleReview(request, env) {
  const { allowOrigin, response } = gate(request, env);
  if (response) return response;

  const form = await request.formData();
  const token = field(form, 'token');
  const rating = field(form, 'rating');

  // both shapes are checked before the database is touched: a real token is
  // hex and a rating is a single digit, so nothing else is worth a query
  if (!TOKEN_SHAPE.test(token) || !RATING_SHAPE.test(rating)) {
    return reviewAnswer(request, allowOrigin, token, 'invalid');
  }

  let invite;
  try {
    invite = await env.DB.prepare('SELECT email, slug, order_id, used_at FROM review_invites WHERE token = ?').bind(token).first();
  } catch (error) {
    console.error(`reviews: invite read failed: ${error}`);
    return reviewAnswer(request, allowOrigin, token, 'invalid');
  }

  if (!invite) return reviewAnswer(request, allowOrigin, token, 'invalid');
  if (invite.used_at) return reviewAnswer(request, allowOrigin, token, 'used');

  const now = nowSeconds();
  let state = 'rated';

  try {
    await env.DB.prepare('INSERT INTO reviews (slug, rating, email, order_id, created_at) VALUES (?, ?, ?, ?, ?)')
      .bind(invite.slug, Number(rating), invite.email, invite.order_id, now)
      .run();
  } catch (error) {
    // the unique index is the anti-stacking rule rather than a fault: the same
    // buyer rating the same product twice lands here, and answers like a spent
    // token rather than an error they could do something about
    if (uniqueViolation(error)) {
      state = 'used';
    } else {
      console.error(`reviews: insert failed: ${error}`);
      state = 'invalid';
    }
  }

  if (state !== 'invalid') await spendToken(env, token, now);

  return reviewAnswer(request, allowOrigin, token, state);
}

// GET /api/ratings — every slug with at least one live rating, which the product
// page fetches and blends with the baseline in the browser. A retired rating (a
// refund) stops counting from here rather than being deleted.
//
// The figure is public and read-only, so the CORS answer is a wildcard: no
// Vary: Origin, and the edge cache keeps serving one shared copy instead of one
// per origin. There is deliberately no RATE_LIMITER here — five requests a
// minute would trip a visitor browsing a few product pages — which is worth
// revisiting if the endpoint is ever hammered.
async function handleRatings(request, env) {
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    return new Response('Method not allowed', { status: 405 });
  }

  let rows;
  try {
    const result = await env.DB.prepare('SELECT slug, COUNT(*) AS count, AVG(rating) AS average FROM reviews WHERE revoked_at IS NULL GROUP BY slug').all();
    rows = result.results || [];
  } catch (error) {
    console.error(`ratings: aggregate read failed: ${error}`);
    return new Response('Ratings unavailable', { status: 503, headers: { 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'no-store' } });
  }

  const product = {};

  for (const row of rows) {
    product[row.slug] = { count: row.count, average: roundTo(row.average, RATING_PRECISION) };
  }

  const generatedAt = new Date().toISOString().slice(0, 19) + 'Z'; // seconds are enough for a timestamp nobody parses

  return new Response(JSON.stringify({ generated_at: generatedAt, product }), {
    status: 200,
    headers: { 'Access-Control-Allow-Origin': '*', 'Cache-Control': RATINGS_CACHE, 'Content-Type': 'application/json; charset=utf-8' },
  });
}

// mints the single-use invite for a paid order. The order id is the primary key,
// so a webhook Polar retries cannot mint a second one, and the token is the only
// way to reach the rating form. Answers false only when the write failed: an
// order carrying no usable email, or no product we can key a rating to, is a
// deliberate no-op that answers true.
async function mintInvite(env, order, email) {
  const address = normaliseEmail(email);

  if (!EMAIL_SHAPE.test(address)) return true;

  const lookup = await configLookup(env);

  // a lookup that failed is worth a retry rather than an order that quietly
  // never receives its invite
  if (!lookup) return false;

  const item = ratingKeyFor(lookup, orderProductIds(order));
  if (!item) return true;

  try {
    await env.DB.prepare('INSERT INTO review_invites (order_id, email, product_id, slug, token, created_at) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(order_id) DO NOTHING')
      .bind(order.id, address, item.productId, item.slug, randomToken(), nowSeconds())
      .run();
  } catch (error) {
    console.error(`polar: rating invite for order ${order.id} failed: ${error}`);
    return false;
  }

  return true;
}

// order.refunded — a refunded buyer is no longer a buyer, so the rating they
// posted retires and stops counting everywhere. Idempotent, and an order whose
// rating was never posted has nothing to revoke.
async function revokeRating(env, order) {
  const address = normaliseEmail((order.customer || {}).email || '');

  if (!EMAIL_SHAPE.test(address)) return new Response(null, { status: 200 });

  const lookup = await configLookup(env);
  if (!lookup) return new Response('Config lookup failed', { status: 500 });

  const item = ratingKeyFor(lookup, orderProductIds(order));
  if (!item) return new Response(null, { status: 200 });

  try {
    await env.DB.prepare('UPDATE reviews SET revoked_at = ? WHERE email = ? AND slug = ? AND revoked_at IS NULL')
      .bind(nowSeconds(), address, item.slug)
      .run();
  } catch (error) {
    console.error(`polar: revoking order ${order.id}'s rating failed: ${error}`);
    return new Response('Revoke failed', { status: 500 });
  }

  return new Response(null, { status: 200 });
}

// resolves a Polar product id to a rating key and a display name, from the
// published config.json. Memoised in KV for a day, so a day's orders cost one
// request rather than one each; null means the lookup itself failed, which the
// caller treats as worth retrying rather than as a product with no rating key.
async function configLookup(env) {
  const url = `${env.SITE_URL}/config.json`;

  try {
    if (env.CONFIG) {
      const cached = await env.CONFIG.get(url, 'json');
      if (cached) return cached;
    }

    const response = await fetch(url);
    if (!response.ok) throw new Error(`config.json returned ${response.status}`);

    const config = await response.json();
    const lookup = { keys: {}, names: {} };

    for (const item of config.items || []) {
      const productId = String(item.product_id || '').trim();
      if (!productId) continue;

      // ratings_key exists for a page that covers more than one Polar product —
      // Muzzle's two tiers — where the item's own slug would key two rows for
      // what is one product
      lookup.keys[productId] = String(item.ratings_key || item.slug || '').trim();
      lookup.names[productId] = String(item.name || '').trim();
    }

    if (env.CONFIG) await env.CONFIG.put(url, JSON.stringify(lookup), { expirationTtl: CONFIG_TTL });

    return lookup;
  } catch (error) {
    console.error(`ratings: config.json lookup failed: ${error}`);
    return null;
  }
}

// the Polar product ids on an order, in payload order. Polar's order shape
// carries either a flat product or an items list.
function orderProductIds(order) {
  const ids = [];
  const add = (product) => {
    const id = String((product && product.id) || '').trim();
    if (id && ids.indexOf(id) === -1) ids.push(id);
  };

  add(order.product);

  for (const item of order.items || []) add(item.product);

  return ids;
}

// the first product on the order that resolves to a rating key. One invite per
// order means one product, and the order's own product is both first and the one
// that was actually bought.
function ratingKeyFor(lookup, productIds) {
  for (const productId of productIds) {
    const slug = lookup.keys[productId];

    if (slug) return { productId, slug };
  }

  return null;
}

// the one cron pass: the invite, a day after the order. A failed send leaves
// sent_at alone deliberately, so the next hourly tick retries it.
async function sendRatingEmails(env) {
  const now = nowSeconds();
  const sql = 'SELECT token, email, slug, product_id FROM review_invites WHERE sent_at IS NULL AND created_at <= ? ORDER BY created_at LIMIT ?';

  const due = await env.DB.prepare(sql).bind(now - INVITE_DELAY, EMAIL_BATCH).all();
  const rows = due.results || [];
  const lookup = await configLookup(env);
  const names = (lookup && lookup.names) || {};
  const sent = [];

  for (const invite of rows) {
    const name = names[invite.product_id] || humanise(invite.slug);

    if (await sendRatingEmail(env, invite, name)) sent.push(invite.token);
  }

  for (const token of sent) {
    await env.DB.prepare('UPDATE review_invites SET sent_at = ? WHERE token = ?').bind(now, token).run();
  }
}

async function sendRatingEmail(env, invite, name) {
  const link = `${env.SITE_URL}/reviews/?t=${invite.token}`;
  const mail = ratingEmail(name, link);

  try {
    const sent = await fetch(RESEND_ENDPOINT, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from: env.RATING_FROM_EMAIL,
        to: [invite.email],
        subject: mail.subject,
        text: mail.text,
        html: mail.html,
      }),
    });

    if (!sent.ok) {
      console.error(`ratings: the invite for ${invite.slug} returned ${sent.status} ${(await sent.text()).slice(0, 200)}`);
      return false;
    }
  } catch (error) {
    console.error(`ratings: the invite for ${invite.slug} failed: ${error}`);
    return false;
  }

  return true;
}

// the one email. It reads as transactional because it is: what was bought, one
// link, and nothing promotional, tracked or recurring — which is also why it
// carries no unsubscribe.
function ratingEmail(name, link) {
  const safeName = escapeHtml(name);
  const href = escapeHtml(link);

  return {
    subject: `How's ${name} treating you?`,
    text: `Thanks for picking up ${name}.\n\nIf you've had a chance to give it a spin, I'd like to know what you think of it.\n\nRate ${name}: ${link}\n\nCheers!\niamlamprey`,
    html: `<p>Thanks for picking up <strong>${safeName}</strong>.</p><p>If you've had a chance to give it a spin, I'd like to know what you think of it.</p><p><a href="${href}">Rate ${safeName}</a></p><p>Cheers!<br>iamlamprey</p>`,
  };
}

// the answer /reviews/ is built around: a 303 back to the page with the token
// still in the query string and one flag, so finishing a rating needs no
// javascript. The token rides back only when it was a real one, so a bad link
// cannot be re-posted by reloading the page it landed on.
function reviewAnswer(request, allowOrigin, token, state) {
  const headers = corsHeaders(allowOrigin);
  const ok = state === 'rated';

  if ((request.headers.get('Accept') || '').indexOf('application/json') !== -1) {
    headers['Content-Type'] = 'application/json; charset=utf-8';

    return new Response(JSON.stringify({ ok, state }), { status: ok ? 200 : 400, headers });
  }

  const flag = REVIEW.flags[state];
  headers['Location'] = `${returnBase(request, allowOrigin, REVIEW.fallback)}${TOKEN_SHAPE.test(token) ? `?t=${token}&${flag}` : `?${flag}`}`;

  return new Response(null, { status: 303, headers });
}

// the rating lands first and the token is spent second, so a crash between the
// two cannot lose a rating — the unique index is what stops it being posted
// twice, and a token that was never spent simply answers `used` on the retry.
async function spendToken(env, token, now) {
  try {
    await env.DB.prepare('UPDATE review_invites SET used_at = ? WHERE token = ?').bind(now, token).run();
  } catch (error) {
    console.error(`reviews: could not spend a token: ${error}`);
  }
}

// Standard Webhooks verification. The signed content is id.timestamp.body, the
// secret is base64 behind a whsec_ prefix, and the signature header carries one
// or more space-separated v1,<base64> entries. Polar reads: secrets generated on
// or after 8 September 2026 follow Standard Webhooks, older ones use Polar HMAC.
async function signatureOk(request, raw, env) {
  const id = request.headers.get('webhook-id') || '';
  const timestamp = request.headers.get('webhook-timestamp') || '';
  const signature = request.headers.get('webhook-signature') || '';
  const secret = env.POLAR_WEBHOOK_SECRET || '';

  if (!id || !timestamp || !signature || !secret) return false;

  const age = Math.floor(Date.now() / 1000) - Number(timestamp);
  if (!Number.isFinite(age) || Math.abs(age) > WEBHOOK_TOLERANCE) return false; // a stale signature is a replay

  const keyBytes = base64Bytes(secret.replace(/^whsec_/, ''));
  if (!keyBytes) return false;

  const key = await crypto.subtle.importKey('raw', keyBytes, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const signed = new TextEncoder().encode(`${id}.${timestamp}.${raw}`);
  const expected = new Uint8Array(await crypto.subtle.sign('HMAC', key, signed));

  for (const entry of signature.split(' ')) {
    const [version, value] = entry.split(',');
    const candidate = version === 'v1' && value ? base64Bytes(value) : null;

    if (candidate && sameBytes(expected, candidate)) return true;
  }

  return false;
}

// creates the contact, or merges into it when the address is already on the list
async function upsertContact(env, contact) {
  const key = env.RESEND_CONTACTS_KEY;

  if (!key) {
    console.error('resend: RESEND_CONTACTS_KEY is not set');
    return false;
  }

  const listUrl = `${RESEND_API}/contacts`; // contacts are global — an audience id no longer exists
  const headers = { 'Authorization': `Bearer ${key}`, 'Content-Type': 'application/json' };
  const consentAt = new Date().toISOString();
  const properties = { source: contact.source, consent_at: consentAt };

  if (contact.products.length) properties.products = contact.products.join(', ');

  const payload = {
    email: contact.email,
    first_name: contact.firstName || undefined,
    unsubscribed: false,
    properties,
    topics: [{ id: env.RESEND_TOPIC_ID, subscription: 'opt_in' }],
  };

  // the segment is optional: it stays empty until one is created in the dashboard
  if (env.RESEND_SEGMENT_ID) payload.segments = [{ id: env.RESEND_SEGMENT_ID }];

  const created = await fetch(listUrl, {
    method: 'POST',
    headers,
    body: JSON.stringify(payload),
  });

  if (created.ok) return true;

  // Resend has no upsert, so a duplicate address comes back as a failure. Read
  // what is already there and update it instead — that is also what accumulates
  // the product names across repeat purchases.
  console.error(`resend: contact create returned ${created.status}, falling back to an update`);

  const existing = await existingProducts(listUrl, contact.email, headers);
  if (existing === null) return false;

  const products = mergeProducts(existing, contact.products);

  const updated = await fetch(`${listUrl}/${encodeURIComponent(contact.email)}`, {
    method: 'PATCH',
    headers,
    body: JSON.stringify({
      first_name: contact.firstName || undefined,
      unsubscribed: false,
      properties: { source: contact.source, consent_at: consentAt, products },
    }),
  });

  if (!updated.ok) {
    console.error(`resend: contact update returned ${updated.status} ${(await updated.text()).slice(0, 200)}`);
    return false;
  }

  return true;
}

// the products string an existing contact carries, or null if it could not be read
async function existingProducts(listUrl, email, headers) {
  const response = await fetch(`${listUrl}/${encodeURIComponent(email)}`, { headers });

  if (!response.ok) {
    console.error(`resend: contact read returned ${response.status} ${(await response.text()).slice(0, 200)}`);
    return null;
  }

  const data = await response.json();
  const properties = data.properties || (data.contact && data.contact.properties) || {};
  const property = properties.products;

  // a write takes the flat value but a read nests it as { value, type }; the plain
  // string is tolerated in case that shape changes
  const value = property && typeof property === 'object' ? property.value : property;

  return value || '';
}

// unique product names, carrying forward whatever the contact already had
function mergeProducts(existing, incoming) {
  const previous = Array.isArray(existing) ? existing : String(existing || '').split(',');
  const names = [];

  for (const value of previous.concat(incoming)) {
    const name = String(value || '').trim();

    if (name && names.indexOf(name) === -1) names.push(name);
  }

  return names.join(', ');
}

// the product name(s) on the order, read from the payload rather than config.json
// — the Worker cannot see the repo, and a deployed service should not depend on
// a checkout. Polar's order shape carries either a flat product or an items list.
function productNames(order) {
  const names = [];
  const add = (name) => {
    const value = String(name || '').trim();

    if (value && names.indexOf(value) === -1) names.push(value);
  };

  add(order.product && order.product.name);

  for (const item of order.items || []) {
    add(item.product && item.product.name);
  }

  return names;
}

// "blackout-2" -> "Blackout 2", for the rare order whose product name could not
// be resolved from config.json
function humanise(slug) {
  return String(slug || '').split('-').map((part) => part.charAt(0).toUpperCase() + part.slice(1)).join(' ');
}

// "Ada Lovelace" -> "Ada": Resend's first_name wants the given name only
function firstNameOf(name) {
  return String(name || '').trim().split(/\s+/)[0] || '';
}

// the address the invite and the rating are keyed by: one spelling, so the same
// buyer cannot stack two ratings with a shifted capital
function normaliseEmail(value) {
  return String(value || '').trim().toLowerCase();
}

// 32 bytes of CSPRNG in hex. The token is the whole gate on /reviews/, so it has
// to be unguessable rather than merely unique.
function randomToken() {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);

  let token = '';
  for (const byte of bytes) token += byte.toString(16).padStart(2, '0');

  return token;
}

function nowSeconds() {
  return Math.floor(Date.now() / 1000);
}

function roundTo(value, precision) {
  return Math.round(Number(value) * precision) / precision;
}

// D1 reports the unique index as a constraint failure on the insert, which is
// the anti-stacking rule doing its job rather than an error worth retrying
function uniqueViolation(error) {
  return String((error && error.message) || '').indexOf('UNIQUE constraint failed') !== -1;
}

function base64Bytes(value) {
  try {
    const binary = atob(value);
    const bytes = new Uint8Array(binary.length);

    for (let index = 0; index < binary.length; index++) {
      bytes[index] = binary.charCodeAt(index);
    }

    return bytes;
  } catch {
    return null; // not base64, so it cannot be a signature that matches
  }
}

// constant-time compare, so a wrong guess cannot be timed against the real one
function sameBytes(left, right) {
  if (left.length !== right.length) return false;

  let difference = 0;
  for (let index = 0; index < left.length; index++) {
    difference |= left[index] ^ right[index];
  }

  return difference === 0;
}

// answers the js path with json and the no-js path with a 303 back to the page
function respond(request, allowOrigin, ok, status, route) {
  const headers = corsHeaders(allowOrigin);

  if ((request.headers.get('Accept') || '').indexOf('application/json') !== -1) {
    headers['Content-Type'] = 'application/json; charset=utf-8';
    return new Response(JSON.stringify({ ok }), { status, headers });
  }

  const flag = route.flags[ok ? 0 : 1];
  headers['Location'] = `${returnBase(request, allowOrigin, route.fallback)}?${flag}=1`;

  return new Response(null, { status: 303, headers });
}

// the page the visitor came from: the newsletter form sits in the footer of every
// page, so the round trip has to land back on that page rather than on one fixed
// path, and a project-page baseurl survives because the path is used verbatim
function returnBase(request, allowOrigin, fallback) {
  try {
    const referer = new URL(request.headers.get('Referer') || '');

    if (referer.origin === allowOrigin) {
      return `${referer.origin}${referer.pathname}`;
    }
  } catch {
    // a missing or unparseable referer — fall through to the handler's own page
  }

  return `${allowOrigin}${fallback}`;
}

function corsHeaders(allowOrigin) {
  const headers = { 'Vary': 'Origin' };

  if (allowOrigin) {
    headers['Access-Control-Allow-Origin'] = allowOrigin;
    headers['Access-Control-Allow-Methods'] = 'POST, OPTIONS';
    headers['Access-Control-Allow-Headers'] = 'Content-Type, Accept';
    headers['Access-Control-Max-Age'] = '86400';
  }

  return headers;
}

async function turnstileOk(token, request, env) {
  const verify = await fetch(TURNSTILE_VERIFY, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      secret: env.TURNSTILE_SECRET,
      response: token,
      remoteip: request.headers.get('CF-Connecting-IP') || '',
    }),
  });

  const result = await verify.json();

  return result.success === true;
}

function field(form, name) {
  const value = form.get(name);

  return typeof value === 'string' ? value.trim() : '';
}

function plainBody(name, email, message) {
  return [
    'New message from the iamlamprey contact form.',
    '',
    `Name:  ${name}`,
    `Email: ${email}`,
    '',
    message,
  ].join('\n');
}

function htmlBody(name, email, message) {
  const lines = escapeHtml(message).split('\n').join('<br>');

  return `<p><strong>Name:</strong> ${escapeHtml(name)}<br><strong>Email:</strong> ${escapeHtml(email)}</p><p>${lines}</p>`;
}

function escapeHtml(value) {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
