#!/usr/bin/env python3
"""Attach the newsletter opt-in checkbox to every Polar product.

Polar enables Custom Fields per product, so a field created in the dashboard only
reaches a checkout once every product names it — 25-odd dashboard edits, or these
25-odd API calls:

    python scripts/attach_custom_field.py --dry-run
    python scripts/attach_custom_field.py --slug achromic
    python scripts/attach_custom_field.py

PATCH /v1/products/{id} replaces attached_custom_fields rather than merging it, so
each product's existing attachments are read first and the new field appended.
Sending a single-element list would silently detach anything attached later. A
product that already carries the field is skipped, so a re-run costs one list
request and no writes.

Products are matched to config.json items through the item's product_id, the way
scripts/set_success_url.py does — labels drift. A token needs the products:write
scope; the discount automation's token may not carry it. POLAR_ACCESS_TOKEN is
read from the environment first and falls back to keys.txt, as the other scripts
do.

**A new product has to be added to config.json AND to a run of this script**, or
its checkout ships without the checkbox and nobody can join the list from it.
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
# requests follow Polar's Current version, which changes each quarter; the pin
# keeps the product shapes below stable. An unknown or removed version returns
# HTTP 404 (2026-04 is removed at the January 2027 release).
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


def read_custom_field_id(config: dict) -> str:
    # the field's id, pasted into config.json once the dashboard has created it
    value = ((config.get("newsletter") or {}).get("custom_field_id") or "").strip()
    if not value:
        die("config.json has no newsletter.custom_field_id — create the field in the Polar "
            "dashboard (Settings -> Custom Fields) and paste its id into that block")
    return value


def product_attachments(product: dict) -> list:
    # the fields a product already carries, in the shape PATCH expects back
    attached: list = []
    for entry in product.get("attached_custom_fields") or []:
        if not isinstance(entry, dict):
            continue
        field_id = (entry.get("custom_field_id") or "").strip()
        if field_id:
            attached.append({"custom_field_id": field_id, "required": bool(entry.get("required"))})
    return attached


def build_plan(config: dict, products: list, field_id: str, slugs: list) -> tuple[list, list]:
    # pairs each Polar product with the config.json item it sells, and the
    # attachment list it needs; already-attached products come back marked so a
    # re-run reports them rather than writing the same list again
    items = [item for item in config.get("items", []) if (item.get("product_id") or "").strip()]
    by_product = {(item["product_id"] or "").strip(): item for item in items}
    wanted = [slug.strip() for slug in slugs if slug.strip()]

    plan: list = []
    unmatched: list = []

    for product in products:
        item = by_product.get((product.get("id") or "").strip())
        if not item:
            unmatched.append(product)
            continue
        if wanted and item["slug"] not in wanted:
            continue

        attached = product_attachments(product)
        if any(entry["custom_field_id"] == field_id for entry in attached):
            plan.append((product, item, attached, True))
            continue

        plan.append((product, item, attached + [{"custom_field_id": field_id, "required": False}], False))

    return plan, unmatched


class Polar:
    # minimal Polar API client for the products endpoints

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

    def list_products(self) -> list:
        # every product in the organization, following pagination
        out: list = []
        page = 1
        while True:
            params = {"page": page, "limit": 100}
            if self.organization_id:
                params["organization_id"] = self.organization_id
            data = self._request("GET", "/v1/products/", params=params)
            out.extend((data.get("items") if isinstance(data, dict) else data) or [])
            pagination = data.get("pagination") if isinstance(data, dict) else None
            next_page = pagination.get("next_page") if isinstance(pagination, dict) else None
            if not next_page:
                break
            page = next_page
        return out

    def attach_custom_fields(self, product_id: str, attached: list) -> dict:
        # writes one product's full attachment list — the field is appended to
        # whatever the product already had, never sent on its own
        return self._request("PATCH", f"/v1/products/{product_id}", json_body={"attached_custom_fields": attached})


def describe(product: dict) -> str:
    # a product as it reads in the run log, for the ones that matched no item
    name = (product.get("name") or "(no name)").strip()
    return f"  {product.get('id')} | {name}"


def main() -> int:
    parser = argparse.ArgumentParser(description="Attach the newsletter opt-in Custom Field to every Polar product.")
    parser.add_argument("--slug", action="append", default=[],
                        help="only touch this config.json item (repeatable) — use it to pilot one product")
    parser.add_argument("--dry-run", action="store_true",
                        help="list the products and print the planned attachments, no writes")
    args = parser.parse_args()

    config = read_config()
    field_id = read_custom_field_id(config)
    print(f"custom field: {field_id}")

    api = Polar(read_api_key(), os.environ.get("POLAR_API_BASE") or DEFAULT_API_BASE,
                (os.environ.get("POLAR_ORGANIZATION_ID") or "").strip() or None,
                (os.environ.get("POLAR_API_VERSION") or "").strip() or DEFAULT_API_VERSION)

    try:
        products = api.list_products()
    except RuntimeError as error:
        die(f"could not list the products: {error}")
    print(f"polar: {len(products)} product(s)")

    plan, unmatched = build_plan(config, products, field_id, args.slug)

    if not plan:
        print("nothing to do — no Polar product matched a config.json item")
    for product, item, attached, already in plan:
        if already:
            print(f"{item['slug']}: field already attached")
            continue
        print(f"{item['slug']}: attaching the field to {len(attached) - 1} existing attachment(s)")

    if unmatched:
        print(f"warning: {len(unmatched)} Polar product(s) matched no config.json item:", file=sys.stderr)
        for product in unmatched:
            print(describe(product), file=sys.stderr)

    if args.dry_run:
        print("dry-run: no product was changed")
        return 0

    changed = 0
    failed = 0
    for product, item, attached, already in plan:
        if already:
            continue
        try:
            updated = api.attach_custom_fields(product["id"], attached)
        except RuntimeError as error:
            failed += 1
            print(f"error: {item['slug']} was not updated: {error}", file=sys.stderr)
            continue
        changed += 1
        print(f"updated {item['slug']} | {updated.get('id') or product['id']} | "
              f"{len(updated.get('attached_custom_fields') or attached)} attachment(s)")

    print(f"{changed} updated, {failed} failed")
    return 1 if failed else 0


if __name__ == "__main__":
    raise SystemExit(main())
