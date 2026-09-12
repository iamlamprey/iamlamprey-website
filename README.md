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
   `www.iamlamprey.com`, `iamlamprey.github.io` and `localhost` while the site is still served
   from those). The **site key** is public and goes in `contact.html`; the **secret key** stays
   in the Worker.
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
behaves the same before and after the custom-domain cutover, with no DNS coupling. 

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
iamlamprey.com, iamlamprey.github.io, 127.0.0.1:4000, localhost:4000
```

### The /thanks/ page

`thanks.html` (permalink `/thanks/`, `layout: default`) is the confirmation page Polar's Success URL
sends a paid buyer to. Every Checkout Link carries one:

```
https://iamlamprey.github.io/iamlamprey-website/thanks/?checkout_id={CHECKOUT_ID}   # now
https://iamlamprey.com/thanks/?checkout_id={CHECKOUT_ID}                           # after cutover
```

`{CHECKOUT_ID}` is substituted by Polar at redirect time. The URL has to be absolute, because this
is a browser-level redirect out of the checkout rather than an internal link, so `relative_url`
cannot help. The page is `noindex: true` in its front matter, which `default.html` renders as
`<meta name="robots" content="noindex">` — a thank-you page has no business in search results.

The page deliberately does not read `?checkout_id=` and does not load the Meta Pixel yet. The
parameter is left on the URL because the valued Purchase event that comes next needs it to fetch the
order's total from Polar's API. Nothing else refers to the page: it is not in `_data/nav.yml`, and
because it is `layout: default` it loads neither `ibl-catalog.js` nor the embed script.

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
not in the repo, so this is the one part of the setup that a `git revert` cannot undo. Expect to run
it twice — once for the GitHub Pages hostname and once at cutover. Every link needs one: the embed's
success message carries only `{successURL, redirect}`, so a link with no Success URL leaves the
overlay to close with the buyer back on the product page and no confirmation on screen. Whether
Polar shows a confirmation of its own inside the overlay before closing is still unconfirmed on a
device; if it does, the Success URL is a nicety rather than the only thing standing between a buyer
and a silent close.

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

1. Flip the hrefs in `_data/nav.yml` if the paths change.
2. Set `baseurl: ""` in `_config.yml` (and `url:` to the new domain).
3. Add the `CNAME` file for the custom domain.
4. Add the Payhip-era redirects from `PROMPT.md`: `/b/`, `/muzzle`, `/achromic`.
5. Re-check the 404s: every page in `_data/nav.yml` now exists — `/music/`,
   `/instruments/`, `/master-bundle/`, `/sample-packs/`, `/contact/`, `/plugins/`
   (Muzzle and Altar) and every instrument and sample pack. The Supporter Bundle
   page and the Altar "Support Development" block are still parked.
6. Re-run the Success URLs against the new hostname:
   `python scripts/set_success_url.py --base-url https://iamlamprey.com/thanks/`. They live on
   Polar rather than in the repo, so nothing else moves them. While you are in the dashboard,
   confirm **both** hostnames are still in the embed allowlist (Settings → Preferences →
   Embedding) — dropping one blanks the checkout overlay on whichever host is missing.

## Known follow-ups

- The hero JPGs are 2–3 MB unoptimised. A width-descriptor/WebP pass is worth
  doing before launch; the CSS keeps layout stable in the meantime.
- Per-product "type" labels (e.g. "Rhythm guitars") are editorial, not commerce
  data, so they belong in a data file rather than `config.json`.
