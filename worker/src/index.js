/*!
 * iamLamprey contact relay — worker/src/index.js
 *
 * A thin proxy for the /contact/ form: check the origin, drop bots, verify a
 * Turnstile token when one is present, then hand the message to Resend. Both
 * halves are free — the Workers runtime and Turnstile cost nothing, and Resend's
 * free tier is 3,000 emails a month. Secrets (RESEND_API_KEY, TURNSTILE_SECRET)
 * are Worker secrets; everything else is in wrangler.toml's [vars] block.
 */

const TURNSTILE_VERIFY = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';
const RESEND_ENDPOINT = 'https://api.resend.com/emails';
const EMAIL_SHAPE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

export default {
  async fetch(request, env) {
    const origin = request.headers.get('Origin') || '';
    const allowedOrigins = (env.ALLOWED_ORIGINS || '').split(',').map((value) => value.trim()).filter(Boolean);
    const allowOrigin = allowedOrigins.indexOf(origin) !== -1 ? origin : '';

    // answered before the allowlist so a browser preflight is never a hard error
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders(allowOrigin) });
    }

    if (request.method !== 'POST') {
      return new Response('Method not allowed', { status: 405, headers: corsHeaders(allowOrigin) });
    }

    if (!allowOrigin) {
      return new Response('Origin not allowed', { status: 403, headers: corsHeaders('') });
    }

    const form = await request.formData();

    if (field(form, '_honey')) {
      return respond(request, allowOrigin, true, 200); // decoy: never tell a bot it was caught
    }

    // a token only exists if the visitor ran the Turnstile script, so its absence
    // means no javascript — the allowlist and honeypot carry that case
    const token = field(form, 'cf-turnstile-response');
    if (token && !(await turnstileOk(token, request, env))) {
      return respond(request, allowOrigin, false, 400);
    }

    const name = `${field(form, 'firstName')} ${field(form, 'lastName')}`.trim();
    const email = field(form, 'email');
    const message = field(form, 'message');

    if (!EMAIL_SHAPE.test(email) || !message) {
      return respond(request, allowOrigin, false, 400);
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
      return respond(request, allowOrigin, false, 502);
    }

    return respond(request, allowOrigin, true, 200);
  },
};

// answers the js path with json and the no-js path with a 303 back to the page
function respond(request, allowOrigin, ok, status) {
  const headers = corsHeaders(allowOrigin);

  if ((request.headers.get('Accept') || '').indexOf('application/json') !== -1) {
    headers['Content-Type'] = 'application/json; charset=utf-8';
    return new Response(JSON.stringify({ ok }), { status, headers });
  }

  headers['Location'] = `${returnBase(request, allowOrigin)}?${ok ? 'sent' : 'error'}=1`;
  return new Response(null, { status: 303, headers });
}

// the page the visitor came from, so a project-page baseurl survives the round trip
function returnBase(request, allowOrigin) {
  try {
    const referer = new URL(request.headers.get('Referer') || '');
    const cut = referer.pathname.indexOf('/contact/');

    if (referer.origin === allowOrigin && cut !== -1) {
      return `${referer.origin}${referer.pathname.slice(0, cut)}/contact/`;
    }
  } catch {
    // a missing or unparseable referer — fall through to the origin's own path
  }

  return `${allowOrigin}/contact/`;
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
