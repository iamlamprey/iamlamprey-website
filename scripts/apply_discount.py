#!/usr/bin/env python3
"""Create the Polar discount described by config.json.

Reads the top-level "discount" block from config.json:

    "discount": {
      "amount": 25,
      "products": "ALL",
      "start": "01/06/2026",
      "end": "15/06/2026",
      "code": "junesale"
    }

and creates a percentage discount on Polar (POST /v1/discounts/). Dates are
written DD/MM/YYYY in Australia/Brisbane (UTC+10, no daylight saving): the start
is 00:00:00 local and the end is 23:59:59 local, both converted to UTC for the
API. "products" is either "ALL" (the discount applies storewide, so the
"products" field is omitted) or a list of item slugs that are mapped to their
Polar product_id.

The script is idempotent: any discount that already carries the same code is
deleted before the replacement is created, so repeated pushes never pile up
duplicates.

Run by .github/workflows/polar-discount.yml on every push to main that touches
config.json. Requires POLAR_ACCESS_TOKEN in the environment; POLAR_ORGANIZATION_ID
is optional and only needed when the token is not scoped to a single organization.

    python scripts/apply_discount.py --dry-run   # print the payload, no API calls
    POLAR_ACCESS_TOKEN=polar_oat_xxx python scripts/apply_discount.py
    POLAR_API_VERSION=2026-10 python scripts/apply_discount.py   # override the pin
"""

import argparse
import json
import os
import sys
import time
from datetime import datetime, timedelta, timezone
from pathlib import Path

import requests

ROOT = Path(__file__).resolve().parent.parent
CONFIG_JSON = ROOT / "config.json"

# Polar's API base is the bare host; request paths already start with /v1/.
DEFAULT_API_BASE = "https://api.polar.sh"
MAX_RETRIES = 5

# Date-based API version sent on every request as Polar-Version. Unversioned
# requests follow Polar's Current version, which changes each quarter; a pinned
# version keeps the discount payload shapes below stable. An unknown or removed
# version returns HTTP 404 (2026-04 is removed at the January 2027 release).
DEFAULT_API_VERSION = "2026-04"

# Australia/Brisbane is UTC+10 all year — no daylight saving to account for.
BRISBANE = timezone(timedelta(hours=10))


def die(message: str) -> None:
    print(f"fatal: {message}", file=sys.stderr)
    raise SystemExit(1)


def read_config() -> dict:
    if not CONFIG_JSON.exists():
        die(f"{CONFIG_JSON.name} not found at {CONFIG_JSON}")
    with CONFIG_JSON.open(encoding="utf-8") as handle:
        return json.load(handle)


def parse_local_date(value: str, end_of_day: bool) -> datetime:
    # parses DD/MM/YYYY (Australia/Brisbane) into a UTC datetime
    parts = str(value or "").split("/")
    if len(parts) != 3:
        die(f"invalid date {value!r} — expected DD/MM/YYYY")
    try:
        day, month, year = (int(part) for part in parts)
        time_parts = (23, 59, 59) if end_of_day else (0, 0, 0)
        local = datetime(year, month, day, *time_parts, tzinfo=BRISBANE)
    except ValueError as error:
        die(f"invalid date {value!r}: {error}")
    return local.astimezone(timezone.utc)


def iso_z(moment: datetime) -> str:
    # formats a UTC datetime as the ISO-8601 "Z" form Polar expects
    return moment.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def product_ids(config: dict, slugs) -> list:
    # maps config item slugs to the real Polar product ids
    if not isinstance(slugs, list):
        die('discount.products must be "ALL" or a list of item slugs')
    by_slug = {item.get("slug"): item for item in config.get("items", [])}
    ids: list = []
    for slug in slugs:
        item = by_slug.get(slug)
        if item is None:
            die(f"discount.products lists the unknown slug {slug!r}")
        product_id = (item.get("product_id") or "").strip()
        if not product_id:
            die(f"item {slug!r} has no product_id — a product-list discount needs the real Polar product ids")
        ids.append(product_id)
    return ids


def build_payload(config: dict):
    # turns the config.json discount block into the POST /v1/discounts/ body
    discount = config.get("discount")
    if not discount:
        return None

    amount = discount.get("amount")
    code = (discount.get("code") or "").strip()
    if not isinstance(amount, int) or isinstance(amount, bool) or not 1 <= amount <= 100:
        die(f"discount.amount must be a whole number from 1 to 100, got {amount!r}")
    if not code:
        die("discount.code is required")
    if not code.isalnum():
        die(f"discount.code {code!r} must be alphanumeric")
    if not 3 <= len(code) <= 256:
        die(f"discount.code {code!r} must be 3-256 characters")

    payload = {
        "name": discount.get("name") or f"{amount}% off — {code}",
        "type": "percentage",
        "basis_points": amount * 100,
        "duration": "once",
        "code": code,
        "starts_at": iso_z(parse_local_date(discount.get("start"), end_of_day=False)),
        "ends_at": iso_z(parse_local_date(discount.get("end"), end_of_day=True)),
    }

    products = discount.get("products")
    if products != "ALL":
        payload["products"] = product_ids(config, products)

    return payload


class Polar:
    # minimal Polar API client for the discounts endpoints

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

    def list_discounts(self) -> list:
        # every discount in the organization, following pagination
        out: list = []
        page = 1
        while True:
            params = {"page": page, "limit": 100}
            if self.organization_id:
                params["organization_id"] = self.organization_id
            data = self._request("GET", "/v1/discounts/", params=params)
            out.extend((data.get("items") if isinstance(data, dict) else data) or [])
            pagination = data.get("pagination") if isinstance(data, dict) else None
            next_page = pagination.get("next_page") if isinstance(pagination, dict) else None
            if not next_page:
                break
            page = next_page
        return out

    def delete_discount(self, discount_id: str) -> None:
        # removes a discount so its code can be recreated without duplicating
        self._request("DELETE", f"/v1/discounts/{discount_id}")

    def create_discount(self, payload: dict) -> dict:
        body = dict(payload)
        if self.organization_id:
            body["organization_id"] = self.organization_id
        return self._request("POST", "/v1/discounts/", json_body=body)


def main() -> int:
    parser = argparse.ArgumentParser(description="Create the Polar discount described by config.json.")
    parser.add_argument("--dry-run", action="store_true", help="print the payload without calling Polar")
    args = parser.parse_args()

    payload = build_payload(read_config())
    if payload is None:
        print("config.json has no discount block — nothing to do")
        return 0

    print(f"discount: {payload['name']} | {payload['code']} | {payload['starts_at']} -> {payload['ends_at']}")
    if payload["ends_at"] < iso_z(datetime.now(timezone.utc)):
        print("warning: this discount window has already ended — Polar may reject it", file=sys.stderr)

    if args.dry_run:
        print("dry-run: payload for POST /v1/discounts/")
        print(json.dumps(payload, indent=2))
        return 0

    api_key = (os.environ.get("POLAR_ACCESS_TOKEN") or "").strip()
    if not api_key:
        die("POLAR_ACCESS_TOKEN is not set")
    api = Polar(api_key, os.environ.get("POLAR_API_BASE") or DEFAULT_API_BASE,
                (os.environ.get("POLAR_ORGANIZATION_ID") or "").strip() or None,
                (os.environ.get("POLAR_API_VERSION") or "").strip() or DEFAULT_API_VERSION)

    try:
        existing = [d for d in api.list_discounts() if (d.get("code") or "") == payload["code"]]
    except RuntimeError as error:
        die(f"could not list existing discounts: {error}")

    for discount in existing:
        try:
            api.delete_discount(discount["id"])
        except RuntimeError as error:
            die(f"could not delete existing discount {discount.get('id')}: {error}")
        print(f"removed existing discount {discount['id']} with code {payload['code']}")

    try:
        created = api.create_discount(payload)
    except RuntimeError as error:
        die(f"could not create the discount: {error}")

    print(f"created discount {created.get('id')} | {created.get('code')} | "
          f"{created.get('basis_points')} basis points | {created.get('starts_at')} -> {created.get('ends_at')}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
