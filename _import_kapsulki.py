"""
Import capsule prices from OPAKOWANIA-KAPSUŁKI-FOLIE-TASMY-CENY.xlsx
Sheet: KAPSUŁKI
Adds ACG and MPI.EU entries (IMCD.PL already in DB).
"""
from datetime import datetime, date
from database import get_db, next_id

EXCEL_FILE = r"F:\OneDrive\Onedrive Firma\1-DOKUMENTY\ZAMÓWIENIA-WYCENY\OPAKOWANIA-KAPSUŁKI-FOLIE-TASMY-CENY.xlsx"
SOURCE_FILE = "OPAKOWANIA-KAPSUŁKI-FOLIE-TASMY-CENY.xlsx"
QUOTE_DATE = date(2026, 5, 14)

# ── price per 1000 capsules, currency PLN ──────────────────────────────────

ACG_ROWS = [
    # (product_name, price_pln_per_1000)
    ('HG ROZMIAR "3" (NAJMNIEJSZE)', 10.32),
    ('HG ROZMIAR "1"',               10.75),
    ('HG ROZMIAR "0"',               9.9375),
    ('HG ROZMIAR "00"',              13.125),
    ('HPMC "3"',                     19.875),
    ('HPMC "1"',                     20.625),
    ('HPMC "0"',                     21.5625),
    ('HPMC "00"',                    25.125),
]

# MPI.EU – two quantity tiers per product
# (product_name, tier_label, price_pln_per_1000, moq)
MPI_ROWS = [
    ('HG ROZMIAR "3" (NAJMNIEJSZE)', "1 paleta",  9.46,   2_520_000),
    ('HG ROZMIAR "3" (NAJMNIEJSZE)', "2 palety",  9.116,  5_040_000),
    ('HG ROZMIAR "1"',               "1 paleta",  10.32,  1_440_000),
    ('HG ROZMIAR "1"',               "2 palety",  9.89,   2_880_000),
    ('HG ROZMIAR "00"',              "1 paleta",  13.125,   900_000),
    ('HG ROZMIAR "00"',              "2 palety",  12.5625, 1_800_000),
    ('HPMC "3"',                     "1 paleta",  13.76,  2_520_000),
    ('HPMC "3"',                     "2 palety",  13.416, 5_040_000),
    ('HPMC "1"',                     "1 paleta",  13.975, 1_440_000),
    ('HPMC "1"',                     "2 palety",  13.545, 2_880_000),
    ('HPMC "00"',                    "1 paleta",  16.985,   900_000),
    ('HPMC "00"',                    "2 palety",  16.34,  1_800_000),
]


def _base_name(product_name: str) -> str:
    """Strip tier/color suffixes to get a canonical base name."""
    return product_name.strip()


def build_doc(product_name, supplier, price, moq, notes, contact_email, db):
    new_id = next_id("quotations")
    return {
        "id": new_id,
        "created_at": datetime.utcnow(),
        "category": "kapsula",
        "product_name": product_name,
        "supplier": supplier,
        "quantity": 1000.0,
        "unit": "szt",
        "price_original": round(price, 6),
        "currency": "PLN",
        "price_pln": round(price, 6),
        "exchange_rate_used": 1.0,
        "valid_until": None,
        "notes": notes,
        "moq": float(moq) if moq else None,
        "spec_label": None,
        "canonical_key": None,
        "incoterm": None,
        "logistics_cost_pln": None,
        "quote_date": QUOTE_DATE.isoformat(),
        "contact_email": contact_email,
        "source_file": SOURCE_FILE,
        "price_type": "netto",
        "base_name": _base_name(product_name),
        "inbox_id": None,
    }


def already_exists(db, product_name, supplier):
    return db["quotations"].count_documents(
        {"product_name": product_name, "supplier": supplier}
    ) > 0


def main():
    db = get_db()
    inserted = 0
    skipped = 0

    # ── ACG ──────────────────────────────────────────────────────────────
    for product_name, price in ACG_ROWS:
        if already_exists(db, product_name, "ACG"):
            print(f"  SKIP (exists): ACG / {product_name}")
            skipped += 1
            continue
        doc = build_doc(
            product_name=product_name,
            supplier="ACG",
            price=price,
            moq=None,
            notes="valeria.gruszczynska@acg-world.com",
            contact_email="valeria.gruszczynska@acg-world.com",
            db=db,
        )
        db["quotations"].insert_one(doc)
        print(f"  INSERT: ACG / {product_name} @ {price} PLN/1000")
        inserted += 1

    # ── MPI.EU ───────────────────────────────────────────────────────────
    for product_name, tier, price, moq in MPI_ROWS:
        full_name = f"{product_name} ({tier})"
        if already_exists(db, full_name, "MPI.EU"):
            print(f"  SKIP (exists): MPI.EU / {full_name}")
            skipped += 1
            continue
        doc = build_doc(
            product_name=full_name,
            supplier="MPI.EU",
            price=price,
            moq=moq,
            notes=f"Tier: {tier} | mateusz.taciak@mpi.eu | +48 575 056 550",
            contact_email="mateusz.taciak@mpi.eu",
            db=db,
        )
        db["quotations"].insert_one(doc)
        print(f"  INSERT: MPI.EU / {full_name} @ {price} PLN/1000  MOQ={moq:,}")
        inserted += 1

    print(f"\nGotowe: {inserted} dodano, {skipped} pominięto (już istnieje).")


if __name__ == "__main__":
    main()
