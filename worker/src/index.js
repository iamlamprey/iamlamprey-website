/*!
 * iamLamprey contact relay + mailing list + ratings — worker/src/index.js
 *
 * Six routes and one cron on one Worker, all on free tiers (the Workers
 * runtime, Turnstile, D1, KV and Resend's 3,000 emails a month):
 *
 *   /            the /contact/ form: check the origin, drop bots, verify a
 *                Turnstile token (mandatory), then hand the message to Resend.
 *                It stays the default route, so contact_endpoint in _config.yml
 *                needs no change.
 *   /subscribe   the site-wide newsletter form: the same origin/honeypot/mandatory
 *                Turnstile shape, but it emails the address a confirmation link
 *                rather than writing it to the list.
 *   /confirm     the link in that email: verifies the signed, self-expiring token
 *                and only then writes the contact. A click from an inbox, so there
 *                is no Origin header to allow and no Turnstile to solve.
 *   /polar       Polar's order webhook: verify the Standard Webhooks signature,
 *                add the buyer to that same list when the checkout's opt-in
 *                checkbox was ticked, mint the single-use rating invite from the
 *                order itself, and retire a rating when that order is refunded.
 *   /reviews     the form behind /reviews/: one rating, for one invite token.
 *   /api/ratings the live aggregates, read by the product page at load, and
 *                blended in the browser with the baseline.
 *   /purchase    the valued Purchase for a completed checkout: the browser pixel
 *                cannot see Polar's checkout, so /thanks/ posts the checkout id
 *                here, this looks the order up through Polar's orders API and
 *                sends the server-side event with the order id as the event_id
 *                both halves carry.
 *
 * The cron in wrangler.toml's [triggers] sends the invite a day after the order,
 * so a rating posted thirty seconds after checkout never reaches the figures —
 * one email, one rating, and nothing to unsubscribe from.
 *
 * Only upsertContact() knows the list provider is Resend, so swapping it for Kit
 * or MailerLite later is one function. Secrets (RESEND_API_KEY,
 * RESEND_CONTACTS_KEY, TURNSTILE_SECRET, POLAR_WEBHOOK_SECRET,
 * SUBSCRIBE_SECRET, META_CAPI_TOKEN, POLAR_ORDERS_TOKEN) are Worker secrets set
 * in the Cloudflare dashboard; the topic and segment ids and the rest are in
 * wrangler.toml's [vars] block.
 */

const TURNSTILE_VERIFY = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';
const GRAPH_API = 'https://graph.facebook.com/v26.0';
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
// success now means the confirmation email is on its way rather than that the
// address is on the list: the write happens on /confirm, once the link in that
// email has been clicked. The flag pair is unchanged, so one line still answers
// both directions of the round trip.
const NEWSLETTER = { flags: ['subscribed', 'subscribe_error'], fallback: '/' };

// the confirmation link is signed and self-expiring, so nothing is stored: 30
// minutes is tight enough to blunt a mailed link being passed around and long
// enough to survive delivery lag. The window is read at click time rather than
// baked into the link, so changing it invalidates nothing already out there,
// though shortening it can expire a link that is still in flight.
const CONFIRM_TTL = 1800;

// the three answers /subscribed/ prints. A token that does not verify is answered
// `expired` rather than told apart from a stale one: the visitor can do the same
// thing about either, and the distinction would only help whoever forged it.
const CONFIRM = { flags: { confirmed: 'confirmed', expired: 'expired', confirm_error: 'confirm_error' }, fallback: '/subscribed/' };

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

// Polar's orders API, on the same pinned version every scripts/ client sends. A
// request that sends none follows Polar's Current version, which changes each
// quarter — the reasoning and the pin's deadline are in the README.
const POLAR_ORDERS = 'https://api.polar.sh/v1/orders/';
const POLAR_VERSION = '2026-04';

// total_amount comes back in integer cents; Meta wants the figure in currency
// units, which is the division this route applies once
const CENTS_PER_UNIT = 100;

// the redirect back from Polar's checkout and the order it just created are not
// perfectly ordered, so the first lookup can come back empty. Three attempts
// cover that gap, which is also why the page has no retry loop of its own.
const ORDER_ATTEMPTS = 3;
const ORDER_RETRY_MS = 500;

// a Polar checkout id is a uuid4, which is what {CHECKOUT_ID} substitutes into
// the Success URL. Anything else is not worth a Polar request.
const CHECKOUT_ID_SHAPE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// the two cookies the page forwards, as Meta writes them: fb.<subdomain>.<created
// at>.<value>. A request carrying anything else has it dropped rather than passed
// on, because these end up in user_data.
const MATCH_COOKIE_SHAPE = /^fb\.\d+\.\d+\.\S{1,400}$/;

export default {
  async fetch(request, env) {
    const { pathname } = new URL(request.url);

    if (pathname === '/polar') return handlePolar(request, env);
    if (pathname === '/subscribe') return handleSubscribe(request, env);
    if (pathname === '/confirm') return handleConfirm(request, env);
    if (pathname === '/reviews') return handleReview(request, env);
    if (pathname === '/api/ratings') return handleRatings(request, env);
    if (pathname === '/purchase') return handlePurchase(request, env);

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

  // the origin the form posted to rather than env.SITE_URL: /confirm is a route
  // on this Worker, while env.SITE_URL is the static site, which has none
  const origin = new URL(request.url).origin;
  const link = await confirmationLink(env, email, origin);

  if (!link) return respond(request, allowOrigin, false, 500, NEWSLETTER);
  if (!(await sendConfirmationEmail(env, email, link))) return respond(request, allowOrigin, false, 502, NEWSLETTER);

  return respond(request, allowOrigin, true, 200, NEWSLETTER);
}

// GET /confirm: the link in the confirmation email. A click from an inbox, so
// it is deliberately not behind gate() — there is no Origin header to allow and
// no browser of ours to answer — and the signed token is the whole gate. Every
// answer is a 303 onto the static site, because the visitor arrived from an
// email rather than from a page that could show them a result inline.
async function handleConfirm(request, env) {
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    return new Response('Method not allowed', { status: 405 });
  }

  const url = new URL(request.url);
  const email = url.searchParams.get('e') || '';
  const token = url.searchParams.get('t') || '';
  const separator = token.indexOf('.');
  const issued = separator === -1 ? '' : token.slice(0, separator);
  const signature = separator === -1 ? '' : token.slice(separator + 1);
  const given = hexBytes(signature);

  // an unset secret can verify nothing, and the address, the issue time and the
  // signature are all checked before the list is touched
  if (!env.SUBSCRIBE_SECRET || !EMAIL_SHAPE.test(email) || !/^\d+$/.test(issued) || !given) {
    return confirmAnswer(env, 'expired');
  }

  const expected = hexBytes(await sign(env.SUBSCRIBE_SECRET, `subscribe.${email}.${issued}`));

  if (!expected || !sameBytes(expected, given)) return confirmAnswer(env, 'expired');

  const age = nowSeconds() - Number(issued);

  // a timestamp from the future is as wrong as a stale one, and both are answered
  // the same way: click the link in a fresh email
  if (age < 0 || age > CONFIRM_TTL) return confirmAnswer(env, 'expired');

  // the token is not single-use, so the same link can be clicked again and again:
  // the ceiling that bounds a script on /subscribe bounds a loop here too, because
  // every success is a write to Resend rather than an email
  if (!(await withinRateLimit(env, request))) return confirmAnswer(env, 'confirm_error');

  const saved = await upsertContact(env, {
    email: normaliseEmail(email),
    firstName: '',
    source: 'footer-form',
    products: [],
  });

  return confirmAnswer(env, saved ? 'confirmed' : 'confirm_error');
}

// the answer to a click from an email: a 303 onto the static site, which is the
// only page with anything to say about it. No json branch and no referer
// handling — the visitor did not arrive from a page of ours and has no form to
// return to, so /subscribed/ is the one place this can land.
function confirmAnswer(env, state) {
  const flag = CONFIRM.flags[state] || CONFIRM.flags.expired;

  return new Response(null, { status: 303, headers: { 'Location': `${env.SITE_URL}${CONFIRM.fallback}?${flag}=1` } });
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

// POST /purchase — the valued Purchase. Polar is the merchant of record, so the
// payment happens on buy.polar.sh and the browser pixel cannot see it: /thanks/
// posts the checkout id Polar substituted into the Success URL, this looks the
// order up through Polar's own API, and the event travels from here instead.
//
// Both copies carry the same event_name and the same event_id — the Polar order
// id — which is exactly how Meta deduplicates a redundant setup: one purchase
// counts once, and a browser with the pixel blocked still reports.
async function handlePurchase(request, env) {
  const { allowOrigin, response } = gate(request, env);
  if (response) return response;

  // the checkout id is an unguessable uuid, but the ceiling costs nothing
  if (!(await withinRateLimit(env, request))) {
    return purchaseJson(allowOrigin, 429, { ok: false, reason: 'rate_limited' });
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return purchaseJson(allowOrigin, 400, { ok: false, reason: 'bad_request' });
  }

  // the page only asks once consent has been granted, and says so in the body.
  // The Worker cannot verify the claim — it is not a token and not a signature —
  // but requiring it keeps the intent explicit here and means a stray or
  // hand-rolled request cannot quietly send a server event. A decline is
  // answered with nothing at all, which is the same answer for both halves.
  if (!body || body.consent !== true) {
    return new Response(null, { status: 204, headers: corsHeaders(allowOrigin) });
  }

  const checkoutId = String(body.checkout_id || '').trim();

  if (!CHECKOUT_ID_SHAPE.test(checkoutId)) {
    return purchaseJson(allowOrigin, 400, { ok: false, reason: 'bad_request' });
  }

  const found = await paidOrder(env, checkoutId);

  // a lookup that could not be completed is not an order that does not exist: the
  // page is told to leave this one reportable
  if (found.failed) return purchaseJson(allowOrigin, 502, { ok: false, reason: 'lookup_failed' });
  if (!found.order) return purchaseJson(allowOrigin, 200, { ok: false, reason: 'no_order' });

  const order = found.order;
  const value = Number(order.total_amount) / CENTS_PER_UNIT; // Polar reports integer cents
  const currency = String(order.currency || '').trim().toUpperCase(); // and lowercase codes

  // a free order is a real order — Songbird and the free Muzzle tier both land
  // here — and Meta has nothing to learn from a $0 Purchase
  if (!(value > 0)) return purchaseJson(allowOrigin, 200, { ok: false, reason: 'free_order' });

  if (!currency) {
    console.error(`purchase: order ${order.id} carries no currency`);
    return purchaseJson(allowOrigin, 502, { ok: false, reason: 'bad_order' });
  }

  // both cookies are read from an untrusted request and end up in user_data, so
  // anything that is not the shape Meta writes is dropped rather than passed on
  const fbp = MATCH_COOKIE_SHAPE.test(String(body.fbp || '')) ? String(body.fbp) : '';
  const fbc = MATCH_COOKIE_SHAPE.test(String(body.fbc || '')) ? String(body.fbc) : '';

  const event = { order, checkoutId, value, currency, contentIds: [orderContentId(order)], fbp, fbc };

  if (!(await sendPurchase(env, request, event))) {
    return purchaseJson(allowOrigin, 502, { ok: false, reason: 'capi_error' });
  }

  return purchaseJson(allowOrigin, 200, { ok: true, event_id: order.id, value, currency, content_ids: event.contentIds });
}

// the paid order behind a checkout id, or null when there is none yet. Polled
// briefly for the reason ORDER_ATTEMPTS gives; `failed` separates a lookup that
// could not be made at all from an order that does not exist, because only the
// first is worth retrying.
async function paidOrder(env, checkoutId) {
  const token = (env.POLAR_ORDERS_TOKEN || '').trim();

  if (!token) {
    console.error('purchase: POLAR_ORDERS_TOKEN is not set');
    return { failed: true };
  }

  const url = new URL(POLAR_ORDERS);
  url.searchParams.set('checkout_id', checkoutId);
  url.searchParams.set('limit', '10');

  // only needed when the token is not scoped to a single organisation: an
  // unscoped token's lookup answers 400 rather than a list of that org's orders
  if (env.POLAR_ORGANIZATION_ID) url.searchParams.set('organization_id', env.POLAR_ORGANIZATION_ID);

  for (let attempt = 0; attempt < ORDER_ATTEMPTS; attempt++) {
    if (attempt) await sleep(ORDER_RETRY_MS);

    let response;
    try {
      response = await fetch(url, {
        headers: { 'Authorization': `Bearer ${token}`, 'Polar-Version': POLAR_VERSION, 'Accept': 'application/json' },
      });
    } catch (error) {
      console.error(`purchase: the order lookup failed: ${error}`);
      return { failed: true };
    }

    if (!response.ok) {
      console.error(`purchase: the order lookup returned ${response.status}`); // never the body: it carries the order
      return { failed: true };
    }

    const data = await response.json();
    const paid = (data.items || []).filter((order) => order && order.status === 'paid');

    // a checkout can be attempted more than once, and the paid one is the order
    if (paid.length) return { order: newestOrder(paid) };

    // nothing paid yet: the redirect beats the order, so wait and ask again
  }

  return { order: null };
}

// the server half of the pair, and the half that survives an ad blocker. Only
// `em` is hashed, as lowercase-hex SHA-256 over the address lowercased and
// trimmed — hashing the ip, the user agent or the cookies is what Meta rejects —
// and a failed send is answered false so the route can tell the page to try
// again rather than count the order.
async function sendPurchase(env, request, event) {
  const pixelId = (env.META_PIXEL_ID || '').trim();
  const token = (env.META_CAPI_TOKEN || '').trim();

  if (!pixelId || !token) {
    console.error('purchase: META_PIXEL_ID or META_CAPI_TOKEN is not set');
    return false;
  }

  const userData = {};
  const ip = request.headers.get('CF-Connecting-IP') || '';
  const agent = request.headers.get('User-Agent') || '';
  const email = normaliseEmail((event.order.customer || {}).email || '');

  if (ip) userData.client_ip_address = ip;
  if (agent) userData.client_user_agent = agent;
  if (EMAIL_SHAPE.test(email)) userData.em = [await hashedEmail(email)];
  if (event.fbp) userData.fbp = event.fbp;
  if (event.fbc) userData.fbc = event.fbc;

  const payload = {
    data: [{
      event_name: 'Purchase',
      event_time: nowSeconds(),
      event_id: event.order.id, // the same id the page sends as its eventID
      event_source_url: `${env.SITE_URL}/thanks/?checkout_id=${encodeURIComponent(event.checkoutId)}`,
      action_source: 'website',
      user_data: userData,
      custom_data: {
        value: event.value,
        currency: event.currency,
        content_ids: event.contentIds,
        content_type: 'product',
        num_items: 1,
      },
    }],
  };

  // Meta only routes an event to the Test Events tab while this is set, which is
  // why it is empty in production rather than merely unused
  if (env.META_TEST_EVENT_CODE) payload.test_event_code = env.META_TEST_EVENT_CODE;

  const url = `${GRAPH_API}/${encodeURIComponent(pixelId)}/events?access_token=${encodeURIComponent(token)}`;

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });

    if (!response.ok) {
      console.error(`purchase: the conversions api returned ${response.status}`); // the status only: the body echoes the payload
      return false;
    }
  } catch (error) {
    console.error(`purchase: the conversions api failed: ${error}`);
    return false;
  }

  return true;
}

// the one field the Conversions API wants hashed: SHA-256 in lowercase hex, over
// the address lowercased and trimmed, which is the form normaliseEmail() already
// produces. The ip, the user agent and the two cookies travel as they are.
async function hashedEmail(email) {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(normaliseEmail(email))));

  let hash = '';
  for (const byte of digest) hash += byte.toString(16).padStart(2, '0');

  return hash;
}

// the newest order on a list, by created_at: one checkout can produce more than
// one order, and the one that matters is the latest that was paid
function newestOrder(orders) {
  let newest = orders[0];

  for (const order of orders) {
    if (String(order.created_at || '') > String(newest.created_at || '')) newest = order;
  }

  return newest;
}

// the product an order was for. The REST shape carries a flat product_id; the
// webhook shape nests it, so orderProductIds() covers that as a fallback, and an
// order that resolves to neither is still reported — content_ids is not required
// for a valued Purchase the way value and currency are.
function orderContentId(order) {
  const flat = String(order.product_id || '').trim();

  if (flat) return flat;

  const ids = orderProductIds(order);

  return ids.length ? ids[0] : '';
}

// the purchase route is json both ways — the page posts json and reads json — and
// the payload is per buyer, so it is never cached at the edge
function purchaseJson(allowOrigin, status, payload) {
  const headers = corsHeaders(allowOrigin);
  headers['Content-Type'] = 'application/json; charset=utf-8';
  headers['Cache-Control'] = 'no-store';

  return new Response(JSON.stringify(payload), { status, headers });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
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

// the second email. Transactional in the same way as the invite — one link and
// nothing promotional — which is also why it carries no unsubscribe: the address
// is not on the list yet, and ignoring the email is what cancels the signup.
function confirmationEmail(link) {
  const href = escapeHtml(link);

  return {
    subject: 'Confirm your subscription to iamlamprey',
    text: `Someone asked to join the iamlamprey mailing list with this address.\n\nConfirm your subscription: ${link}\n\nThe link expires in 30 minutes. If this wasn't you, ignore this email and nothing will be added to the list.`,
    html: `<p>Someone asked to join the <strong>iamlamprey</strong> mailing list with this address.</p><p><a href="${href}">Confirm your subscription</a></p><p>The link expires in 30 minutes. If this wasn't you, ignore this email and nothing will be added to the list.</p>`,
  };
}

async function sendConfirmationEmail(env, email, link) {
  const mail = confirmationEmail(link);

  try {
    const sent = await fetch(RESEND_ENDPOINT, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from: env.SUBSCRIBE_FROM_EMAIL,
        to: [email],
        subject: mail.subject,
        text: mail.text,
        html: mail.html,
      }),
    });

    if (!sent.ok) {
      // the address stays out of the log: it is the one piece of personal data in
      // the request, and the status is what says whether Resend took the send
      console.error(`subscribe: the confirmation email returned ${sent.status} ${(await sent.text()).slice(0, 200)}`);
      return false;
    }
  } catch (error) {
    console.error(`subscribe: the confirmation email failed: ${error}`);
    return false;
  }

  return true;
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

// HMAC-SHA256 in lowercase hex, the form randomToken() writes and the one a query
// string takes without escaping. The message is domain-separated by its caller so
// a signature minted for one purpose cannot be replayed as another.
async function sign(secret, message) {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const digest = new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(message)));

  let signature = '';
  for (const byte of digest) signature += byte.toString(16).padStart(2, '0');

  return signature;
}

// the mirror of base64Bytes(): null means "not a signature that could ever match",
// which the caller answers rather than comparing against
function hexBytes(value) {
  if (!/^([0-9a-f]{2})+$/.test(value)) return null;

  const bytes = new Uint8Array(value.length / 2);

  for (let index = 0; index < bytes.length; index++) {
    bytes[index] = parseInt(value.slice(index * 2, index * 2 + 2), 16);
  }

  return bytes;
}

// the confirmation link, signed rather than stored: the signature covers the
// address and the issue time, so /confirm checks both without a table to write,
// read or clean up after. A missing secret is not a link signed with the string
// "undefined" — it is no link at all, which the caller answers 500 to.
async function confirmationLink(env, email, origin) {
  const secret = env.SUBSCRIBE_SECRET;

  if (!secret) {
    console.error('subscribe: SUBSCRIBE_SECRET is not set, so no confirmation link can be signed');
    return null;
  }

  const issued = nowSeconds();
  const signature = await sign(secret, `subscribe.${email}.${issued}`);

  return `${origin}/confirm?e=${encodeURIComponent(email)}&t=${issued}.${signature}`;
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
