# iamlamprey-website

Github Pages + Jekyll front-end, Polar as storefront / MoR.

## Local preview

Double-click **`serve.bat`**. It checks for Ruby, installs Ruby + DevKit via
winget if it is missing (then asks you to re-run it), runs `bundle install` on
first use, and serves <http://127.0.0.1:4000> with livereload.

`serve.bat` passes `--baseurl ""` so links resolve at the root locally. If cmd
mangles that empty argument, run the server by hand with `--baseurl /` — the
`relative_url` filter normalises the resulting double slash.

## /contact/

Uses a small **Cloudflare Worker** (`worker/`) to relay message to [Resend](https://resend.com) which then forwards to support email.

The Worker is a thin proxy: it checks the origin, drops bots, optionally verifies a Turnstile
token, then posts. It reads four fields — `firstName`, `lastName`, `email`, `message` — and sets
`reply_to` to the visitor, so hitting Reply in the inbox answers them directly. Pushing anything
under `worker/` deploys it through `.github/workflows/contact-worker.yml`.

### One-time setup

None of this lives in the repo; it is all dashboard work:

1. **Resend** — create a free account, add `iamlamprey.com` as a domain, and add the three
   records it generates in Cloudflare DNS (a DKIM `TXT`, an SPF `TXT` and an `MX` on the
   `send.` subdomain). Then create an API key with **Sending access** scoped to `iamlamprey.com`.
2. **Turnstile** — add a widget for the site's hostnames (`iamlamprey.com`,
   `www.iamlamprey.com`, `iamlamprey.github.io` and `localhost` — the last two stay so legacy
   links and local previews keep working). The **site key** is public and goes in
   `contact.html`; the **secret key** stays in the Worker.
3. **Worker secrets** — set `RESEND_API_KEY` and `TURNSTILE_SECRET` on the Worker (Workers →
   the script → Settings → Variables → Secret), or locally with
   `npx wrangler secret put <NAME> --cwd worker`. Keeping them in the Cloudflare dashboard
   avoids the deprecated `secrets:` input on `wrangler-action`; the GitHub secrets below only
   deploy *code*.
4. **Repo secrets** — `CLOUDFLARE_API_TOKEN` (scopes: *Workers Scripts: Edit*, *Account
   Settings: Read*) and `CLOUDFLARE_ACCOUNT_ID`, for the deploy workflow.
5. **Fill the two placeholders** — `contact_endpoint` in `_config.yml` (the `workers.dev` URL
   `wrangler` prints on the first deploy) and `data-sitekey` on the Turnstile div in
   `contact.html`. The form is dead until the endpoint is real.

Cloudflare Email Routing already owns the root MX for `iamlamprey.com`, so Resend's records go
on the `send.` subdomain and the two coexist — the `support@` and `contact@` rules below are
untouched.

The endpoint stays a `workers.dev` URL rather than an `iamlamprey.com/api/contact` route, so it
behaves the same on the live site and on a local preview, with no DNS coupling.

## config.json

`config.json` stays at the repo root and is **published**, because the pages
fetch it at runtime:

- `items` — every product: `slug`, `name`, `price`, `kind`, `checkout`.
- `discount` — the storewide sale: `amount` (whole percent), `products`
  (`"ALL"` or a list of slugs), `start`/`end` in **DD/MM/YYYY**
  (Australia, UTC+10, no DST) and the Polar `code`.
- `announcement` — the announcement bar: `text` and `link` (site-relative or
  absolute). No dates: a non-empty `text` shows the bar and an empty `text`
  hides it, so clearing the text is how the bar comes down.

Pushing a change to `config.json` also wakes `.github/workflows/polar-discount.yml`,
which creates the matching Polar discount. That is expected and idempotent (it
deletes and recreates the same `code`).

### Why `init()` is called from `ibl-catalog.js`

The library's `init()` binds with a one-off `document.querySelectorAll("[data-polar-checkout]")` —
**not** event delegation. With `data-auto-init` it would run on `DOMContentLoaded`, when our buy
buttons do not exist yet: `ibl-catalog.js` builds them only once `config.json` has resolved. The tag
therefore carries **no `data-auto-init`**, and the renderer calls `init()` itself at the end of its
pass, after both the product blocks and the catalogue grids:

```js
function initCheckout() {
  if (window.Polar && window.Polar.EmbedCheckout) window.Polar.EmbedCheckout.init();
}
```

`init()` is idempotent, so calling it after every render is safe, and nothing else needs
re-initialising: the click handler reads `href` at click time, so the countdown switching prices and
`withCode()` appending `?discount_code=` keep working on a button that was bound once. The
`window.Polar` guard covers a blocked CDN, an offline visit or a privacy blocker — the button then
behaves as an ordinary link to Polar.

**This is the trap to remember:** a buy button rendered anywhere other than `ibl-catalog.js` needs
its own `init()` call once it exists, or it will redirect to Polar instead of opening the overlay.

### The overlay theme

`default.html` puts the page's `theme` front matter on the body, defaulting to dark:

```html
<body data-ibl-checkout-theme="{{ page.theme | default: 'dark' }}">
```

`ibl-catalog.js` reads that once and copies it onto every button it tags with
`data-polar-checkout-theme`, so Muzzle's checkout opens light and everything else dark. It is the
same key `_layouts/plugin.html` already reads for `ibl-plugin-light`, so there is nothing new to
configure. A button whose `checkout` is empty — the disabled "Coming soon" state — is deliberately
**not** tagged: the library falls back to
`element.getAttribute('href') || element.getAttribute('data-polar-checkout')` when it is clicked, so
a button with neither would make it build a URL out of an empty string.

### Allowlist the embed hosts in Polar

Polar dashboard → **Settings → Preferences → Embedding**. Enter every host in a **single save** —
the list is replaced, not appended:

```
iamlamprey.com, www.iamlamprey.com, iamlamprey.github.io, 127.0.0.1:4000, localhost:4000
```

`www` is listed alongside the apex, and the github.io entry stays because links carrying that
host are still in circulation.

### The /thanks/ page

`thanks.html` (permalink `/thanks/`, `layout: default`) is the confirmation page Polar's Success URL
sends a paid buyer to. Every Checkout Link carries one:

```
https://iamlamprey.com/thanks/?checkout_id={CHECKOUT_ID}
```

`{CHECKOUT_ID}` is substituted by Polar at redirect time. The URL has to be absolute, because this
is a browser-level redirect out of the checkout rather than an internal link, so `relative_url`
cannot help. The page is `noindex: true` in its front matter, which `default.html` renders as
`<meta name="robots" content="noindex">` — a thank-you page has no business in search results.

The page reads `?checkout_id=` through `ibl-purchase.js`, which its `purchase: true` front matter
loads, and hands it to the Worker so the valued Purchase can be looked up and reported — see the
Meta Pixel section below. Nothing else refers to the page: it is not in `_data/nav.yml`, and because
it is `layout: default` it loads neither `ibl-catalog.js` nor the embed script.

### Setting the Success URLs

`scripts/set_success_url.py` makes the 25-odd edits through `PATCH /v1/checkout-links/{id}`:

```
python scripts/set_success_url.py --base-url https://iamlamprey.com/thanks/ --dry-run
python scripts/set_success_url.py --base-url https://iamlamprey.com/thanks/ --slug achromic
python scripts/set_success_url.py --base-url https://iamlamprey.com/thanks/
```

It matches each link to a `config.json` item through the item's `product_id` — a label can drift —
reports any link that matches no item or more than one, and skips a link whose Success URL is already
correct, so a re-run costs one list request and no writes. The token needs the `checkout_links:write`
scope, which the discount automation's token may not carry; the script reads `POLAR_ACCESS_TOKEN`
and falls back to `keys.txt`, like the migration scripts.

**Pilot one link first** (`--slug achromic`, then buy through it): the Success URLs live on Polar,
not in the repo, so this is the one part of the setup that a `git revert` cannot undo. They all read
`https://iamlamprey.com/thanks/` now, so rolling back means re-running the script with
`--base-url https://iamlamprey.github.io/iamlamprey-website/thanks/` while that host is still in
the embed allowlist. Every link needs one: the embed's
success message carries only `{successURL, redirect}`, so a link with no Success URL leaves the
overlay to close with the buyer back on the product page and no confirmation on screen. Whether
Polar shows a confirmation of its own inside the overlay before closing is still unconfirmed on a
device; if it does, the Success URL is a nicety rather than the only thing standing between a buyer
and a silent close.

## Meta Pixel

The site reports a four-event funnel to one Meta pixel, three of the events from the
browser and one from the Worker:

- **`PageView`** on every page, fired as the pixel loads.
- **`ViewContent`** on a product page, from `assets/js/ibl-catalog.js` — the only file
  that knows an item's price and its Polar `product_id`. `/plugins/muzzle/` carries two
  product blocks, so it legitimately reports two.
- **`InitiateCheckout`** on a buy button, from the same file, with the price read at
  click time. Catalogue grid cards report nothing: they are links to a product page, and
  `ViewContent` fires on arrival there. An item priced at `0` reports neither event.
- **`Purchase`** on `/thanks/`, valued with the order's real total — see below.

The pixel's id lives in `_config.yml` as `meta_pixel_id`, next to the other endpoint
keys — `contact_endpoint`, `newsletter_endpoint`, `reviews_endpoint`, `ratings_endpoint`,
`purchase_endpoint` and `geo_endpoint`, one per Worker route the page talks to. **A blank
value renders no pixel, no consent banner, no notice and no events at all**, which is
what keeps local previews and the deploy before the tokens exist harmless — and it is the
whole rollback: blank the id, push, and the feature is off.

### The consent gate

The gate is only shown where the law requires it. Before anything asks, the page calls
the Worker's `/geo` route, and the answer splits the site in two:

- **A consent country** — the EU-27, Iceland, Liechtenstein, Norway, the UK and
  Switzerland — keeps the Accept/Decline banner, and nothing in the page requests
  anything from Meta until **Accept** is pressed. `_includes/meta-pixel.html` carries
  Meta's base snippet with its `fbevents.js` fetch split out into
  `window.iblLoadPixel()`, and `ibl-consent.js` — the only caller — runs it once the
  decision is `granted`.
- **Everywhere else** gets the dismissible notice instead — *"This website uses cookies
  to provide necessary site functionality and marketing services."* with a single × in
  the corner — and the pixel loads immediately. That is what recovers the whole funnel
  for traffic whose law does not require the gate, and what lets `fbevents.js` read
  `fbclid` off the landing URL and write `_fbc` while it does.

The `<noscript>` beacon is deliberately **not** shipped: a visitor without javascript
cannot see either banner, so a beacon that fired anyway would be tracking without
consent.

- **Every uncertain answer is the gated one.** An unknown country, a blank
  `geo_endpoint`, a failed or timed-out request, a CORS rejection, or a notice missing
  from the markup all resolve to the Accept/Decline gate. A false `required` costs a
  banner on a visitor who did not need one; a false `not_required` tracks a European
  without consent, and that is the only mistake with a real cost.
- The decision is `'granted'` or `'denied'` under **`ibl-consent-v1`** in
  `localStorage`. A new key version is how a later change to what is being consented to
  is introduced, rather than everyone who answered the old one inheriting it.
- The notice's dismissal is its own key, **`ibl-notice-v1`**, because a notice is not a
  consent — the consent key's versioning exists to describe *what* was consented to. It
  doubles as the record that this browser was outside a consent country, so a later page
  loads the pixel as it did then, with no `/geo` round trip and nothing to show.
- **Granted** loads the pixel immediately, and fires a queued event that was recorded
  before the answer — `window.iblQueue`, so a visitor who opens a product page and only
  then answers the banner still has their `ViewContent` recorded.
- **Declined** never loads the pixel, and `window.iblTrack()` drops every event from
  there on. `/thanks/` reports nothing either, so the Worker is never asked: the two
  copies of `Purchase` are gated on the same decision.
- A **localhost** host is refused inside `iblLoadPixel()`, so a local preview shares
  `_config.yml` with production but stays out of the dataset. `isLocal()` also
  short-circuits the regime request, so a local preview makes no `/geo` call at all.
- A browser with `localStorage` unavailable remembers neither answer, so it is shown the
  gate — or the notice — again on every visit rather than being treated as an answered
  visitor.

`window.iblTrack(name, params, options)` is the one call the rest of the site makes,
always behind an `if (window.iblTrack)` guard, so every caller still runs with the
pixel switched off.

### The `/geo` route

`GET /geo` answers `{ consent: 'required' | 'not_required', country }`, read from
Cloudflare's own `request.cf.country` rather than a third-party lookup — so no visitor's
IP leaves for a service the site does not already use.

- **The country list is a constant in `worker/src/index.js`**: the EU-27 plus Iceland,
  Liechtenstein, Norway, the UK and Switzerland. It lives on the server so a change to it
  is a Worker deploy rather than a site rebuild, and so the site never ships a legal
  boundary that can drift. `request.cf.country` is ISO 3166-1 alpha-2 — Greece is `GR`
  and the UK is `GB` — and the crown dependencies (Jersey, Guernsey, Man) are
  deliberately not listed; adding one is a one-word change.
- **An unresolvable country answers `required`**, the same direction the page fails in
  and for the same reason: a false `required` costs a banner on a visitor who did not
  need one, while a false `not_required` tracks a European without consent.
- **`Cache-Control: no-store` is load-bearing rather than tidy.** A per-colo response
  cached and served to a visitor in another country would be exactly the fail-open case
  the route exists to avoid.
- **The origin allowlist is a CORS filter and not authentication.** The
  `Access-Control-Allow-Origin` header is echoed only for an origin in `ALLOWED_ORIGINS`,
  so another site's page cannot read the answer out of the response — that page's fetch
  fails and its own fail-closed path takes over. A non-browser client sets its own
  `Origin`, the same caveat `gate()` already carries on the other routes.
- **It is deliberately not behind `withinRateLimit()`.** The route runs on every page
  view, and the shared five-a-minute ceiling would trip a visitor simply reading the
  site; there is nothing here a script can exhaust beyond what a page view already costs.
- `GET` and `HEAD` are answered, anything else is a `405`, and the request is simple —
  `Accept` is a CORS-safelisted header — so there is no preflight to answer.

That is one `/geo` call per first visit and none for a returning visitor, which sits
comfortably inside the Workers free tier's 100,000 requests a day. A Cloudflare proxy
(orange cloud) in front of the site would remove the call entirely, since the request
would never leave Cloudflare's network — but it requires moving off GitHub's certificate,
so the site stays as it is.

### Why `Purchase` needs the Worker

Polar is the merchant of record, so the payment happens on `buy.polar.sh` and the pixel
cannot see it: the embed's `success` event carries only `{ successURL, redirect }`, and
GitHub Pages cannot run server code. The value has to be looked up after the fact, which
is what `worker/src/index.js` is for — it already holds the Polar credentials, the
origin allowlist and the rate limiter.

```
buyer pays on buy.polar.sh
  → Polar redirects to https://iamlamprey.com/thanks/?checkout_id=<uuid>
  → thanks.html POSTs that checkout_id (+ _fbp/_fbc) to the Worker's /purchase route
  → the Worker calls Polar, GET /v1/orders/?checkout_id=<uuid>
  → real total_amount + currency + product_id
  → the Worker sends the server-side Purchase and returns the order id and the value
  → the page fires fbq('track', 'Purchase', {...}, { eventID: <Polar order id> })
```

Both copies carry **the same `event_id` (the Polar order id) and the same `event_name`**,
which is exactly how Meta deduplicates a redundant setup — so one purchase counts once,
and an ad-blocked browser still reports through the server.

### The `/purchase` route

`POST /purchase` fits the file's existing shape: `gate()` for the origin allowlist and
the `OPTIONS` preflight (a JSON post from `iamlamprey.com` to the `workers.dev` host is
cross-origin), then `withinRateLimit()`. A body without `consent: true` is answered `204`
and nothing happens — the Worker cannot verify the claim, but the intent is explicit in
code and a hand-rolled request cannot quietly send an event.

- **The lookup** is `GET https://api.polar.sh/v1/orders/?checkout_id=<id>&limit=10` with
  `Authorization: Bearer POLAR_ORDERS_TOKEN` and **`Polar-Version: 2026-04`**, the same
  pin all five `scripts/` clients send and for the same reason (see the section below).
  It takes the newest order with `status === 'paid'`, and retries that lookup three times
  at ~500 ms, because the redirect back to `/thanks/` and the order creation are not
  perfectly ordered — which is also why the page has no retry loop of its own.
- **The numbers** come from the order: `total_amount` is **integer cents**, so it is
  divided by 100, and `currency` comes back lowercase (`usd`), so it is uppercased for
  the ISO 4217 form Meta expects. `value` and `currency` are the two parameters Meta
  marks required for `Purchase`; a free order (`total_amount` of 0) is answered
  `{ ok: false, reason: 'free_order' }` rather than fired valueless.
- **The server event** is a `POST` to `https://graph.facebook.com/v26.0/<PIXEL_ID>/events`
  carrying `em` — SHA-256 in lowercase hex over the address lowercased and trimmed — plus
  `client_ip_address`, `client_user_agent` and `fbp`/`fbc`, which must **not** be hashed
  and are omitted rather than sent empty. `META_TEST_EVENT_CODE` routes the event to the
  Test Events tab while it is set, so it stays blank in production.
- **The answer** is `{ ok: true, event_id, value, currency, content_ids }` with
  `no-store`, or `{ ok: false, reason }` for `no_order`, `free_order`, `bad_request`,
  `rate_limited`, `lookup_failed`, `bad_order` or `capi_error`. The page fires its
  browser copy only on `ok: true`, and treats any `200` — either answer — as final.
- **The deduplication on the page** is `sessionStorage['ibl-purchase-' + checkoutId]`,
  written only once the Worker has answered: Meta's rules cover a pixel↔server pair, but
  two *browser* events sharing an `eventID` are not guaranteed to collapse, so a reload
  of the confirmation page would otherwise inflate the count. A network failure is never
  remembered, so it can still retry.

The route logs status codes only — never the buyer's email, the token or a response body.

### Setting it up

Dashboard work first, then the two public values in the repo:

1. **Events Manager** → *Connect data* → *Web* → create the pixel (this is a *dataset*;
   the Pixel ID and Dataset ID are the same number). The access token comes from the
   pixel's *Settings* → *Conversions API*, through Meta's recommended **"Set up with
   Dataset Quality API"** / **"Connect Conversions API"** flow, which mints the token and
   stands up the integration in one pass — the older *Overview → Manage Integrations →
   Manage* click, which created the Conversions API app and its system user, is no longer
   part of that flow. The token is shown **once**, it belongs in the Cloudflare secret
   and nowhere else, and it involves no App Review and no permission request.
   `_includes/meta-pixel.html` was diffed against the base code Events Manager serves
   today, so that copy is current rather than stale. Then *Brand Safety → Domains* and
   verify `iamlamprey.com` by DNS `TXT` (Cloudflare owns the zone). *Aggregated Event
   Measurement* is **after launch**: it lives in the pixel's *Settings → Event Setup*,
   which needs the events already arriving before it can detect and rank them, and the
   interactive tool it opens runs against the live site. The order to set there is
   `Purchase` → `InitiateCheckout` → `ViewContent` → `PageView`, once the pixel is live.
2. **Polar** → *Settings → Access Tokens* → create an **Organization Access Token**
   scoped to **`orders:read`** and nothing else. Do not reuse the discount automation's
   token: that one carries `discounts:write`, and the pixel route has no business near
   it.
3. **Cloudflare** → the Worker → *Settings → Variables* → set **`META_CAPI_TOKEN`** and
   **`POLAR_ORDERS_TOKEN`** as secrets **before the push that carries them**. Both are in
   `[secrets] required` in `worker/wrangler.toml`, and a deploy that refuses there takes
   the contact form, the newsletter and the reviews down with it.
4. Fill in the public halves — `META_PIXEL_ID` in `worker/wrangler.toml` and
   `meta_pixel_id` in `_config.yml` — and push. Until the id is set the site is
   unchanged and untracked, so this is the one clean switch.
5. `POLAR_ORGANIZATION_ID` only if the token is not scoped to a single organisation: the
   lookup answers `400` without it in that case.

### Known limitations

- **A declined visitor is not counted at all**, including a real EU or UK purchase. That
  is the gate's trade-off: both halves hang on the one decision rather than the server
  event ignoring it.
- **A new EU or UK visitor who arrives from an ad click and browses before answering the
  banner loses `fbclid`**, because `_fbc` is written by `fbevents.js` when it loads and it
  does not load until Accept — by which time the landing URL is gone. A returning visitor
  is unaffected: the stored decision loads the pixel on landing, with `fbclid` still in
  the URL. Closing it for the first visit would mean storing `fbclid` on the device
  before consent, which the EDPB's *Guidelines 2/2023*, the ICO and the CNIL all treat as
  requiring consent — Article 5(3) ePrivacy covers storage *and* access by any method, and
  no exemption covers an ad identifier. A deliberate cost, not an oversight.
- **The non-EU classification is cached in `ibl-notice-v1`**, so a visitor who moves into
  a consent country keeps the notice path until they clear storage. Re-asking on every
  visit would cost a `/geo` round trip on every page view, and the error only arrives
  with a visitor who was outside a consent country when they dismissed the notice. That
  is the direction of the error being accepted.
- **A buyer who closes the tab before `/thanks/` loads** is never reported. A webhook
  backstop on the existing `/polar` handler would catch those — deduplication would even
  be free, since the `event_id` is the same order id — but a webhook has no access to the
  consent decision, so it would fire for buyers who explicitly declined. Worth
  revisiting if the tab-close loss shows up in the numbers.
- No `AddToCart` (there is no cart: every buy button is a direct checkout link) and no
  refund handling (Meta has no standard event for it; `order.refunded` is available).

## Polar API versioning

Polar versions its API by date (`YYYY-MM`) and applies that version to requests, responses and
webhook payloads. A request that sends no version follows Polar's *Current* version, which changes
at the start of each quarter, so all five `scripts/` clients pin one: `DEFAULT_API_VERSION` is
`2026-04`, sent as a `Polar-Version` header on every request by `apply_discount.py`,
`migrate-payhip.py`, `migrate-gumroad.py`, `migrate-shopify.py` and `set_success_url.py`.
`POLAR_API_VERSION` overrides
the pin for a one-off check against a newer version:

```
POLAR_API_VERSION=2026-10 python scripts/apply_discount.py
```

Each run logs the version Polar echoed back — `polar: using API version 2026-04` — so the Action
log for a `config.json` push shows which contract served the request. A version Polar does not
recognise, or has removed, returns `404`.

### Why it is pinned

`build_payload()` writes `basis_points`, `duration`, `starts_at`, `ends_at` and `products` the way
`2026-04` documents them, and reads the discount list response (`items` with
`pagination.next_page`) the same way. Pinning keeps those shapes stable across the October release
instead of floating onto an untested `2026-10` the moment Polar makes it Current.

### Migrating to the next version

1. Confirm the newer version is live — expect `200`, and a response `Polar-Version` header echoing
   the version you sent:

   ```
   curl -s -o /dev/null -D - -H "Authorization: Bearer $POLAR_ACCESS_TOKEN" -H "Polar-Version: 2026-10" https://api.polar.sh/v1/discounts/
   ```

2. Create a throwaway discount under it and confirm the four fields come back as sent:

   ```
   curl -s -X POST https://api.polar.sh/v1/discounts/ -H "Authorization: Bearer $POLAR_ACCESS_TOKEN" -H "Polar-Version: 2026-10" -H "Content-Type: application/json" -d '{"name":"api version test","type":"percentage","basis_points":100,"duration":"once","code":"apitest202610","starts_at":"<iso>","ends_at":"<iso>"}'
   ```

   then `DELETE /v1/discounts/<id>` to clean up.

3. Unchanged fields: bump `DEFAULT_API_VERSION` to `2026-10` in all five scripts and re-run the
   Action through *Run workflow* — the log line then reads `polar: using API version 2026-10`.
4. A changed field: adjust `build_payload()` first. The pin keeps the live sale working until that
   lands.

### The deadline

`2026-04` becomes Deprecated on 1 October 2026 and is removed at the January 2027 release. After
that a pinned request returns `404` and the discount Action fails on the next `config.json` push,
rather than silently creating the discount under an untested contract. Reminders for both dates are
already scheduled.

## Cutover to iamlamprey.com

Done — the site is served from `iamlamprey.com` by GitHub Pages. The repo side of it was four
changes:

1. `_data/nav.yml` already pointed at canonical paths, so no href moved.
2. `_config.yml`: `url: https://iamlamprey.com` and `baseurl: ""`, which takes the
   `/iamlamprey-website` prefix off every `canonical`, `og:url`, `og:image` and asset path.
3. `CNAME` at the repo root holds `iamlamprey.com`. The publishing source is *Deploy from a
   branch*, so that committed file is what tells Pages the custom domain — a custom-workflow
   deploy ignores it.
4. `worker/wrangler.toml`: `SITE_URL = "https://iamlamprey.com"`, so review invites and
   newsletter confirmations land on the apex.

The Payhip-era redirects from `PROMPT.md` (`/b/`, `/muzzle`, `/achromic`) were already committed
under `redirects/`, and every page in `_data/nav.yml` exists — `/music/`, `/instruments/`,
`/master-bundle/`, `/sample-packs/`, `/contact/`, `/plugins/` (Muzzle and Altar) and every
instrument and sample pack. The Supporter Bundle page and the Altar "Support Development" block
are still parked.

The dashboard half of it, none of which lives in the repo:

- **Cloudflare DNS** — the Payhip apex and `www` records became GitHub's four `A` records and a
  `www` `CNAME` to `iamlamprey.github.io`, both **DNS only** (grey cloud): proxying them stops
  GitHub issuing its Let's Encrypt certificate. MX and the Resend records were left alone.
- **Pages** — the DNS check passed, the certificate was issued and **Enforce HTTPS** went on.
  The gap between the DNS swap and the certificate is the only downtime the cutover has.
- **Polar** — the Success URLs moved with
  `python scripts/set_success_url.py --base-url https://iamlamprey.com/thanks/`, and the embed
  allowlist keeps both hostnames (Settings → Preferences → Embedding) — dropping one blanks the
  checkout overlay on whichever host is missing.
- **Turnstile** — the widget lists `iamlamprey.com` and `www.iamlamprey.com` alongside the older
  hosts; a missing hostname fails the contact form and the newsletter signup silently.

## Known follow-ups

- The hero JPGs are 2–3 MB unoptimised. A width-descriptor/WebP pass is worth
  doing before launch; the CSS keeps layout stable in the meantime.
- Per-product "type" labels (e.g. "Rhythm guitars") are editorial, not commerce
  data, so they belong in a data file rather than `config.json`.
