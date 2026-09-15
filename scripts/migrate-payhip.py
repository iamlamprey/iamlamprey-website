#!/usr/bin/env python3
"""Migrate Payhip orders into Polar customers + product grants.

Reads the API key from keys.txt, walks the Payhip order export, and for every
unique customer creates a Polar customer (create-customer) then grants each
purchased product with a free subscription (create-subscription). Product ids come
from config.json (an item's legacy_product_id, falling back to product_id).

By default it reads scripts/orders-payhip-test.csv; pass --full to read
scripts/orders-payhip.csv.

keys.txt layout (first non-blank, non-# line = API key; extra key=value lines):
    polar_oat_xxx
    api_base=https://sandbox-api.polar.sh   # optional, defaults to production
    organization_id=...                     # optional

keys.txt is looked for in the repo root or in scripts/. Run from anywhere.

    python scripts/migrate-payhip.py --dry-run         # test CSV, no API calls
    python scripts/migrate-payhip.py --limit 3         # test CSV, a few rows
    python scripts/migrate-payhip.py --full            # full export
"""

import csv
import json
import os
import sys
import time
from pathlib import Path

import requests

try:
    from tqdm import tqdm
except ImportError:  # pragma: no cover
    def tqdm(iterable, **kwargs):
        return iterable

    print("note: tqdm is not installed (pip install tqdm) — progress bars disabled", file=sys.stderr)

ROOT = Path(__file__).resolve().parent.parent
KEYS_FILE = ROOT / "keys.txt"
KEYS_FILE_ALT = Path(__file__).resolve().parent / "keys.txt"
PAYHIP_CSV_TEST = ROOT / "scripts" / "orders-payhip-test.csv"
PAYHIP_CSV_FULL = ROOT / "scripts" / "orders-payhip.csv"
CATALOG_JSON = ROOT / "config.json"

# Polar's API base is the bare host; request paths already start with /v1/.
DEFAULT_API_BASE = "https://api.polar.sh"
MAX_RETRIES = 5

# Date-based API version sent on every request as Polar-Version. Unversioned
# requests follow Polar's Current version, which changes each quarter; a pinned
# version keeps the discount payload shapes below stable. An unknown or removed
# version returns HTTP 404 (2026-04 is removed at the January 2027 release).
DEFAULT_API_VERSION = "2026-04"


def die(message: str) -> None:
    print(f"fatal: {message}", file=sys.stderr)
    raise SystemExit(1)


def parse_keys(path: Path) -> tuple[str, dict]:
    key = None
    extra: dict[str, str] = {}
    for line in path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line or line.startswith("#"):
            continue
        if key is None:
            key = line
        elif "=" in line:
            k, v = line.split("=", 1)
            extra[k.strip().lower()] = v.strip()
    if not key:
        die(f"{path} contains no API key on its first line")
    return key, extra


def read_keys() -> tuple[str, dict]:
    for candidate in (KEYS_FILE, KEYS_FILE_ALT):
        if candidate.exists():
            return parse_keys(candidate)
    die(f"keys.txt not found (looked in {ROOT} and scripts/)")


def read_catalog() -> dict:
    with CATALOG_JSON.open(encoding="utf-8") as handle:
        return json.load(handle)


def read_orders(path: Path) -> list[dict]:
    if not path.exists():
        die(f"{path.name} not found at {path}")
    with path.open(encoding="utf-8-sig", newline="") as handle:
        return list(csv.DictReader(handle))


def split_products(value: str) -> list[str]:
    return [part.strip() for part in (value or "").split(",") if part.strip()]


def normalize_email(value: str) -> str:
    return (value or "").strip().lower()


class Polar:
    def __init__(self, api_key: str, api_base: str, organization_id: str | None = None,
                 api_version: str = DEFAULT_API_VERSION):
        self.api_base = self._normalize_base(api_base)
        self.organization_id = organization_id
        self.api_key = api_key
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
                self.session.headers["Authorization"] = self.api_key
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

    def paginate(self, path: str, extra_params: dict | None = None) -> list[dict]:
        out: list[dict] = []
        page = 1
        while True:
            params = {"page": page, "limit": 100}
            if extra_params:
                params.update(extra_params)
            data = self._request("GET", path, params=params)
            if isinstance(data, dict):
                out.extend(data.get("items") or [])
                pagination = data.get("pagination") or {}
                next_page = pagination.get("next_page") if isinstance(pagination, dict) else None
                if next_page is None:
                    next_page = data.get("next_page")
            else:
                out.extend(data or [])
                next_page = None
            if not next_page:
                break
            page = next_page
        return out

    def create_customer(self, email: str, name: str | None, metadata: dict | None) -> dict:
        body: dict = {"email": email, "external_id": email}
        if name:
            body["name"] = name
        if metadata:
            body["metadata"] = metadata
        if self.organization_id:
            body["organization_id"] = self.organization_id
        return self._request("POST", "/v1/customers/", json_body=body)

    def list_customers(self) -> list[dict]:
        params = {"organization_id": self.organization_id} if self.organization_id else None
        return self.paginate("/v1/customers/", params)

    def create_subscription(self, customer_id: str, product_id: str) -> dict:
        body: dict = {"customer_id": customer_id, "product_id": product_id}
        if self.organization_id:
            body["organization_id"] = self.organization_id
        return self._request("POST", "/v1/subscriptions/", json_body=body)

    def list_subscriptions(self) -> list[dict]:
        params = {"organization_id": self.organization_id} if self.organization_id else None
        return self.paginate("/v1/subscriptions/", params)


def build_plan(catalog: dict, rows: list[dict]) -> tuple[dict[str, dict], list[str]]:
    display = catalog.get("displayNames", {})
    items_by_slug = {item["slug"]: item for item in catalog.get("items", [])}

    def grant_id(item: dict) -> str:
        return (item.get("legacy_product_id") or item.get("product_id") or "").strip()

    customers: dict[str, dict] = {}
    warnings: list[str] = []

    for row in rows:
        email = normalize_email(row.get("Email"))
        if not email:
            warnings.append("skipped a row without an email")
            continue
        record = customers.setdefault(email, {
            "name": " ".join(filter(None, [(row.get("First Name") or "").strip(),
                                            (row.get("Last Name") or "").strip()])) or None,
            "order_ids": [],
            "grant_ids": [],
        })
        order_id = (row.get("Order ID") or "").strip()
        if order_id and order_id not in record["order_ids"]:
            record["order_ids"].append(order_id)

        for product_name in split_products(row.get("Items In Cart")):
            slug = display.get(product_name)
            if not slug:
                warnings.append(f"unknown product '{product_name}' (email={email}); not granted")
                continue
            item = items_by_slug.get(slug)
            if not item:
                warnings.append(f"no catalog item for slug '{slug}' (email={email}); not granted")
                continue
            gid = grant_id(item)
            if not gid:
                warnings.append(f"item '{slug}' has no product_id/legacy_product_id in config.json; not granted")
                continue
            if gid not in record["grant_ids"]:
                record["grant_ids"].append(gid)

    return customers, warnings


def main() -> int:
    import argparse
    parser = argparse.ArgumentParser(description="Migrate Payhip customers into Polar.")
    parser.add_argument("--dry-run", action="store_true", help="show the plan without calling Polar")
    parser.add_argument("--full", action="store_true", help="use the full export instead of the test CSV")
    parser.add_argument("--limit", type=int, default=None, help="only process the first N order rows")
    args = parser.parse_args()

    orders_path = PAYHIP_CSV_FULL if args.full else PAYHIP_CSV_TEST
    print(f"source: {orders_path}")

    rows = read_orders(orders_path)
    if args.limit is not None:
        rows = rows[: args.limit]
    catalog = read_catalog()

    customers, warnings = build_plan(catalog, rows)

    if args.dry_run:
        print(f"dry-run: {len(customers)} unique customer(s), no API calls")
        for warning in warnings:
            print(f"  warn: {warning}")
        for email, record in sorted(customers.items()):
            print(f"  {email} | {record['name'] or '-'} | {len(record['order_ids'])} order(s) "
                  f"| grants: {len(record['grant_ids'])} -> {record['grant_ids'] or '-'}")
        return 0

    api_key, extra = read_keys()
    api_base = extra.get("api_base") or DEFAULT_API_BASE
    org_id = extra.get("organization_id") or None
    api = Polar(api_key, api_base, org_id,
                (os.environ.get("POLAR_API_VERSION") or "").strip() or DEFAULT_API_VERSION)

    print(f"loading existing customers and subscriptions from {api.api_base} …")
    try:
        existing = {normalize_email(c.get("email") or ""): c for c in api.list_customers()}
        granted = {(s.get("customer_id"), s.get("product_id")) for s in api.list_subscriptions()}
    except RuntimeError as error:
        die(f"could not load existing Polar data: {error}")

    created_customers = 0
    reused_customers = 0
    created_grants = 0
    already_granted = 0

    total_grants = sum(len(record["grant_ids"]) for record in customers.values())

    progress = tqdm(sorted(customers.items()), desc="Migrating", unit="cust")
    for email, record in progress:
        customer = existing.get(email)
        if customer:
            customer_id = customer.get("id")
            reused_customers += 1
        else:
            metadata = {"payhip_order_ids": ",".join(record["order_ids"])} if record["order_ids"] else None
            try:
                created = api.create_customer(email, record["name"], metadata)
            except RuntimeError as error:
                tqdm.write(f"  error: customer {email}: {error}")
                continue
            customer_id = created.get("id")
            if not customer_id:
                tqdm.write(f"  error: customer {email} returned no id: {created}")
                continue
            existing[email] = created
            created_customers += 1

        for product_id in record["grant_ids"]:
            if (customer_id, product_id) in granted:
                already_granted += 1
                continue
            try:
                api.create_subscription(customer_id, product_id)
                granted.add((customer_id, product_id))
                created_grants += 1
            except RuntimeError as error:
                tqdm.write(f"  error: grant {email} -> {product_id}: {error}")

        progress.set_postfix(created=created_customers, reused=reused_customers,
                             grants=f"{created_grants}/{total_grants}")

    progress.close()

    for warning in warnings:
        print(f"  warn: {warning}")
    print(f"done: customers created={created_customers}, reused={reused_customers}, "
          f"grants created={created_grants}, already_granted={already_granted}")

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
