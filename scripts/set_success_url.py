#!/usr/bin/env python3
"""Point every Polar checkout link's Success URL at the site's /thanks/ page.

Every buy button on the site is a Polar checkout link. Redirected (or embedded)
checkout drops the buyer wherever the link's Success URL says when the payment
goes through, so each link has to name the confirmation page — an absolute URL,
because the buyer leaves the checkout at the browser level:

    https://iamlamprey.com/thanks/?checkout_id={CHECKOUT_ID}

Polar substitutes {CHECKOUT_ID} at redirect time. The parameter is left on the
URL deliberately: the /thanks/ page ignores it today, but a valued Purchase
event needs it to look the order's total up against Polar's API.

The site is served from two hostnames, so this runs twice in its life — once for
the GitHub Pages host, once for the custom domain — and again whenever the
Success URL has to move. A link already carrying the target URL is skipped, so a
re-run costs one list request and no writes.

Links are matched to config.json items by comparing each link's products against
the item's product_id, which does not drift the way a label can. A link that
matches no item, or more than one, is reported and left untouched. Pass --slug to
pilot one item first.

    python scripts/set_success_url.py --base-url https://iamlamprey.com/thanks/ --dry-run
    python scripts/set_success_url.py --base-url https://iamlamprey.com/thanks/ --slug achromic
    python scripts/set_success_url.py --base-url https://iamlamprey.com/thanks/

PATCH /v1/checkout-links/{id} needs the checkout_links:write scope, which the
discount automation's token may not carry. POLAR_ACCESS_TOKEN is read from the
environment first and falls back to keys.txt, as the migration scripts do.
"""

import argparse
import json
import os
import sys
import time
from pathlib import Path

import requests

ROOT = Path(__file__).resolve().parent.parent
CONFIG_JSON = ROOT / "config.json"
KEYS_FILE = ROOT / "keys.txt"
KEYS_FILE_ALT = Path(__file__).resolve().parent / "keys.txt"

# Polar's API base is the bare host; request paths already start with /v1/.
DEFAULT_API_BASE = "https://api.polar.sh"
MAX_RETRIES = 5

# Date-based API version sent on every request as Polar-Version. Unversioned
# requests follow Polar's Current version, which changes each quarter; a pinned
# version keeps the checkout-link shapes below stable. An unknown or removed
# version returns HTTP 404 (2026-04 is removed at the January 2027 release).
DEFAULT_API_VERSION = "2026-04"


def die(message: str) -> None:
    print(f"fatal: {message}", file=sys.stderr)
    raise SystemExit(1)


def parse_keys(path: Path) -> str:
    # first non-blank, non-# line of keys.txt is the API key
    for line in path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if line and not line.startswith("#"):
            return line
    die(f"{path} contains no API key on its first line")


def read_api_key() -> str:
    key = (os.environ.get("POLAR_ACCESS_TOKEN") or "").strip()
    if key:
        return key
    for candidate in (KEYS_FILE, KEYS_FILE_ALT):
        if candidate.exists():
            return parse_keys(candidate)
    die("POLAR_ACCESS_TOKEN is not set and no keys.txt was found")


def read_config() -> dict:
    if not CONFIG_JSON.exists():
        die(f"{CONFIG_JSON.name} not found at {CONFIG_JSON}")
    with CONFIG_JSON.open(encoding="utf-8") as handle:
        return json.load(handle)


def normalize_base_url(value: str) -> str:
    # the confirmation page as an absolute URL, with any dangling ? or & trimmed
    url = (value or "").strip().rstrip("?&")
    if not url.startswith(("http://", "https://")):
        die(f"--base-url must be an absolute http(s) URL, got {value!r}")
    return url


def success_url_for(base_url: str) -> str:
    # the Success URL for one link: the page plus Polar's checkout-id placeholder
    separator = "&" if "?" in base_url else "?"
    return f"{base_url}{separator}checkout_id={{CHECKOUT_ID}}"


def link_product_ids(link: dict) -> list:
    # the product ids a checkout link sells — Polar nests them, but tolerate ids
    ids: list = []
    for product in link.get("products") or []:
        if isinstance(product, dict):
            product_id = (product.get("id") or "").strip()
        else:
            product_id = str(product).strip()
        if product_id:
            ids.append(product_id)
    return ids


def build_plan(config: dict, links: list, base_url: str, slugs: list) -> tuple[list, list]:
    # pairs each checkout link with the config item it sells, and the URL it needs
    items = [item for item in config.get("items", []) if (item.get("product_id") or "").strip()]
    by_product = {(item["product_id"] or "").strip(): item for item in items}
    wanted = [slug.strip() for slug in slugs if slug.strip()]

    plan: list = []
    unmatched: list = []

    for link in links:
        matched: list = []
        for product_id in link_product_ids(link):
            item = by_product.get(product_id)
            if item and item["slug"] not in [entry["slug"] for entry in matched]:
                matched.append(item)

        if len(matched) != 1:
            unmatched.append((link, matched))
            continue
        if wanted and matched[0]["slug"] not in wanted:
            continue

        item = matched[0]
        checkout = (item.get("checkout") or "").strip()
        url = (link.get("url") or "").strip()
        if checkout and url and checkout != url:
            print(f"warning: link {link.get('id')} points at {url}, but config.json has {checkout} for {item['slug']}",
                  file=sys.stderr)

        plan.append((link, item, success_url_for(base_url)))

    return plan, unmatched


class Polar:
    # minimal Polar API client for the checkout-links endpoints

    def __init__(self, api_key: str, api_base: str, organization_id: str | None = None,
                 api_version: str = DEFAULT_API_VERSION):
        self.api_base = self._normalize_base(api_base)
        self.organization_id = organization_id
        self.api_version = api_version
        self.observed_version = None
        self.session = requests.Session()
        self.session.headers["Authorization"] = f"Bearer {api_key}"
        self.session.headers["Content-Type"] = "application/json"
        self.session.headers["Polar-Version"] = api_version
        self._raw_tried = False

    @staticmethod
    def _normalize_base(base: str) -> str:
        # Tolerate a base that accidentally includes /api/v1, /api or /v1 so we
        # never build a doubled path like https://api.polar.sh/api/v1/v1/...
        base = base.rstrip("/")
        for suffix in ("/api/v1", "/api", "/v1"):
            if base.endswith(suffix):
                base = base[: -len(suffix)]
        return base

    def _request(self, method: str, path: str, *, params: dict | None = None, json_body: dict | None = None):
        url = self.api_base + path
        last_error = None
        for attempt in range(MAX_RETRIES):
            try:
                response = self.session.request(method, url, params=params, json=json_body, timeout=30)
            except requests.exceptions.RequestException as error:
                last_error = error
                time.sleep(2 ** attempt)
                continue

            if response.status_code == 401 and not self._raw_tried:
                # Polar accepts the token both as `Bearer <token>` and raw; try raw once.
                self._raw_tried = True
                self.session.headers["Authorization"] = self.session.headers["Authorization"].removeprefix("Bearer ")
                continue

            if response.status_code in (429, 500, 502, 503, 504):
                retry_after = response.headers.get("Retry-After")
                delay = float(retry_after) if retry_after and retry_after.isdigit() else 2 ** attempt
                time.sleep(delay)
                continue

            if response.status_code >= 400:
                body = response.text[:300]
                raise RuntimeError(f"{method} {path} -> HTTP {response.status_code}: {body}")

            seen = response.headers.get("Polar-Version")
            if seen and seen != self.observed_version:
                self.observed_version = seen
                print(f"polar: using API version {seen}")

            if response.status_code == 204 or not response.content:
                return {}
            return response.json()

        raise RuntimeError(f"{method} {path} failed after {MAX_RETRIES} attempts: {last_error}")

    def list_checkout_links(self) -> list:
        # every checkout link in the organization, following pagination
        out: list = []
        page = 1
        while True:
            params = {"page": page, "limit": 100}
            if self.organization_id:
                params["organization_id"] = self.organization_id
            data = self._request("GET", "/v1/checkout-links/", params=params)
            out.extend((data.get("items") if isinstance(data, dict) else data) or [])
            pagination = data.get("pagination") if isinstance(data, dict) else None
            next_page = pagination.get("next_page") if isinstance(pagination, dict) else None
            if not next_page:
                break
            page = next_page
        return out

    def set_success_url(self, link_id: str, success_url: str) -> dict:
        # points one checkout link's post-payment redirect at the confirmation page
        return self._request("PATCH", f"/v1/checkout-links/{link_id}", json_body={"success_url": success_url})


def describe(link: dict) -> str:
    # a link as it reads in the run log, for the links that could not be matched
    label = (link.get("label") or "(no label)").strip()
    return f"  {link.get('id')} | {label} | products: {', '.join(link_product_ids(link)) or 'none'}"


def main() -> int:
    parser = argparse.ArgumentParser(description="Point every Polar checkout link's Success URL at /thanks/.")
    parser.add_argument("--base-url", required=True,
                        help="absolute URL of the confirmation page, e.g. https://iamlamprey.com/thanks/")
    parser.add_argument("--slug", action="append", default=[],
                        help="only touch this config.json item (repeatable) — use it to pilot one link")
    parser.add_argument("--dry-run", action="store_true",
                        help="list the checkout links and print the planned Success URLs, no writes")
    args = parser.parse_args()

    base_url = normalize_base_url(args.base_url)
    target = success_url_for(base_url)
    print(f"success url: {target}")

    api = Polar(read_api_key(), os.environ.get("POLAR_API_BASE") or DEFAULT_API_BASE,
                (os.environ.get("POLAR_ORGANIZATION_ID") or "").strip() or None,
                (os.environ.get("POLAR_API_VERSION") or "").strip() or DEFAULT_API_VERSION)

    try:
        links = api.list_checkout_links()
    except RuntimeError as error:
        die(f"could not list the checkout links: {error}")
    print(f"polar: {len(links)} checkout link(s)")

    plan, unmatched = build_plan(read_config(), links, base_url, args.slug)

    if not plan:
        print("nothing to do — no checkout link matched a config.json item")
    for link, item, url in plan:
        current = (link.get("success_url") or "").strip()
        if current == url:
            print(f"{item['slug']}: already set")
            continue
        print(f"{item['slug']}: {current or '(no success url)'} -> {url}")

    if unmatched:
        print(f"warning: {len(unmatched)} checkout link(s) matched no single config.json item:", file=sys.stderr)
        for link, matched in unmatched:
            slugs = ", ".join(entry["slug"] for entry in matched) or "-"
            print(f"{describe(link)} | matched: {slugs}", file=sys.stderr)

    if args.dry_run:
        print("dry-run: no checkout link was changed")
        return 0

    changed = 0
    failed = 0
    for link, item, url in plan:
        if (link.get("success_url") or "").strip() == url:
            continue
        try:
            updated = api.set_success_url(link["id"], url)
        except RuntimeError as error:
            failed += 1
            print(f"error: {item['slug']} was not updated: {error}", file=sys.stderr)
            continue
        changed += 1
        print(f"updated {item['slug']} | {updated.get('id') or link['id']} | {updated.get('success_url') or url}")

    print(f"{changed} updated, {failed} failed")
    return 1 if failed else 0


if __name__ == "__main__":
    raise SystemExit(main())
