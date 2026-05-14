"""
Pipedrive API integration — fetch organization data by name.
Uses exact API search first, then fuzzy matching against cached org list.
"""
import os
import re
import asyncio
from typing import Optional

import httpx
from dotenv import load_dotenv

load_dotenv()

PIPEDRIVE_TOKEN  = os.getenv("PIPEDRIVE_TOKEN", "")
PIPEDRIVE_DOMAIN = os.getenv("PIPEDRIVE_DOMAIN", "")

# In-memory cache: list of all Pipedrive orgs (loaded once)
_org_cache: list[dict] = []
_cache_lock = asyncio.Lock()
_cache_loaded = False

# Cache for full org details (org_id → details dict)
_detail_cache: dict[int, dict] = {}

# Cache for supplier_name → result (avoids repeated fuzzy search + fetch)
_supplier_cache: dict[str, dict] = {}


def _base() -> str:
    domain = PIPEDRIVE_DOMAIN.strip().rstrip("/")
    if not domain:
        return ""
    if not domain.startswith("http"):
        domain = f"https://{domain}.pipedrive.com"
    return domain


EMAIL_RE = re.compile(r'[\w.+-]+@[\w.-]+\.[a-z]{2,}', re.I)
# Emails belonging to the user's own company — skip these as supplier contacts
OWN_DOMAINS = {"provitax.pl", "provitax.com"}


def _normalize(name: str) -> str:
    """Strip noise so 'FENCHEM.COM' ≈ 'Fenchem', 'BART.PL' ≈ 'Bart Sp. z o.o.',
    'AmitaHC' ≈ 'Amita HC'."""
    name = name.lower()
    # Insert space before uppercase run following lowercase (AmitaHC → amita hc)
    name = re.sub(r'([a-z])([A-Z])', r'\1 \2', name)
    name = re.sub(r'\.(pl|com|eu|net|org|de|fr|cn)\b', '', name)
    name = re.sub(r'\(.*?\)', '', name)
    name = re.sub(r'\b(sp\.?\s*z\.?\s*o\.?\s*o\.?|sp\.?\s*j\.?|s\.?c\.?|ltd\.?|gmbh|inc\.?)\b', '', name)
    name = re.sub(r'[^a-z0-9 ]', ' ', name)
    return re.sub(r'\s+', ' ', name).strip()


def _is_own_email(email: str) -> bool:
    """Return True if email belongs to the user's own company (not supplier)."""
    domain = email.lower().split("@")[-1] if "@" in email else ""
    return domain in OWN_DOMAINS


async def _ensure_cache(client: httpx.AsyncClient) -> None:
    """Fetch all orgs from Pipedrive and store in _org_cache (once per process)."""
    global _org_cache, _cache_loaded
    async with _cache_lock:
        if _cache_loaded:
            return
        orgs: list[dict] = []
        start = 0
        while True:
            try:
                r = await client.get(
                    f"{_base()}/v1/organizations",
                    params={"api_token": PIPEDRIVE_TOKEN, "limit": 500, "start": start},
                    timeout=12,
                )
                r.raise_for_status()
                data = r.json()
                batch = data.get("data") or []
                orgs.extend(batch)
                more = data.get("additional_data", {}).get("pagination", {}).get("more_items_in_collection")
                if not more:
                    break
                start += 500
            except Exception:
                break
        _org_cache = orgs
        _cache_loaded = True


def _fuzzy_match(name: str) -> Optional[dict]:
    """Return best-matching org from cache, or None if below threshold."""
    if not _org_cache:
        return None
    try:
        from rapidfuzz import fuzz, process
    except ImportError:
        return None

    norm_q = _normalize(name)
    if not norm_q:
        return None

    norm_map = {_normalize(o["name"]): o for o in _org_cache}
    keys = list(norm_map.keys())

    # token_sort_ratio — handles word-order and camelCase split (AmitaHC → Amita HC)
    best = process.extractOne(norm_q, keys, scorer=fuzz.token_sort_ratio)
    if best and best[1] >= 70:
        return norm_map[best[0]]

    # partial_ratio fallback — one name fully contained in other
    best2 = process.extractOne(norm_q, keys, scorer=fuzz.partial_ratio)
    if best2 and best2[1] >= 86:
        return norm_map[best2[0]]

    # WRatio fallback — catches more variants
    best3 = process.extractOne(norm_q, keys, scorer=fuzz.WRatio)
    if best3 and best3[1] >= 85:
        return norm_map[best3[0]]

    return None


def _parse_persons(persons_raw: list) -> list[dict]:
    """Normalize a list of raw Pipedrive person objects."""
    result = []
    for p in persons_raw:
        phones = [ph["value"] for ph in (p.get("phone") or []) if ph.get("value")]
        emails = [em["value"] for em in (p.get("email") or []) if em.get("value")]
        result.append({
            "name":  p.get("name"),
            "phone": phones[0] if phones else None,
            "email": emails[0] if emails else None,
            "title": p.get("job_title"),
        })
    return result


async def _search_persons_by_org_name(org_name: str, client: httpx.AsyncClient) -> list[dict]:
    """Search persons by org name — fallback when org has no linked persons."""
    try:
        r = await client.get(
            f"{_base()}/v1/persons/search",
            params={
                "api_token": PIPEDRIVE_TOKEN,
                "term": org_name,
                "fields": "organization",
                "limit": 10,
            },
            timeout=8,
        )
        r.raise_for_status()
        items = r.json().get("data", {}).get("items", []) or []
        persons_raw = []
        for item in items:
            p = item.get("item", {})
            # Only include if org name roughly matches
            p_org = (p.get("organization") or {}).get("name", "")
            if _normalize(p_org) and _normalize(org_name):
                try:
                    from rapidfuzz import fuzz
                    score = fuzz.token_sort_ratio(_normalize(p_org), _normalize(org_name))
                    if score < 60:
                        continue
                except ImportError:
                    pass
            phones = [ph["value"] for ph in (p.get("phones") or []) if ph.get("value")]
            emails = [em["value"] for em in (p.get("emails") or []) if em.get("value")]
            persons_raw.append({
                "name":  p.get("name"),
                "phone": phones[0] if phones else None,
                "email": emails[0] if emails else None,
                "title": None,
            })
        return persons_raw
    except Exception:
        return []


async def _fetch_org_details(org_id: int, client: httpx.AsyncClient) -> Optional[dict]:
    """Fetch org details + all available contacts using multiple strategies."""
    try:
        r = await client.get(
            f"{_base()}/v1/organizations/{org_id}",
            params={"api_token": PIPEDRIVE_TOKEN},
            timeout=8,
        )
        r.raise_for_status()
        org = r.json().get("data", {})
        org_name = org.get("name", "")

        # Strategy 1: persons directly linked to the org
        rp = await client.get(
            f"{_base()}/v1/organizations/{org_id}/persons",
            params={"api_token": PIPEDRIVE_TOKEN, "limit": 20},
            timeout=8,
        )
        rp.raise_for_status()
        persons = _parse_persons(rp.json().get("data") or [])

        # Strategy 2: if still empty, search persons by org name
        if not persons and org_name:
            persons = await _search_persons_by_org_name(org_name, client)

        # Strategy 3: scan notes for email addresses
        if not persons:
            try:
                rn = await client.get(
                    f"{_base()}/v1/notes",
                    params={"api_token": PIPEDRIVE_TOKEN, "org_id": org_id, "limit": 20},
                    timeout=8,
                )
                rn.raise_for_status()
                notes_data = rn.json().get("data") or []
                note_emails = []
                for note in notes_data:
                    content = re.sub(r'<[^>]+>', ' ', note.get("content", "") or "")
                    for email in EMAIL_RE.findall(content):
                        if not _is_own_email(email) and email not in note_emails:
                            note_emails.append(email)
                if note_emails:
                    persons = [{
                        "name":   org_name,
                        "phone":  None,
                        "email":  email,
                        "title":  "E-mail z notatek Pipedrive",
                        "internal": False,
                    } for email in note_emails[:3]]
            except Exception:
                pass

        # Strategy 4: show Pipedrive owner (internal user) as absolute last resort
        if not persons:
            owner = org.get("owner_id") or {}
            owner_email = owner.get("email") if isinstance(owner, dict) else None
            owner_name  = owner.get("name")  if isinstance(owner, dict) else None
            # Only show owner if their email is NOT from our own company
            if owner_name and owner_email and not _is_own_email(owner_email):
                persons = [{
                    "name":   owner_name,
                    "phone":  None,
                    "email":  owner_email,
                    "title":  "Opiekun w Pipedrive",
                    "internal": True,
                }]
            elif owner_name and not owner_email:
                persons = [{
                    "name":   owner_name,
                    "phone":  None,
                    "email":  None,
                    "title":  "Opiekun w Pipedrive",
                    "internal": True,
                }]

        # Extract website from org fields
        website = ""
        for f in (org.get("custom_fields") or []):
            if "web" in str(f.get("key", "")).lower():
                website = f.get("value", "")
                break
        if not website:
            website = org.get("cc_email") or ""

        return {
            "id":      org.get("id"),
            "name":    org_name,
            "address": org.get("address"),
            "website": website,
            "persons": persons,
        }
    except Exception:
        return None


async def get_supplier_pipedrive(supplier_name: str) -> dict:
    """
    Main entry point.
    1. Check in-memory supplier cache.
    2. Try exact Pipedrive search API.
    3. Fall back to fuzzy match against cached org list.
    Returns dict with 'found': True/False.
    """
    if not PIPEDRIVE_TOKEN or not _base():
        return {"found": False, "reason": "not_configured"}

    # Fast path: supplier already resolved
    if supplier_name in _supplier_cache:
        return _supplier_cache[supplier_name]

    async with httpx.AsyncClient(timeout=10) as client:
        await _ensure_cache(client)

        # Step 1 — exact search
        org = None
        try:
            r = await client.get(
                f"{_base()}/v1/organizations/search",
                params={"term": supplier_name, "api_token": PIPEDRIVE_TOKEN, "limit": 5},
            )
            r.raise_for_status()
            items = r.json().get("data", {}).get("items", [])
            if items:
                org = items[0].get("item")
        except Exception:
            pass

        # Step 2 — fuzzy match fallback
        if not org:
            org = _fuzzy_match(supplier_name)

        if not org:
            result = {"found": False}
            _supplier_cache[supplier_name] = result
            return result

        # Fetch full details (with per-org cache)
        org_id = org["id"]
        if org_id in _detail_cache:
            details = _detail_cache[org_id]
        else:
            details = await _fetch_org_details(org_id, client)
            if details:
                _detail_cache[org_id] = details

        if not details:
            result = {"found": False}
            _supplier_cache[supplier_name] = result
            return result

        result = {**details, "found": True}
        _supplier_cache[supplier_name] = result
        return result


def invalidate_cache() -> None:
    """Call this after saving new Pipedrive credentials so all caches refresh."""
    global _cache_loaded, _org_cache, _detail_cache, _supplier_cache
    _org_cache = []
    _detail_cache = {}
    _supplier_cache = {}
    _cache_loaded = False
