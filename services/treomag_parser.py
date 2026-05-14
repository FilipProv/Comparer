"""
Parsers for the three files in the 'treomag' quotation folder:
  - amita hc.txt    → prices in EUR/kg
  - Emma trade.txt  → prices in USD / EUR / PLN (mixed)
  - KH_Portfolio_Brochure-MC-25-22490.pdf → Kemin product brochure, NO prices

Returns a list of dicts:
  {supplier, product_name, price_original, currency, unit,
   price_per_kg_orig, moq, tiers, notes, category, lead_time}
"""

from __future__ import annotations
import re
from pathlib import Path

FOLDER = Path(r"C:\Users\Dell\Downloads\treomag")

# ──────────────────────────────────────────────────────────────
# Category mapping — keyword → category
# ──────────────────────────────────────────────────────────────
CATEGORY_MAP: list[tuple[str, list[str]]] = [
    ("Witaminy",          ["vitamin", "witamina"]),
    ("Kwasy hialuronowe", ["hyaluronat", "hyaluronic", "sinohyal", "kwas hialur"]),
    ("Kolagen i stawy",   ["collagen", "kolagen", "glucosamine", "chondroitin", "msm",
                           "methylsulfonyl"]),
    ("Astaksantyna",      ["astaxanthin", "astapure"]),
    ("Grzyby lecznicze",  ["cordyceps", "coriolus", "turkey tail", "trametes"]),
    ("Ekstrakty ziołowe", ["ashwagandh", "ginseng", "berberin", "griffonia", "milk thistle",
                           "silymarin", "bromelain", "papain", "turmeric", "piperine",
                           "spirulina", "shilajit", "beetroot", "ginger"]),
    ("Antyoksydanty",     ["coenzyme q10", "coq10", "ubiquinon", "alpha lipoic", "lipoic",
                           "melatonin", "n-acetyl", "nac", "sodium hyaluron"]),
    ("Aminokwasy / inne", ["citicoline", "creatine", "sodium butyrat", "kreatin",
                           "magnesium", "chromium", "iodine", "potassium iodid", "zinc",
                           "lithium", "iron", "pregnenolone", "noopept", "inulin",
                           "maltodextrin", "cellulose", "microcrystalline"]),
]


def _categorise(name: str) -> str:
    low = name.lower()
    for cat, keywords in CATEGORY_MAP:
        if any(k in low for k in keywords):
            return cat
    return "Pozostałe"


# ──────────────────────────────────────────────────────────────
# Shared price-extraction helpers
# ──────────────────────────────────────────────────────────────

_PRICE_RE = re.compile(
    r"([\d]+[\d\s]*[,.]?[\d]*)"      # numeric amount (may have spaces or comma)
    r"\s*"
    r"(euro|eur|e(?=[/\s])|usd|\$|zł|zl|pln)"  # currency
    r"(?:\s*/?\s*(kg|g|100g))?"       # optional unit
    r"(?:\s*za\s*(100g|kg))?",        # optional "za Xg" normaliser
    re.IGNORECASE,
)

_MOQ_RE = re.compile(
    r"\bMOQ\s*:?\s*([\d]+)\s*(?:kg|g)?\b",
    re.IGNORECASE,
)

_TIER_RE = re.compile(
    r"([\d]+)\s*kg\s*[–\-]+\s*([\d]+[,.]?[\d]*)\s*(euro|eur|e\b|usd|\$|zł|zl|pln)(?:/kg)?",
    re.IGNORECASE,
)


def _parse_price_str(text: str) -> tuple[float | None, str, str]:
    """Return (price_per_kg, currency, raw_match) or (None,'','')."""
    m = _PRICE_RE.search(text)
    if not m:
        return None, "", ""
    raw_num = m.group(1).replace(" ", "").replace(",", ".")
    try:
        num = float(raw_num)
    except ValueError:
        return None, "", ""

    cur_raw = m.group(2).lower()
    unit_raw = (m.group(3) or "kg").lower()
    za_raw = (m.group(4) or "").lower()

    if cur_raw in ("euro", "eur", "e"):
        currency = "EUR"
    elif cur_raw in ("usd", "$"):
        currency = "USD"
    else:
        currency = "PLN"

    # Normalise to per-kg
    if za_raw == "100g" or unit_raw == "100g":
        num = round(num * 10, 4)

    return round(num, 4), currency, m.group(0)


def _extract_moq(text: str) -> float | None:
    m = _MOQ_RE.search(text)
    if m:
        try:
            return float(m.group(1))
        except ValueError:
            pass
    return None


def _extract_lead_time(text: str) -> str:
    patterns = [r"(\d+[-–]\d+\s*tyg\w*)", r"(\d+\s*tyg\w*)", r"(stok)", r"(w drodze)"]
    for p in patterns:
        m = re.search(p, text, re.IGNORECASE)
        if m:
            return m.group(1)
    return ""


# ──────────────────────────────────────────────────────────────
# Parser: amita hc.txt
# ──────────────────────────────────────────────────────────────

def parse_amita(text: str) -> list[dict]:
    """
    Lines look like:
      PRODUCT (MOQ Xkg) – PRICE euro/kg
          Xkg – PRICE euro/kg          ← tier line (indented)
    """
    products: list[dict] = []
    current: dict | None = None

    for raw_line in text.splitlines():
        line = raw_line.strip()
        if not line:
            continue

        price, currency, _ = _parse_price_str(line)

        # Tier line: "100kg – 59,2 euro/kg"  (starts with a number + kg)
        tier_m = _TIER_RE.match(line)
        if tier_m and current is not None:
            tier_qty = float(tier_m.group(1))
            tier_price_str = tier_m.group(2).replace(",", ".")
            tier_cur_raw = tier_m.group(3).lower()
            tier_cur = "EUR" if tier_cur_raw in ("euro", "eur", "e") else (
                "USD" if tier_cur_raw in ("usd", "$") else "PLN")
            try:
                current["tiers"].append({
                    "moq": tier_qty,
                    "price": round(float(tier_price_str), 4),
                    "currency": tier_cur,
                })
            except (ValueError, KeyError):
                pass
            continue

        # Main product line must have a price
        if price is None:
            continue

        # Extract product name — everything before the first "(" or "–"
        name_part = re.split(r"[–\-]\s*\d|\(MOQ", line)[0].strip()
        name_part = re.sub(r"\s+", " ", name_part).strip(" –-")
        if not name_part or len(name_part) < 4:
            continue

        moq = _extract_moq(line)

        current = {
            "supplier": "AMITA HC",
            "product_name": name_part,
            "price_original": price,
            "currency": currency,
            "unit": "kg",
            "moq": moq,
            "tiers": [],
            "notes": "",
            "lead_time": "5-6 tygodni",
            "category": _categorise(name_part),
        }
        products.append(current)

    return products


# ──────────────────────────────────────────────────────────────
# Parser: Emma trade.txt
# ──────────────────────────────────────────────────────────────

def parse_emma(text: str) -> list[dict]:
    """
    Lines look like:
      Product name – qty – [notes –] PRICE currency[/unit] – lead_time
    """
    products: list[dict] = []
    current_section = ""

    for raw_line in text.splitlines():
        line = raw_line.strip()
        if not line:
            continue

        # Section headers (no price, ends with ":")
        if line.endswith(":") and not any(c in line for c in ["usd", "eur", "zł", "$"]):
            current_section = line.rstrip(":")
            continue

        # Skip lines that are clearly not product lines
        if re.match(r"^(Panie|Pan|Dopis|Wiadomo|Nie|https?://)", line, re.IGNORECASE):
            continue

        price, currency, price_match = _parse_price_str(line)
        if price is None:
            continue

        # Extract product name = text before first " – " or " - " dash separator
        name_part = re.split(r"\s+[–\-]+\s+", line)[0].strip()
        name_part = re.sub(r"\s+", " ", name_part).strip()

        # Remove leading bullet / section noise
        name_part = re.sub(r"^[\s\-•]+", "", name_part).strip()
        if not name_part or len(name_part) < 3:
            continue

        # Skip obvious non-product lines
        if any(w in name_part.lower() for w in ["wiadom", "panie", "proszę", "nie oferu"]):
            continue

        moq = _extract_moq(line)
        # Try to infer MOQ from quantity mentioned in line (e.g. "25 kg –")
        if moq is None:
            qty_m = re.search(r"–\s*([\d]+)\s*kg\b", line)
            if qty_m:
                moq = float(qty_m.group(1))

        lead_time = _extract_lead_time(line)

        # Detect if price is "nie oferujemy" / skip
        if re.search(r"nie oferu|nie handluj", line, re.IGNORECASE):
            continue

        # Build tiers from comma-separated prices within same line
        tiers: list[dict] = []
        # e.g. "1 kg – 1100zł, 5 kg – 720zł/kg"
        for tier_m in re.finditer(
            r"([\d]+)\s*kg\s*[–\-]+\s*([\d,. ]+)\s*(zł|pln|usd|\$|eur|e\b|euro)(?:/kg)?",
            line, re.IGNORECASE
        ):
            try:
                t_qty = float(tier_m.group(1))
                t_price = float(tier_m.group(2).replace(",", ".").replace(" ", ""))
                t_cur_raw = tier_m.group(3).lower()
                t_cur = "PLN" if t_cur_raw in ("zł", "pln") else (
                    "EUR" if t_cur_raw in ("eur", "e", "euro") else "USD")
                tiers.append({"moq": t_qty, "price": t_price, "currency": t_cur})
            except ValueError:
                pass

        notes_parts = []
        if "stok" in line.lower():
            notes_parts.append("na stanie")
        if "w drodze" in line.lower():
            notes_parts.append("w drodze")

        products.append({
            "supplier": "EMMA TRADE",
            "product_name": name_part,
            "price_original": price,
            "currency": currency,
            "unit": "kg",
            "moq": moq,
            "tiers": tiers,
            "notes": "; ".join(notes_parts),
            "lead_time": lead_time,
            "category": _categorise(name_part) if not current_section else _categorise(name_part),
        })

    return products


# ──────────────────────────────────────────────────────────────
# Match products across suppliers
# ──────────────────────────────────────────────────────────────

# ──────────────────────────────────────────────────────────────
# Synonym groups — words/phrases that refer to the same ingredient
# Each tuple is a set of synonyms; any word from a tuple produces
# the same canonical tag (the first element of the tuple).
# ──────────────────────────────────────────────────────────────
SYNONYM_GROUPS: list[tuple[str, ...]] = [
    # vitamins
    ("vitamin a",   "retinyl acetate", "retinol acetate"),
    ("vitamin b1",  "thiamine"),
    ("vitamin b2",  "riboflavin"),
    ("vitamin b3",  "niacin", "nicotinic acid"),
    ("vitamin b5",  "pantothenate", "pantothen"),
    ("vitamin b6",  "pyridoxal hcl", "pyridoxine hcl"),
    ("vitamin b6p5p", "pyridoxal-5", "pyridoxal-5′-phosphate", "p5p"),
    ("vitamin b7",  "biotin", "d-biotin"),
    ("vitamin b9",  "folic acid", "folate", "methyltetrahydrofolate"),
    ("vitamin b12", "methylcobalamin", "cobalamin"),
    ("vitamin d3",  "cholecalciferol"),
    ("vitamin k2mk7", "k2 mk-7", "k2 mk7", "mk-7", "mk7"),
    ("vitamin k2mk4", "k2 mk-4", "mk-4"),
    # minerals
    ("chromium picolinate",),
    ("potassium iodide", "iodine", "potassium iodid"),
    ("lithium orotate",),
    ("zinc picolinate",),
    ("magnesium l-threonate", "magnesium threonat"),
    ("magnesium diglycinate", "magnesium diglicyn"),
    ("iron fumarat", "iron fumaran", "fumaran żelaza"),
    # extracts / botanicals
    ("ashwagandh", "ashwaganda"),            # typo fix
    ("ginseng",),
    ("berberine", "berberin"),
    ("griffonia", "5-htp"),
    ("milk thistle", "silymarin"),
    ("alpha lipoic acid", "lipoic acid"),
    ("coenzyme q10", "coq10", "ubiquinon"),
    ("melatonin", "melatonina"),
    ("n-acetyl-l-cysteine", "n-acetyl", "nac"),
    ("hyaluronic acid", "hyaluronat", "sinohyal", "sodium hyaluron", "kwas hialur"),
    ("bromelain",),
    ("cordyceps",),
    ("coriolus", "turkey tail", "trametes versicolor"),
    ("astaxanthin", "astapure"),
    ("citicoline", "cytykolina"),
    ("creatine", "kreatin"),
    ("inulin", "inulina"),
    ("spirulina",),
    ("collagen bovine", "kolagen wołowy", "collagen wolowy", "colpropur bovine",
     "bovine collagen", "collagen wolowy"),
    ("collagen fish", "kolagen rybi", "fish collagen", "amita coll"),
    ("sodium butyrate", "maślan sodu", "maslan sodu"),
    ("glucosamine",),
    ("chondroitin",),
    ("msm", "methylsulfonylmethane"),
    ("microcrystalline cellulose",),
    ("maltodextrin", "maltodekstry"),
    ("piperine", "piperin"),
    ("turmeric", "kurkuma"),
    ("shilajit", "mumio"),
]


def _canonical_tags(name: str) -> set[str]:
    """Map product name to a set of canonical ingredient tags."""
    low = name.lower()
    tags: set[str] = set()
    for group in SYNONYM_GROUPS:
        canonical = group[0]
        for synonym in group:
            if synonym in low:
                tags.add(canonical)
                break
    return tags


def build_comparison(amita: list[dict], emma: list[dict]) -> list[dict]:
    """
    Pairwise match: each Amita product is matched to at most one Emma product
    that shares a canonical tag. Unmatched products appear as single-supplier groups.

    Returns list of groups sorted: multi-supplier first, then by category + name.
    """
    # Enrich each offer with its canonical tags
    for offer in amita + emma:
        offer["_tags"] = _canonical_tags(offer["product_name"])

    used_emma: set[int] = set()
    result: list[dict] = []

    for a_offer in amita:
        matched_emma = []
        for idx, e_offer in enumerate(emma):
            if idx in used_emma:
                continue
            shared = a_offer["_tags"] & e_offer["_tags"]
            if shared:
                matched_emma.append((idx, e_offer, shared))

        if matched_emma:
            # Take the Emma offer with the most shared tags
            best_idx, best_emma, shared = max(matched_emma, key=lambda x: len(x[2]))
            used_emma.add(best_idx)
            group_name = a_offer["product_name"]
            result.append({
                "group_name": group_name,
                "category": a_offer["category"],
                "tags": sorted(a_offer["_tags"]),
                "offers": [a_offer, best_emma],
                "multi_supplier": True,
            })
        else:
            result.append({
                "group_name": a_offer["product_name"],
                "category": a_offer["category"],
                "tags": sorted(a_offer["_tags"]),
                "offers": [a_offer],
                "multi_supplier": False,
            })

    # Emma products not matched to any Amita offer
    for idx, e_offer in enumerate(emma):
        if idx not in used_emma:
            result.append({
                "group_name": e_offer["product_name"],
                "category": e_offer["category"],
                "tags": sorted(e_offer["_tags"]),
                "offers": [e_offer],
                "multi_supplier": False,
            })

    # Sort: multi-supplier first, then category, then name
    result.sort(key=lambda g: (not g["multi_supplier"], g["category"], g["group_name"].lower()))
    return result


# ──────────────────────────────────────────────────────────────
# Main entry point
# ──────────────────────────────────────────────────────────────

def load_and_parse() -> dict:
    """
    Read files from FOLDER, parse them, return raw parsed offers.
    Currency conversion (→ PLN) is done in the endpoint with live NBP rates.
    """
    files_found = {f.name: f for f in FOLDER.iterdir() if f.is_file()}

    amita_offers: list[dict] = []
    emma_offers: list[dict] = []
    kemin_note: str = ""
    warnings: list[str] = []

    for fname, fpath in files_found.items():
        fl = fname.lower()
        if fl.endswith(".pdf"):
            kemin_note = (
                f"'{fname}' to broszura produktowa Kemin Industries — "
                "zawiera opisy składników (FloraGLO Lutein, DailyZz, Neumentix, BetaVia, "
                "ButiShield, Slendesta, XCS-11), lecz nie zawiera cennika."
            )
        elif "amita" in fl:
            try:
                text = fpath.read_text(encoding="utf-8", errors="replace")
                amita_offers = parse_amita(text)
            except Exception as e:
                warnings.append(f"Błąd parsowania {fname}: {e}")
        elif "emma" in fl:
            try:
                text = fpath.read_text(encoding="utf-8", errors="replace")
                emma_offers = parse_emma(text)
            except Exception as e:
                warnings.append(f"Błąd parsowania {fname}: {e}")

    if not amita_offers and not emma_offers:
        warnings.append("Nie znaleziono żadnych wycen w plikach tekstowych.")

    groups = build_comparison(amita_offers, emma_offers)

    return {
        "amita_count": len(amita_offers),
        "emma_count": len(emma_offers),
        "kemin_note": kemin_note,
        "warnings": warnings,
        "groups": groups,
    }
