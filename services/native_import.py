"""
Dedykowane parsery dla własnych plików Excel firmy:
  - SUBSTANCJE-CENY.xlsx        → arkusz SUBSTANCJE
  - OPAKOWANIA-KAPSUŁKI-...xlsx → arkusze OPAKOWANIA, KAPSUŁKI, TAŚMY - FOLIA

Format plików: poziome matryce porównawcze (wielu dostawców obok siebie).
Wynik: lista dicts gotowych do zapisu jako Quotation (bez pól price_pln / exchange_rate_used).
"""

from __future__ import annotations

import io
import re
from typing import Any

import pandas as pd

# ──────────────────────────────────────────────────────────────
# Helpers
# ──────────────────────────────────────────────────────────────

def _val(cell: Any) -> str:
    """Return stripped string or empty string for NaN / None."""
    if pd.isna(cell) or cell is None:
        return ""
    return str(cell).strip()


def _num(cell: Any) -> float | None:
    """Try to parse a numeric price from a cell. Return None if not possible."""
    s = _val(cell).replace(",", ".").replace("\xa0", "").replace(" ", "")
    # strip trailing currency/unit noise like "PLN", "zł", "/kg"
    s = re.sub(r"[a-zA-Złę/]+$", "", s)
    # if multiple numbers (e.g. "1szt 20.48 / 5szt 20.08"), take first
    m = re.search(r"\d[\d.]*", s)
    if m:
        try:
            v = float(m.group())
            return v if v > 0 else None
        except ValueError:
            pass
    return None


def _parse_moq(moq_text: str) -> float | None:
    """
    Try to extract a numeric MOQ value from free-text strings.
    Examples: "MOQ 25KG" → 25.0, "MOQ: 25kg" → 25.0, "25 kg" → 25.0,
              "2520000" → 2520000.0, "4 Kartony" → 4.0,
              "1 PALETA = 12 KARTONÓW" → None (too ambiguous)
    """
    if not moq_text:
        return None
    text = moq_text.strip()
    # Skip obviously ambiguous multi-value descriptions
    if "=" in text and "PALETA" in text.upper():
        return None
    # Strip leading "MOQ" keyword
    text = re.sub(r"(?i)^moq\s*:?\s*", "", text).strip()
    # Extract first number
    m = re.match(r"([\d]+(?:[.,]\d+)?)", text)
    if m:
        try:
            val = float(m.group(1).replace(",", "."))
            return val if val > 0 else None
        except ValueError:
            pass
    return None


def _clean_supplier(raw: str) -> str:
    """Shorten a supplier string to a readable name."""
    # Take only the first segment before "/" or space-email
    raw = raw.strip()
    # Drop email parts (contains @)
    raw = re.sub(r"\s*/?\s*\S+@\S+", "", raw)
    # Drop phone numbers
    raw = re.sub(r"[/+]?\s*\d[\d\s]{6,}", "", raw)
    return raw.strip().rstrip("/").strip() or raw


# ──────────────────────────────────────────────────────────────
# SUBSTANCJE-CENY.xlsx  →  arkusz SUBSTANCJE
# ──────────────────────────────────────────────────────────────
# Layout:
#   Row 0: "SUBSTANCJA" | ... | "FIRMA / CENA" ...
#   Row 1: ""  | "AKTUALNE CENY" | "AKTUALNY DOSTAWCA" | BART.PL | "" | "" | TORIMEX.PL | ...
#   Row 2: ""  | "PLN/KG"        | ""                  | SUBSTANCJA | PLN/KG | MOQ | ...
#   Row 3+: data
#
# Supplier blocks start at col 3, stride 3:  [name_col, price_col, moq_col]
# ──────────────────────────────────────────────────────────────

def parse_substancje(df: pd.DataFrame) -> tuple[list[dict], list[str]]:
    rows: list[dict] = []
    errors: list[str] = []

    # Extract supplier names from row 1 (index 1), cols 3, 6, 9, ...
    supplier_blocks: list[tuple[str, int]] = []  # (supplier_name, col_start)
    header_row = df.iloc[1]
    n_cols = len(df.columns)
    col = 3
    while col < n_cols:
        name = _clean_supplier(_val(header_row.iloc[col]))
        if name:
            supplier_blocks.append((name, col))
        col += 3

    if not supplier_blocks:
        return [], ["Nie znaleziono bloków dostawców w arkuszu SUBSTANCJE."]

    last_product = ""

    for idx in range(3, len(df)):
        row = df.iloc[idx]
        canonical = _val(row.iloc[0])
        if canonical:
            last_product = canonical
        product_name = last_product
        if not product_name:
            continue

        for supplier, c in supplier_blocks:
            # supplier-specific product name (optional, use canonical if empty)
            sp_name = _val(row.iloc[c]) if c < n_cols else ""
            price_raw = row.iloc[c + 1] if c + 1 < n_cols else None
            moq_raw = _val(row.iloc[c + 2]) if c + 2 < n_cols else ""

            price = _num(price_raw)
            if price is None:
                continue

            moq = _parse_moq(moq_raw)
            notes_parts = []
            if moq_raw:
                notes_parts.append(f"MOQ: {moq_raw}")
            if sp_name and sp_name.lower() != product_name.lower():
                notes_parts.append(f"Nazwa u dostawcy: {sp_name}")

            rows.append({
                "category": "substancja_czynna",
                "product_name": product_name,
                "supplier": supplier,
                "quantity": 1.0,
                "unit": "kg",
                "price_original": price,
                "currency": "PLN",
                "valid_until": None,
                "notes": "; ".join(notes_parts) or None,
                "moq": moq,
            })

    return rows, errors


# ──────────────────────────────────────────────────────────────
# OPAKOWANIA-KAPSUŁKI-...xlsx  →  arkusz OPAKOWANIA
# ──────────────────────────────────────────────────────────────
# Layout:
#   Row 0: PONT | "" | "" | EMBACO (4-8 tygodni) | "" | ""
#   Row 1: PRODUKT OPAKOWANIA | WYMIARY | CENA ZA 1000 szt / PLN | (repeat)
#   Row 2+: data (products × suppliers)
#   Row 18: section header "PRODUKT NAKRĘTKI" (same layout continues)
#
# Supplier blocks: col 0 (PONT), col 3 (EMBACO), …
# ──────────────────────────────────────────────────────────────

def parse_opakowania(df: pd.DataFrame) -> tuple[list[dict], list[str]]:
    rows: list[dict] = []
    errors: list[str] = []

    # Extract supplier blocks from row 0
    supplier_blocks: list[tuple[str, int]] = []
    header_row = df.iloc[0]
    n_cols = len(df.columns)
    for c in range(0, n_cols, 3):
        name = _clean_supplier(_val(header_row.iloc[c]))
        if name and name.upper() not in ("PRODUKT OPAKOWANIA", "PRODUKT NAKRĘTKI"):
            supplier_blocks.append((name, c))

    if not supplier_blocks:
        return [], ["Nie znaleziono bloków dostawców w arkuszu OPAKOWANIA."]

    for idx in range(2, len(df)):
        row = df.iloc[idx]
        # Skip empty rows and sub-header rows
        first_cell = _val(row.iloc[0])
        if not first_cell or "PRODUKT" in first_cell.upper():
            # might be a section header row — re-read supplier names
            new_blocks: list[tuple[str, int]] = []
            for c in range(0, n_cols, 3):
                name = _clean_supplier(_val(row.iloc[c]))
                if name and "PRODUKT" not in name.upper():
                    new_blocks.append((name, c))
            if new_blocks:
                supplier_blocks = new_blocks
            continue

        for supplier, c in supplier_blocks:
            product_name = _val(row.iloc[c])
            dimensions = _val(row.iloc[c + 1]) if c + 1 < n_cols else ""
            price_raw = row.iloc[c + 2] if c + 2 < n_cols else None

            if not product_name:
                continue
            price = _num(price_raw)
            if price is None:
                continue

            notes = f"Wymiary: {dimensions}" if dimensions else None

            rows.append({
                "category": "opakowanie",
                "product_name": product_name,
                "supplier": supplier,
                "quantity": 1000.0,
                "unit": "szt",
                "price_original": price,
                "currency": "PLN",
                "valid_until": None,
                "notes": notes,
                "moq": None,
            })

    return rows, errors


# ──────────────────────────────────────────────────────────────
# OPAKOWANIA-KAPSUŁKI-...xlsx  →  arkusz KAPSUŁKI
# ──────────────────────────────────────────────────────────────
# Layout:
#   Row 0: PRODUKT | AKT. CENA PLN/1000 | AKT. DOSTAWCA | MPI.EU | ... | IMCD.PL | ...
#   Row 1: ""      | ""                 | ""            | ROZMIAR | ILOSC | CENA PLN/1000 | MOQ | ILOSC | CENA PLN/1000 | MOQ | PRODUKT | KOLOR | CENA PLN/1000 | MOQ
#   Row 2-3: extra info / notes
#   Row 4+: data
#
# MPI.EU block: cols 3-9  (product@3, tier1_qty@4, tier1_price@5, tier1_moq@6, tier2_qty@7, tier2_price@8, tier2_moq@9)
# IMCD.PL block: cols 10-13 (product@10, kolor@11, price@12, moq@13)
# ──────────────────────────────────────────────────────────────

def parse_kapsulki(df: pd.DataFrame) -> tuple[list[dict], list[str]]:
    rows: list[dict] = []
    errors: list[str] = []

    # Detect supplier names from row 0
    header_row0 = df.iloc[0]
    n_cols = len(df.columns)

    # Build supplier blocks dynamically based on row 0 headers
    # Columns 0-2 are "summary" columns; suppliers start from col 3
    # Each supplier has a contiguous block — detect boundaries from row 0
    supplier_starts: list[tuple[str, int]] = []
    for c in range(3, n_cols):
        name = _clean_supplier(_val(header_row0.iloc[c]))
        if name:
            supplier_starts.append((name, c))

    # For each supplier we need to know end column = next supplier start or n_cols
    supplier_ranges: list[tuple[str, int, int]] = []
    for i, (name, start) in enumerate(supplier_starts):
        end = supplier_starts[i + 1][1] if i + 1 < len(supplier_starts) else n_cols
        supplier_ranges.append((name, start, end))

    for idx in range(4, len(df)):
        row = df.iloc[idx]
        canonical = _val(row.iloc[0])
        if not canonical:
            # Rows without a canonical name (e.g. Vcaps-only rows) — still process supplier cols
            pass

        for supplier, start, end in supplier_ranges:
            block = [row.iloc[c] if c < n_cols else None for c in range(start, end)]

            # Detect layout by column count in block
            block_size = end - start
            if block_size >= 7:
                # MPI.EU-style: product | tier1_qty | tier1_price | tier1_moq | tier2_qty | tier2_price | tier2_moq
                _emit_capsule(rows, canonical, supplier, block, 0, 2, 1, 3, "MPI.EU-tier1")
                _emit_capsule(rows, canonical, supplier, block, 0, 5, 4, 6, "MPI.EU-tier2")
            elif block_size >= 4:
                # IMCD-style: product | kolor | price | moq
                product_name = _val(block[0]) if block[0] is not None else canonical
                kolor = _val(block[1]) if len(block) > 1 else ""
                price = _num(block[2]) if len(block) > 2 else None
                moq = _val(block[3]) if len(block) > 3 else ""

                if not product_name:
                    product_name = canonical
                if not product_name or price is None:
                    continue

                moq_val = _parse_moq(moq)
                notes_parts = []
                if kolor:
                    notes_parts.append(f"Kolor: {kolor}")
                if moq:
                    notes_parts.append(f"MOQ: {moq}")

                rows.append({
                    "category": "kapsula",
                    "product_name": product_name,
                    "supplier": supplier,
                    "quantity": 1000.0,
                    "unit": "szt",
                    "price_original": price,
                    "currency": "PLN",
                    "valid_until": None,
                    "notes": "; ".join(notes_parts) or None,
                    "moq": moq_val,
                })

    return rows, errors


def _emit_capsule(
    rows: list[dict],
    canonical: str,
    supplier: str,
    block: list,
    name_idx: int,
    price_idx: int,
    qty_idx: int,
    moq_idx: int,
    tier_label: str,
):
    product_name = _val(block[name_idx]) if name_idx < len(block) and block[name_idx] is not None else canonical
    if not product_name:
        product_name = canonical
    if not product_name:
        return

    price = _num(block[price_idx]) if price_idx < len(block) else None
    if price is None:
        return

    qty_label = _val(block[qty_idx]) if qty_idx < len(block) and block[qty_idx] is not None else ""
    moq = _val(block[moq_idx]) if moq_idx < len(block) and block[moq_idx] is not None else ""

    moq_val = _parse_moq(moq)
    notes_parts = []
    if qty_label:
        notes_parts.append(f"Ilość: {qty_label}")
    if moq:
        notes_parts.append(f"MOQ: {moq}")

    rows.append({
        "category": "kapsula",
        "product_name": product_name,
        "supplier": supplier,
        "quantity": 1000.0,
        "unit": "szt",
        "price_original": price,
        "currency": "PLN",
        "valid_until": None,
        "notes": "; ".join(notes_parts) or None,
        "moq": moq_val,
    })


# ──────────────────────────────────────────────────────────────
# TAŚMY - FOLIA  →  prosta lista  (cena jako tekst → best-effort)
# ──────────────────────────────────────────────────────────────

def parse_tasmy_folia(df: pd.DataFrame) -> tuple[list[dict], list[str]]:
    rows: list[dict] = []
    errors: list[str] = []

    for idx in range(1, len(df)):
        row = df.iloc[idx]
        product_name = _val(row.iloc[0])
        price_raw = _val(row.iloc[1]) if len(row) > 1 else ""
        supplier = _val(row.iloc[2]) if len(row) > 2 else ""

        if not product_name or not price_raw or not supplier:
            continue

        # Try to extract first numeric price from the text
        price = _num(price_raw)
        if price is None:
            errors.append(f"Taśmy/Folia wiersz {idx+1}: nie można odczytać ceny '{price_raw}' — pominięto")
            continue

        supplier = _clean_supplier(supplier)
        rows.append({
            "category": "opakowanie",
            "product_name": product_name,
            "supplier": supplier,
            "quantity": 1.0,
            "unit": "szt",
            "price_original": price,
            "currency": "PLN",
            "valid_until": None,
            "notes": f"Cena oryginalna: {price_raw}",
            "moq": None,
        })

    return rows, errors


# ──────────────────────────────────────────────────────────────
# Main dispatcher
# ──────────────────────────────────────────────────────────────

def parse_native_file(file_bytes: bytes, filename: str) -> tuple[list[dict], list[str]]:
    """
    Auto-detect which native file is being uploaded and parse all relevant sheets.
    Returns (all_rows, all_errors).
    """
    all_rows: list[dict] = []
    all_errors: list[str] = []

    try:
        xl = pd.ExcelFile(io.BytesIO(file_bytes))
    except Exception as exc:
        return [], [f"Nie można otworzyć pliku: {exc}"]

    fname_upper = filename.upper()

    sheet_parsers = {
        "SUBSTANCJE":    parse_substancje,
        "OPAKOWANIA":    parse_opakowania,
        "KAPSUŁKI":      parse_kapsulki,
        "KAPSULKI":      parse_kapsulki,
        "TAŚMY - FOLIA": parse_tasmy_folia,
        "TASMY - FOLIA": parse_tasmy_folia,
    }

    found_any = False
    for sheet in xl.sheet_names:
        sheet_key = sheet.upper().strip()
        parser = sheet_parsers.get(sheet_key)
        if parser is None:
            continue
        found_any = True
        try:
            df = pd.read_excel(io.BytesIO(file_bytes), sheet_name=sheet, header=None, dtype=str)
            # Re-read as mixed types for numeric parsing
            df_num = pd.read_excel(io.BytesIO(file_bytes), sheet_name=sheet, header=None)
            rows, errs = parser(df_num)
            all_rows.extend(rows)
            all_errors.extend([f"[{sheet}] {e}" for e in errs])
        except Exception as exc:
            all_errors.append(f"Błąd parsowania arkusza '{sheet}': {exc}")

    if not found_any:
        all_errors.append(
            f"Nie rozpoznano żadnego arkusza w pliku '{filename}'. "
            "Oczekiwane: SUBSTANCJE, OPAKOWANIA, KAPSUŁKI, TAŚMY - FOLIA."
        )

    return all_rows, all_errors
