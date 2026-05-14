"""
FastAPI application for Quotation Comparer.
Serves the frontend SPA and exposes a REST API.
Backend: MongoDB Atlas (pymongo).
"""

import io
import json
import os
import re
from collections import defaultdict
from datetime import datetime, date
from typing import Optional

import pandas as pd
from fastapi import FastAPI, Depends, HTTPException, UploadFile, File, Query
from fastapi.responses import FileResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles
from pymongo.database import Database

import models
from database import get_db, next_id
from models import (
    QuotationCreate,
    QuotationRead,
    QuotationUpdate,
    CalcResult,
    RecommendResult,
    ExchangeRateResponse,
)
from services.currency import get_rate, get_all_rates, convert_to_pln
from services.excel_import import (
    parse_excel, build_template_excel,
    detect_column_mapping, apply_column_mapping,
    build_filled_template,
)
from pydantic import BaseModel as PydanticBaseModel
from services.native_import import parse_native_file
from services.treomag_parser import load_and_parse as treomag_load
from services.pipedrive import get_supplier_pipedrive
from services.mailer import send_order_email
from services.ocr_import import extract_from_file as ocr_extract_from_file
import services.inbox as inbox_svc
import asyncio

app = FastAPI(title="Comparer — Porównywarka Wycen Ofertowych", version="2.0.0")


# ── Helpers ───────────────────────────────────────────────────────────────────

def _doc_to_dict(doc: dict) -> dict:
    """Strip MongoDB _id and normalise types."""
    d = {k: v for k, v in doc.items() if k != "_id"}
    # Convert date objects stored as strings back when needed
    return d


def _parse_date(val) -> Optional[date]:
    if val is None:
        return None
    if isinstance(val, date):
        return val
    if isinstance(val, datetime):
        return val.date()
    if isinstance(val, str):
        try:
            return date.fromisoformat(val[:10])
        except Exception:
            return None
    return None


def _enrich(doc: dict) -> QuotationRead:
    qty = doc.get("quantity") or 1
    ppu = round(doc.get("price_pln", 0) / qty, 4)
    logistics = doc.get("logistics_cost_pln") or 0.0
    return QuotationRead(
        id=doc["id"],
        created_at=doc.get("created_at") or datetime.now(),
        category=doc.get("category", ""),
        product_name=doc.get("product_name", ""),
        supplier=doc.get("supplier", ""),
        quantity=qty,
        unit=doc.get("unit", "kg"),
        price_original=doc.get("price_original", 0),
        currency=doc.get("currency", "PLN"),
        price_pln=doc.get("price_pln", 0),
        exchange_rate_used=doc.get("exchange_rate_used", 1),
        valid_until=_parse_date(doc.get("valid_until")),
        notes=doc.get("notes"),
        moq=doc.get("moq"),
        spec_label=doc.get("spec_label"),
        canonical_key=doc.get("canonical_key"),
        incoterm=doc.get("incoterm"),
        logistics_cost_pln=doc.get("logistics_cost_pln"),
        quote_date=_parse_date(doc.get("quote_date")),
        contact_email=doc.get("contact_email"),
        source_file=doc.get("source_file"),
        price_type=doc.get("price_type") or "netto",
        inbox_id=doc.get("inbox_id"),
        price_per_unit_pln=ppu,
        effective_price_per_unit_pln=round(ppu + logistics, 4),
    )


def _build_quotation_doc(data: dict, price_pln: float, rate: float) -> dict:
    """Build a MongoDB document dict for a new quotation."""
    doc = {k: v for k, v in data.items()}
    doc["price_pln"] = price_pln
    doc["exchange_rate_used"] = rate
    doc["created_at"] = datetime.now()
    # Serialise date fields to ISO strings for MongoDB
    for f in ("valid_until", "quote_date"):
        if isinstance(doc.get(f), date):
            doc[f] = doc[f].isoformat()
    doc.setdefault("price_type", "netto")
    return doc


def _q_filter(
    category: Optional[str] = None,
    product_name: Optional[str] = None,
    supplier: Optional[str] = None,
    currency: Optional[str] = None,
) -> dict:
    flt: dict = {}
    if category:
        flt["category"] = category
    if product_name:
        flt["product_name"] = {"$regex": re.escape(product_name), "$options": "i"}
    if supplier:
        flt["supplier"] = {"$regex": re.escape(supplier), "$options": "i"}
    if currency:
        flt["currency"] = currency.upper()
    return flt


# ── Background inbox loop ─────────────────────────────────────────────────────

async def _inbox_background_loop():
    await asyncio.sleep(30)
    while True:
        try:
            if inbox_svc.is_configured():
                db = get_db()
                known = {r["imap_uid"] for r in db.inbox_emails.find({}, {"imap_uid": 1})}
                raw_emails = inbox_svc.fetch_new_emails(known)
                for raw in raw_emails:
                    try:
                        new_id = next_id("inbox_emails")
                        db.inbox_emails.insert_one({
                            "id":             new_id,
                            "received_at":    raw["received_at"],
                            "fetched_at":     datetime.now().isoformat(),
                            "from_addr":      raw["from_addr"],
                            "subject":        raw["subject"],
                            "body_text":      raw.get("body", "")[:4000],
                            "attachments":    raw.get("attachments", []),
                            "extracted_rows": [],
                            "status":         "new",
                            "imap_uid":       raw["imap_uid"],
                            "error":          None,
                            "source_files":   [a["saved"] for a in raw.get("attachments", [])],
                        })
                    except Exception:
                        pass
        except Exception:
            pass
        await asyncio.sleep(3600)


@app.on_event("startup")
async def startup_event():
    asyncio.create_task(_inbox_background_loop())


# ── Static / SPA ──────────────────────────────────────────────────────────────

app.mount("/static", StaticFiles(directory="static"), name="static")


@app.get("/", include_in_schema=False)
async def root():
    return FileResponse("static/index.html")


# ── Currency ──────────────────────────────────────────────────────────────────

@app.get("/api/rates", response_model=ExchangeRateResponse, tags=["Waluty"])
async def current_rates():
    try:
        return await get_all_rates()
    except Exception as exc:
        raise HTTPException(status_code=502, detail=str(exc))


# ── Quotation CRUD ────────────────────────────────────────────────────────────

@app.get("/api/quotations", response_model=list[QuotationRead], tags=["Wyceny"])
def list_quotations(
    category: Optional[str] = Query(None),
    product_name: Optional[str] = Query(None),
    supplier: Optional[str] = Query(None),
    currency: Optional[str] = Query(None),
    db: Database = Depends(get_db),
):
    flt = _q_filter(category, product_name, supplier, currency)
    docs = list(db.quotations.find(flt).sort([("product_name", 1), ("price_pln", 1)]))
    return [_enrich(_doc_to_dict(d)) for d in docs]


@app.get("/api/quotations/{quotation_id}", response_model=QuotationRead, tags=["Wyceny"])
def get_quotation(quotation_id: int, db: Database = Depends(get_db)):
    doc = db.quotations.find_one({"id": quotation_id})
    if not doc:
        raise HTTPException(status_code=404, detail="Wycena nie znaleziona")
    return _enrich(_doc_to_dict(doc))


@app.post("/api/quotations", response_model=QuotationRead, status_code=201, tags=["Wyceny"])
async def create_quotation(
    payload: QuotationCreate,
    manual_rate: Optional[float] = Query(None),
    db: Database = Depends(get_db),
):
    try:
        rate, _ = await get_rate(payload.currency, manual_rate)
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc))

    price_per_unit_pln = convert_to_pln(payload.price_original, payload.currency, rate)
    price_pln = round(price_per_unit_pln * payload.quantity, 4)

    new_id = next_id("quotations")
    data = payload.model_dump()
    doc = _build_quotation_doc(data, price_pln, rate)
    doc["id"] = new_id
    db.quotations.insert_one(doc)
    return _enrich(doc)


@app.put("/api/quotations/{quotation_id}", response_model=QuotationRead, tags=["Wyceny"])
async def update_quotation(
    quotation_id: int,
    payload: QuotationUpdate,
    manual_rate: Optional[float] = Query(None),
    db: Database = Depends(get_db),
):
    doc = db.quotations.find_one({"id": quotation_id})
    if not doc:
        raise HTTPException(status_code=404, detail="Wycena nie znaleziona")

    update_data = payload.model_dump(exclude_none=True)
    for f in ("valid_until", "quote_date"):
        if isinstance(update_data.get(f), date):
            update_data[f] = update_data[f].isoformat()

    if "price_original" in update_data or "currency" in update_data:
        cur_currency = update_data.get("currency") or doc.get("currency", "PLN")
        cur_price = update_data.get("price_original") or doc.get("price_original", 0)
        cur_qty = update_data.get("quantity") or doc.get("quantity", 1)
        try:
            rate, _ = await get_rate(cur_currency, manual_rate)
        except ValueError as exc:
            raise HTTPException(status_code=422, detail=str(exc))
        ppu = convert_to_pln(cur_price, cur_currency, rate)
        update_data["price_pln"] = round(ppu * cur_qty, 4)
        update_data["exchange_rate_used"] = rate

    db.quotations.update_one({"id": quotation_id}, {"$set": update_data})
    doc = _doc_to_dict(db.quotations.find_one({"id": quotation_id}))
    return _enrich(doc)


@app.patch("/api/quotations/{quotation_id}/notes", tags=["Wyceny"])
def patch_quotation_notes(
    quotation_id: int,
    payload: dict,
    db: Database = Depends(get_db),
):
    notes = (payload.get("notes") or "").strip() or None
    db.quotations.update_one({"id": quotation_id}, {"$set": {"notes": notes}})
    return {"id": quotation_id, "notes": notes}


@app.delete("/api/quotations/{quotation_id}", status_code=204, tags=["Wyceny"])
def delete_quotation(quotation_id: int, db: Database = Depends(get_db)):
    result = db.quotations.delete_one({"id": quotation_id})
    if result.deleted_count == 0:
        raise HTTPException(status_code=404, detail="Wycena nie znaleziona")


# ── Excel import / export ─────────────────────────────────────────────────────

@app.post("/api/import/preview", tags=["Import / Eksport"])
async def preview_import(file: UploadFile = File(...)):
    content = await file.read()
    rows, errors = parse_excel(content)
    return {"rows": rows, "errors": errors, "count": len(rows)}


async def _insert_rows_from_list(rows, errors_list, db, manual_rates=None):
    saved = 0
    manual_rates = manual_rates or {}
    import_errors = list(errors_list)
    for row in rows:
        currency = row["currency"]
        mr = manual_rates.get(currency)
        try:
            rate, _ = await get_rate(currency, mr)
        except ValueError as exc:
            import_errors.append(f"{row.get('product_name','?')}: {exc}")
            continue
        qty = row.get("quantity") or 1
        price_pln = round(convert_to_pln(row["price_original"], currency, rate) * qty, 4)
        new_id = next_id("quotations")
        doc = {
            "id": new_id,
            "created_at": datetime.now(),
            "category": row.get("category", "substancja_czynna"),
            "product_name": row["product_name"],
            "supplier": row.get("supplier") or "Import",
            "quantity": qty,
            "unit": row.get("unit", "kg"),
            "price_original": row["price_original"],
            "currency": currency,
            "price_pln": price_pln,
            "exchange_rate_used": rate,
            "valid_until": str(row["valid_until"]) if row.get("valid_until") else None,
            "notes": row.get("notes"),
            "moq": row.get("moq"),
            "spec_label": row.get("spec_label"),
            "incoterm": row.get("incoterm"),
            "logistics_cost_pln": row.get("logistics_cost_pln"),
            "price_type": row.get("price_type") or "netto",
        }
        db.quotations.insert_one(doc)
        saved += 1
    return saved, import_errors


@app.post("/api/import/confirm", tags=["Import / Eksport"])
async def confirm_import(
    file: UploadFile = File(...),
    manual_eur: Optional[float] = Query(None),
    manual_usd: Optional[float] = Query(None),
    db: Database = Depends(get_db),
):
    content = await file.read()
    rows, errors = parse_excel(content)
    manual_rates = {"EUR": manual_eur, "USD": manual_usd}
    saved, import_errors = await _insert_rows_from_list(rows, errors, db, manual_rates)
    return {"saved": saved, "skipped": len(rows) - saved + len(errors), "errors": import_errors}


@app.get("/api/export", tags=["Import / Eksport"])
def export_quotations(
    category: Optional[str] = Query(None),
    product_name: Optional[str] = Query(None),
    supplier: Optional[str] = Query(None),
    db: Database = Depends(get_db),
):
    flt = _q_filter(category, product_name, supplier)
    items = list(db.quotations.find(flt).sort([("product_name", 1), ("price_pln", 1)]))
    data = []
    for it in items:
        qty = it.get("quantity") or 1
        data.append({
            "ID": it["id"],
            "Kategoria": it.get("category"),
            "Produkt": it.get("product_name"),
            "Dostawca": it.get("supplier"),
            "Ilość": qty,
            "Jednostka": it.get("unit"),
            "Cena oryg.": it.get("price_original"),
            "Waluta": it.get("currency"),
            "Kurs użyty": it.get("exchange_rate_used"),
            "Cena PLN": it.get("price_pln"),
            "Cena/jedn. PLN": round(it.get("price_pln", 0) / qty, 4),
            "Ważna do": it.get("valid_until"),
            "Uwagi": it.get("notes"),
            "Dodano": it.get("created_at"),
        })
    df = pd.DataFrame(data)
    buf = io.BytesIO()
    with pd.ExcelWriter(buf, engine="openpyxl") as writer:
        df.to_excel(writer, index=False, sheet_name="Wyceny")
        ws = writer.sheets["Wyceny"]
        for col_cells in ws.columns:
            max_len = max(len(str(cell.value or "")) for cell in col_cells) + 4
            ws.column_dimensions[col_cells[0].column_letter].width = min(max_len, 40)
    buf.seek(0)
    return StreamingResponse(
        buf,
        media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        headers={"Content-Disposition": "attachment; filename=wyceny_export.xlsx"},
    )


@app.get("/api/export/template", tags=["Import / Eksport"])
def download_template():
    xlsx_bytes = build_template_excel()
    return StreamingResponse(
        io.BytesIO(xlsx_bytes),
        media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        headers={"Content-Disposition": "attachment; filename=szablon_wycen.xlsx"},
    )


@app.post("/api/import/map/detect", tags=["Import / Eksport"])
async def detect_mapping(file: UploadFile = File(...)):
    content = await file.read()
    try:
        result = detect_column_mapping(content)
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc))
    return result


@app.post("/api/import/map/export", tags=["Import / Eksport"])
async def export_mapped_as_template(
    file: UploadFile = File(...),
    mapping_json: str = Query(...),
    supplier_override: Optional[str] = Query(None),
):
    try:
        mapping = json.loads(mapping_json)
    except json.JSONDecodeError:
        raise HTTPException(status_code=422, detail="Nieprawidłowy JSON mappingu")
    content = await file.read()
    rows, errors = apply_column_mapping(content, mapping)
    if not rows and errors:
        raise HTTPException(status_code=422, detail="; ".join(errors[:5]))
    xlsx_bytes = build_filled_template(rows, supplier_override=supplier_override)
    orig_name = (file.filename or "wycena").rsplit(".", 1)[0]
    return StreamingResponse(
        io.BytesIO(xlsx_bytes),
        media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        headers={"Content-Disposition": f"attachment; filename={orig_name}_szablon.xlsx"},
    )


@app.post("/api/import/map/confirm", tags=["Import / Eksport"])
async def confirm_mapping(
    file: UploadFile = File(...),
    mapping_json: str = Query(...),
    supplier_override: Optional[str] = Query(None),
    db: Database = Depends(get_db),
):
    try:
        mapping = json.loads(mapping_json)
    except json.JSONDecodeError:
        raise HTTPException(status_code=422, detail="Nieprawidłowy JSON mappingu")
    content = await file.read()
    rows, errors = apply_column_mapping(content, mapping)
    if supplier_override:
        for r in rows:
            if not r.get("supplier"):
                r["supplier"] = supplier_override
    saved, import_errors = await _insert_rows_from_list(rows, errors, db)
    return {"saved": saved, "skipped": len(rows) - saved + len(errors), "errors": import_errors}


@app.post("/api/import/native/preview", tags=["Import / Eksport"])
async def native_preview(file: UploadFile = File(...)):
    content = await file.read()
    rows, errors = parse_native_file(content, file.filename or "")
    return {"rows": rows, "errors": errors, "count": len(rows)}


@app.post("/api/import/native/confirm", tags=["Import / Eksport"])
async def native_confirm(file: UploadFile = File(...), db: Database = Depends(get_db)):
    content = await file.read()
    rows, errors = parse_native_file(content, file.filename or "")
    saved = 0
    import_errors = list(errors)
    for row in rows:
        new_id = next_id("quotations")
        db.quotations.insert_one({
            "id": new_id,
            "created_at": datetime.now(),
            "category": row.get("category", "substancja_czynna"),
            "product_name": row["product_name"],
            "supplier": row.get("supplier", "Import"),
            "quantity": row.get("quantity", 1),
            "unit": row.get("unit", "kg"),
            "price_original": row["price_original"],
            "currency": "PLN",
            "price_pln": row["price_original"],
            "exchange_rate_used": 1.0,
            "valid_until": None,
            "notes": row.get("notes"),
            "moq": row.get("moq"),
            "price_type": "netto",
        })
        saved += 1
    return {"saved": saved, "skipped": len(import_errors), "errors": import_errors}


# ── Treomag ───────────────────────────────────────────────────────────────────

@app.get("/api/treomag", tags=["Treomag"])
async def treomag_analysis():
    try:
        data = treomag_load()
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"Błąd parsowania plików: {exc}")
    try:
        rates = await get_all_rates()
        eur_pln = rates["EUR"]
        usd_pln = rates["USD"]
    except Exception:
        eur_pln, usd_pln = 4.30, 3.75

    def to_pln(price, currency):
        if currency == "EUR": return round(price * eur_pln, 2)
        if currency == "USD": return round(price * usd_pln, 2)
        return round(price, 2)

    for group in data["groups"]:
        for offer in group["offers"]:
            offer["price_pln"] = to_pln(offer["price_original"], offer["currency"])
            for tier in offer.get("tiers", []):
                tier["price_pln"] = to_pln(tier["price"], tier["currency"])
        group["offers"].sort(key=lambda o: o["price_pln"])
        if len(group["offers"]) > 1:
            group["offers"][0]["is_best"] = True
    data["rates"] = {"EUR": eur_pln, "USD": usd_pln}
    return data


# ── Calculator ────────────────────────────────────────────────────────────────

@app.get("/api/products", tags=["Kalkulator"])
def list_products(db: Database = Depends(get_db)):
    pipeline = [
        {"$group": {"_id": {"category": "$category", "product_name": "$product_name", "unit": "$unit"}}},
        {"$sort": {"_id.category": 1, "_id.product_name": 1}},
    ]
    return [
        {"category": r["_id"]["category"], "product_name": r["_id"]["product_name"], "unit": r["_id"]["unit"]}
        for r in db.quotations.aggregate(pipeline)
    ]


@app.get("/api/calculator", response_model=list[CalcResult], tags=["Kalkulator"])
def calculator(
    product_name: str = Query(...),
    quantity: float = Query(..., gt=0),
    unit: str = Query(...),
    include_over_moq: bool = Query(False),
    db: Database = Depends(get_db),
):
    items = list(db.quotations.find({
        "product_name": {"$regex": re.escape(product_name), "$options": "i"},
        "unit": unit,
    }))
    supplier_tiers: dict[str, list] = defaultdict(list)
    for it in items:
        supplier_tiers[it.get("supplier", "").strip().lower()].append(it)

    results: list[CalcResult] = []
    for _, tiers in supplier_tiers.items():
        eligible = [t for t in tiers if t.get("moq") is None or t["moq"] <= quantity]
        over_moq = [t for t in tiers if t not in eligible]
        if eligible:
            best = min(eligible, key=lambda t: t.get("price_pln", 0) / (t.get("quantity") or 1))
            moq_met = True
        else:
            if not include_over_moq:
                continue
            best = min(over_moq, key=lambda t: t.get("price_pln", 0) / (t.get("quantity") or 1))
            moq_met = False

        ppu = best.get("price_pln", 0) / (best.get("quantity") or 1)
        total = round(ppu * quantity, 4)
        tier_note = None
        if len(tiers) > 1:
            tier_lines = []
            for t in sorted(tiers, key=lambda x: x.get("price_pln", 0) / (x.get("quantity") or 1)):
                ppu_t = t.get("price_pln", 0) / (t.get("quantity") or 1)
                moq_str = f"MOQ {t['moq']:.0f} {t.get('unit','kg')}" if t.get("moq") else "brak MOQ"
                tier_lines.append(f"{ppu_t:.4f} PLN/{t.get('unit','kg')} ({moq_str})")
            tier_note = "Progi cenowe: " + " | ".join(tier_lines)
        combined_notes = "; ".join(filter(None, [best.get("notes"), tier_note]))
        results.append(CalcResult(
            id=best["id"],
            category=best.get("category", ""),
            product_name=best.get("product_name", ""),
            supplier=best.get("supplier", ""),
            unit=best.get("unit", "kg"),
            price_per_unit_pln=round(ppu, 4),
            total_cost_pln=total,
            moq=best.get("moq"),
            moq_met=moq_met,
            notes=combined_notes or None,
        ))

    results.sort(key=lambda r: (not r.moq_met, r.total_cost_pln))
    return results


# ── Recommendations ───────────────────────────────────────────────────────────

SPREAD_THRESHOLD = 0.40
GOOD_SAVINGS_PCT = 0.10

@app.get("/api/recommendations", response_model=list[RecommendResult], tags=["Decyzje"])
def recommendations(
    product_name: str = Query(...),
    quantity: float = Query(..., gt=0),
    unit: str = Query(...),
    include_over_moq: bool = Query(False),
    db: Database = Depends(get_db),
):
    items = list(db.quotations.find({
        "product_name": {"$regex": re.escape(product_name), "$options": "i"},
        "unit": unit,
    }))
    supplier_groups: dict[str, list] = defaultdict(list)
    for it in items:
        supplier_groups[it.get("supplier", "").strip().lower()].append(it)

    DDP_TERMS = {"DDP"}
    NON_DDP_TERMS = {"EXW", "FOB", "CIF", "DAP", "CPT", "CFR", "FCA", "DPU"}

    candidates = []
    for _, tiers in supplier_groups.items():
        eligible = [t for t in tiers if t.get("moq") is None or t["moq"] <= quantity]
        blocked_tiers = [t for t in tiers if t not in eligible]
        if eligible:
            best = min(eligible, key=lambda t: (
                t.get("price_pln", 0) / (t.get("quantity") or 1) + (t.get("logistics_cost_pln") or 0)
            ))
            moq_met = True
        else:
            if not include_over_moq:
                continue
            best = min(blocked_tiers, key=lambda t: (
                t.get("price_pln", 0) / (t.get("quantity") or 1) + (t.get("logistics_cost_pln") or 0)
            ))
            moq_met = False

        ppu = best.get("price_pln", 0) / (best.get("quantity") or 1)
        logistics = best.get("logistics_cost_pln") or 0.0
        eff_ppu = round(ppu + logistics, 4)
        total = round(ppu * quantity, 2)
        eff_total = round(eff_ppu * quantity, 2)
        tier_note = None
        if len(tiers) > 1:
            tier_parts = []
            for t in sorted(tiers, key=lambda x: x.get("price_pln", 0) / (x.get("quantity") or 1) + (x.get("logistics_cost_pln") or 0)):
                ppu_t = t.get("price_pln", 0) / (t.get("quantity") or 1)
                moq_str = f"MOQ {t['moq']:.0f} {t.get('unit','kg')}" if t.get("moq") else "brak MOQ"
                tier_parts.append(f"{ppu_t:.2f} PLN/{t.get('unit','kg')} ({moq_str})")
            tier_note = "Progi: " + " | ".join(tier_parts)
        combined_notes = "; ".join(filter(None, [best.get("notes"), tier_note]))
        incoterm = (best.get("incoterm") or "").upper().strip() or None
        candidates.append({
            "id": best["id"],
            "category": best.get("category", ""),
            "product_name": best.get("product_name", ""),
            "supplier": best.get("supplier", ""),
            "unit": best.get("unit", "kg"),
            "price_original": best.get("price_original", 0),
            "currency": best.get("currency", "PLN"),
            "ppu": round(ppu, 4),
            "eff_ppu": eff_ppu,
            "total": total,
            "eff_total": eff_total,
            "moq": best.get("moq"),
            "moq_met": moq_met,
            "notes": combined_notes or None,
            "incoterm": incoterm,
            "logistics_cost_pln": logistics if logistics else None,
        })

    if not candidates:
        return []

    candidates.sort(key=lambda c: (not c["moq_met"], c["eff_total"]))
    incoterms_present = {c["incoterm"] for c in candidates if c["incoterm"] and c["moq_met"]}
    has_ddp = bool(incoterms_present & DDP_TERMS)
    has_non_ddp = bool(incoterms_present & NON_DDP_TERMS)
    incoterm_mismatch = has_ddp and has_non_ddp
    eligible_eff_ppus = [c["eff_ppu"] for c in candidates if c["moq_met"]]
    spread = 0.0
    if len(eligible_eff_ppus) >= 2:
        spread = (max(eligible_eff_ppus) - min(eligible_eff_ppus)) / max(eligible_eff_ppus)
    spread_alert = spread > SPREAD_THRESHOLD

    results = []
    for i, c in enumerate(candidates):
        reason_codes: list[str] = []
        if not c["moq_met"]: reason_codes.append("moq_blocked")
        if spread_alert and c["moq_met"]: reason_codes.append("price_spread_high")
        if len([x for x in candidates if x["moq_met"]]) == 1 and c["moq_met"]: reason_codes.append("single_supplier")
        inc = c["incoterm"]
        if inc and inc not in DDP_TERMS and not c["logistics_cost_pln"] and c["moq_met"]: reason_codes.append("incoterm_no_logistics")
        if incoterm_mismatch and c["moq_met"]: reason_codes.append("incoterm_mismatch")
        next_eligible = next((x for x in candidates[i+1:] if x["moq_met"]), None) if c["moq_met"] else None
        savings_pln: Optional[float] = None
        savings_pct: Optional[float] = None
        if next_eligible and c["moq_met"]:
            savings_pln = round(next_eligible["eff_total"] - c["eff_total"], 2)
            savings_pct = round(savings_pln / next_eligible["eff_total"] * 100, 1) if next_eligible["eff_total"] else None
            if savings_pct and savings_pct >= GOOD_SAVINGS_PCT * 100: reason_codes.append("significant_savings")
        if not c["moq_met"]: verdict = "blocked"
        elif i == 0 and not incoterm_mismatch: verdict = "best"
        elif i == 0 and incoterm_mismatch: verdict = "caution"
        elif spread_alert or incoterm_mismatch: verdict = "caution"
        else: verdict = "good"
        results.append(RecommendResult(
            id=c["id"], category=c["category"], product_name=c["product_name"],
            supplier=c["supplier"], unit=c["unit"], price_original=c["price_original"],
            currency=c["currency"], price_per_unit_pln=c["ppu"],
            effective_price_per_unit_pln=c["eff_ppu"], total_cost_pln=c["total"],
            effective_total_cost_pln=c["eff_total"], moq=c["moq"], moq_met=c["moq_met"],
            notes=c["notes"], incoterm=c["incoterm"], logistics_cost_pln=c["logistics_cost_pln"],
            rank=i+1, verdict=verdict, reason_codes=reason_codes,
            savings_vs_next_pln=savings_pln, savings_vs_next_pct=savings_pct,
            price_spread_alert=spread_alert, incoterm_mismatch=incoterm_mismatch,
        ))
    return results


# ── Dashboard ─────────────────────────────────────────────────────────────────

@app.get("/api/dashboard", tags=["Decyzje"])
def dashboard(db: Database = Depends(get_db)):
    all_q = list(db.quotations.find({}))
    total = len(all_q)
    groups: dict[str, list] = defaultdict(list)
    for q in all_q:
        key = f"{(q.get('product_name') or '').strip()}|{q.get('unit','')}"
        qty = q.get("quantity") or 1
        ppu = q.get("price_pln", 0) / qty
        groups[key].append({"supplier": q.get("supplier"), "ppu": ppu, "moq": q.get("moq"),
                             "category": q.get("category"), "product_name": q.get("product_name"), "unit": q.get("unit")})
    unique_products = len(groups)
    multi_supplier = sum(1 for v in groups.values() if len({x["supplier"] for x in v}) > 1)
    moq_warnings = sum(1 for v in groups.values() for x in v if x.get("moq") and x["moq"] > 1)
    opportunities = []
    for key, offers in groups.items():
        suppliers = {o["supplier"] for o in offers}
        if len(suppliers) < 2: continue
        ppus = sorted([o["ppu"] for o in offers])
        best_ppu, worst_ppu = ppus[0], ppus[-1]
        spread_pct = round((worst_ppu - best_ppu) / worst_ppu * 100, 1) if worst_ppu else 0
        best_supplier = min(offers, key=lambda o: o["ppu"])["supplier"]
        opportunities.append({"product_name": offers[0]["product_name"], "unit": offers[0]["unit"],
                               "category": offers[0]["category"], "supplier_count": len(suppliers),
                               "best_ppu": round(best_ppu, 4), "worst_ppu": round(worst_ppu, 4),
                               "spread_pct": spread_pct, "best_supplier": best_supplier})
    opportunities.sort(key=lambda x: -x["spread_pct"])
    actionable = [o for o in opportunities if 10 <= o["spread_pct"] <= 97][:12]
    return {"total_quotations": total, "unique_products": unique_products,
            "products_multi_supplier": multi_supplier, "moq_warnings": moq_warnings,
            "savings_opportunities": actionable}


@app.get("/api/summary", tags=["Statystyki"])
def summary(db: Database = Depends(get_db)):
    all_q = list(db.quotations.find({}))
    products: dict[str, dict] = {}
    for q in all_q:
        key = f"{q.get('category')}|{q.get('product_name')}"
        qty = q.get("quantity") or 1
        ppu = round(q.get("price_pln", 0) / qty, 4)
        if key not in products:
            products[key] = {"category": q.get("category"), "product_name": q.get("product_name"),
                             "offer_count": 0, "best_price_per_unit_pln": None, "best_supplier": None}
        entry = products[key]
        entry["offer_count"] += 1
        if entry["best_price_per_unit_pln"] is None or ppu < entry["best_price_per_unit_pln"]:
            entry["best_price_per_unit_pln"] = ppu
            entry["best_supplier"] = q.get("supplier")
    return {"total_quotations": len(all_q), "products": list(products.values())}


# ── OCR / AI import ───────────────────────────────────────────────────────────

def _extract_domain_name(email: str) -> str:
    try:
        domain = email.split("@")[1].lower()
        domain = re.sub(r"\.(com|pl|de|cn|eu|net|org|co\.uk|com\.cn|info|biz)$", "", domain)
        domain = re.sub(r"^www\.", "", domain)
        return re.sub(r"[^a-z0-9]", "", domain)
    except Exception:
        return ""


def _ocr_match_supplier_from_email(rows: list[dict], known_suppliers: list[str]) -> None:
    from rapidfuzz import process, fuzz
    emails = list({r["contact_email"] for r in rows if r.get("contact_email")})
    if not emails or not known_suppliers:
        return
    norm_suppliers = {re.sub(r"[^a-z0-9]", "", s.lower()): s for s in known_suppliers}
    for email in emails:
        domain_token = _extract_domain_name(email)
        if not domain_token:
            continue
        exact = next((orig for norm, orig in norm_suppliers.items()
                      if domain_token in norm or norm in domain_token), None)
        if not exact:
            result = process.extractOne(domain_token, list(norm_suppliers.keys()),
                                        scorer=fuzz.partial_ratio, score_cutoff=70)
            exact = norm_suppliers[result[0]] if result else None
        if not exact:
            continue
        for row in rows:
            if row.get("contact_email") != email:
                continue
            current = row.get("supplier") or ""
            if not current:
                row["supplier"] = exact
                row["_supplier_from_email"] = True
            elif re.sub(r"[^a-z0-9]", "", current.lower()) != re.sub(r"[^a-z0-9]", "", exact.lower()):
                row["_suggested_supplier"] = exact


def _match_to_canonical(name: str, canonical: list[str], threshold: int = 72) -> Optional[str]:
    if not canonical or not name:
        return None
    from rapidfuzz import process, fuzz
    result = process.extractOne(name, canonical, scorer=fuzz.token_sort_ratio, score_cutoff=threshold)
    if result:
        matched, score, _ = result
        if matched.lower().strip() != name.lower().strip():
            return matched
    return None


UPLOADS_DIR = os.path.join(os.path.dirname(__file__), "uploads")
os.makedirs(UPLOADS_DIR, exist_ok=True)


@app.get("/api/uploads/{filename}", tags=["Pliki"])
async def download_upload(filename: str):
    safe = os.path.basename(filename)
    path = os.path.join(UPLOADS_DIR, safe)
    if not os.path.exists(path):
        raise HTTPException(status_code=404, detail="Plik nie istnieje")
    return FileResponse(path, filename=safe)


@app.post("/api/import/ocr", tags=["Import"])
async def import_ocr(file: UploadFile = File(...), db: Database = Depends(get_db)):
    content = await file.read()
    from datetime import datetime as dt
    import uuid
    orig_name = file.filename or "upload"
    ext = os.path.splitext(orig_name)[1]
    saved_name = f"{dt.now().strftime('%Y%m%d_%H%M%S')}_{uuid.uuid4().hex[:6]}{ext}"
    saved_path = os.path.join(UPLOADS_DIR, saved_name)
    with open(saved_path, "wb") as f:
        f.write(content)
    try:
        rows = await ocr_extract_from_file(orig_name, content)
    except ValueError as e:
        raise HTTPException(status_code=422, detail=str(e))
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Błąd OCR: {e}")

    canonical_products = list({d.get("product_name") for d in db.quotations.find({}, {"product_name": 1}) if d.get("product_name")})
    for row in rows:
        matched = _match_to_canonical(row.get("product_name", ""), canonical_products)
        if matched:
            row["_suggested_product"] = matched
    known_suppliers = list({d.get("supplier") for d in db.quotations.find({}, {"supplier": 1}) if d.get("supplier")})
    _ocr_match_supplier_from_email(rows, known_suppliers)
    return {"rows": rows, "count": len(rows), "source_file": saved_name, "source_file_orig": orig_name}


class OcrConfirmRequest(PydanticBaseModel):
    rows: list[dict]
    supplier_override: Optional[str] = None
    source_file: Optional[str] = None


@app.post("/api/import/ocr/confirm", tags=["Import"])
async def import_ocr_confirm(
    payload: OcrConfirmRequest,
    manual_rate: Optional[float] = Query(None),
    db: Database = Depends(get_db),
):
    saved, errors = [], []
    for row in payload.rows:
        if not row.get("product_name") or not row.get("price_original"):
            continue
        try:
            supplier = payload.supplier_override or row.get("supplier") or "OCR Import"
            currency = row.get("currency", "PLN")
            rate, _ = await get_rate(currency, manual_rate)
            price_original = float(row["price_original"])
            quantity = float(row.get("quantity") or 1)
            price_pln = round(convert_to_pln(price_original, currency, rate) * quantity, 4)
            new_id = next_id("quotations")
            doc = {
                "id": new_id,
                "created_at": datetime.now(),
                "product_name": str(row["product_name"]).strip(),
                "supplier": supplier,
                "price_original": price_original,
                "currency": currency,
                "quantity": quantity,
                "unit": str(row.get("unit") or "kg").strip(),
                "moq": float(row["moq"]) if row.get("moq") else None,
                "category": str(row.get("category") or "substancja_czynna"),
                "incoterm": str(row["incoterm"]).upper() if row.get("incoterm") else None,
                "notes": str(row.get("notes") or "").strip() or None,
                "quote_date": str(row["quote_date"]) if row.get("quote_date") else None,
                "contact_email": str(row["contact_email"]) if row.get("contact_email") else None,
                "source_file": payload.source_file or None,
                "price_pln": price_pln,
                "exchange_rate_used": rate,
                "price_type": str(row.get("price_type") or "netto").lower() or "netto",
            }
            db.quotations.insert_one(doc)
            saved.append(_enrich(doc))
        except Exception as e:
            errors.append({"row": row.get("product_name"), "error": str(e)})
    return {"saved": len(saved), "errors": errors}


# ── Config ────────────────────────────────────────────────────────────────────

@app.get("/api/config/openai-status", tags=["Konfiguracja"])
async def openai_status():
    import services.ocr_import as ocr_mod
    provider = None
    if ocr_mod.GROQ_API_KEY: provider = "groq"
    elif ocr_mod.GEMINI_API_KEY: provider = "gemini"
    elif ocr_mod.OPENAI_API_KEY: provider = "openai"
    return {"configured": bool(provider), "provider": provider,
            "has_groq": bool(ocr_mod.GROQ_API_KEY), "has_gemini": bool(ocr_mod.GEMINI_API_KEY),
            "has_openai": bool(ocr_mod.OPENAI_API_KEY)}


def _save_env_key(env_path: str, key_name: str, value: str):
    lines = []
    if os.path.exists(env_path):
        with open(env_path, encoding="utf-8") as f:
            lines = f.readlines()
    updated = False
    for i, l in enumerate(lines):
        if l.startswith(f"{key_name}="):
            lines[i] = f"{key_name}={value}\n"
            updated = True
            break
    if not updated:
        lines.append(f"{key_name}={value}\n")
    with open(env_path, "w", encoding="utf-8") as f:
        f.writelines(lines)


@app.post("/api/config/groq", tags=["Konfiguracja"])
async def save_groq_config(data: dict):
    key = (data.get("groq_key") or "").strip()
    if not key:
        raise HTTPException(status_code=422, detail="Podaj klucz API")
    env_path = os.path.join(os.path.dirname(__file__), ".env")
    _save_env_key(env_path, "GROQ_API_KEY", key)
    from dotenv import load_dotenv
    load_dotenv(env_path, override=True)
    import services.ocr_import as ocr_mod
    ocr_mod.GROQ_API_KEY = key
    return {"status": "saved", "provider": "groq"}


@app.post("/api/config/gemini", tags=["Konfiguracja"])
async def save_gemini_config(data: dict):
    key = (data.get("gemini_key") or "").strip()
    if not key:
        raise HTTPException(status_code=422, detail="Podaj klucz API")
    env_path = os.path.join(os.path.dirname(__file__), ".env")
    _save_env_key(env_path, "GEMINI_API_KEY", key)
    from dotenv import load_dotenv
    load_dotenv(env_path, override=True)
    import services.ocr_import as ocr_mod
    ocr_mod.GEMINI_API_KEY = key
    return {"status": "saved", "provider": "gemini"}


@app.post("/api/config/openai", tags=["Konfiguracja"])
async def save_openai_config(data: dict):
    key = (data.get("openai_key") or "").strip()
    if not key:
        raise HTTPException(status_code=422, detail="Podaj klucz API")
    env_path = os.path.join(os.path.dirname(__file__), ".env")
    _save_env_key(env_path, "OPENAI_API_KEY", key)
    from dotenv import load_dotenv
    load_dotenv(env_path, override=True)
    import services.ocr_import as ocr_mod
    ocr_mod.OPENAI_API_KEY = key
    return {"status": "saved", "provider": "openai"}


# ── Product names autocomplete ────────────────────────────────────────────────

@app.get("/api/products/names", tags=["Produkty"])
def get_product_names(db: Database = Depends(get_db)):
    names = sorted({d.get("product_name") for d in db.quotations.find({}, {"product_name": 1}) if d.get("product_name")})
    return {"names": names}


# ── Inbox (IMAP) ──────────────────────────────────────────────────────────────

@app.get("/api/inbox", tags=["Skrzynka"])
def inbox_list(db: Database = Depends(get_db)):
    docs = list(db.inbox_emails.find({}).sort("received_at", -1).limit(200))
    counts_raw = db.quotations.aggregate([
        {"$match": {"inbox_id": {"$ne": None}}},
        {"$group": {"_id": "$inbox_id", "cnt": {"$sum": 1}}},
    ])
    quotation_counts = {r["_id"]: r["cnt"] for r in counts_raw}
    result = []
    for doc in docs:
        d = _doc_to_dict(doc)
        d["quotation_count"] = quotation_counts.get(d.get("id"), 0)
        result.append(d)
    return result


@app.get("/api/inbox/status", tags=["Skrzynka"])
def inbox_status():
    return {"configured": inbox_svc.is_configured(), "host": inbox_svc.IMAP_HOST,
            "user": inbox_svc.IMAP_USER, "folder": inbox_svc.IMAP_FOLDER}


@app.post("/api/inbox/test", tags=["Skrzynka"])
def inbox_test():
    return inbox_svc.test_connection()


@app.post("/api/inbox/check", tags=["Skrzynka"])
def inbox_check(db: Database = Depends(get_db)):
    if not inbox_svc.is_configured():
        raise HTTPException(status_code=422, detail="Brak konfiguracji IMAP")
    known = {r["imap_uid"] for r in db.inbox_emails.find({}, {"imap_uid": 1})}
    try:
        raw_emails = inbox_svc.fetch_new_emails(known)
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Błąd IMAP: {e}")
    saved = 0
    for raw in raw_emails:
        try:
            new_id = next_id("inbox_emails")
            db.inbox_emails.insert_one({
                "id": new_id,
                "received_at": raw["received_at"],
                "fetched_at": datetime.now().isoformat(),
                "from_addr": raw["from_addr"],
                "subject": raw["subject"],
                "body_text": raw.get("body", "")[:4000],
                "attachments": raw.get("attachments", []),
                "extracted_rows": [],
                "status": "new",
                "imap_uid": raw["imap_uid"],
                "error": None,
                "source_files": [a["saved"] for a in raw.get("attachments", [])],
            })
            saved += 1
        except Exception:
            pass
    return {"fetched": len(raw_emails), "saved": saved}


@app.post("/api/inbox/{inbox_id}/analyze", tags=["Skrzynka"])
async def inbox_analyze(inbox_id: int, db: Database = Depends(get_db)):
    doc = db.inbox_emails.find_one({"id": inbox_id})
    if not doc:
        raise HTTPException(status_code=404, detail="Nie znaleziono")
    d = _doc_to_dict(doc)
    if d["status"] not in ("new", "error"):
        return {"ok": True, "rows": d.get("extracted_rows", [])}
    raw = {"from_addr": d["from_addr"], "body": d["body_text"],
           "attachments": d.get("attachments", []), "imap_uid": d.get("imap_uid", "")}
    try:
        processed = await inbox_svc.process_email(raw, db)
        extracted = processed["extracted_rows"]
        rows_list = json.loads(extracted) if isinstance(extracted, str) else extracted
        db.inbox_emails.update_one({"id": inbox_id}, {"$set": {
            "extracted_rows": rows_list,
            "status": "pending" if rows_list else "empty",
            "error": processed.get("error"),
        }})
        return {"ok": True, "rows": rows_list}
    except Exception as e:
        db.inbox_emails.update_one({"id": inbox_id}, {"$set": {"status": "error", "error": str(e)}})
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/api/inbox/{inbox_id}/confirm", tags=["Skrzynka"])
async def inbox_confirm(inbox_id: int, payload: dict = {}, db: Database = Depends(get_db)):
    doc = db.inbox_emails.find_one({"id": inbox_id})
    if not doc:
        raise HTTPException(status_code=404, detail="Nie znaleziono")
    d = _doc_to_dict(doc)
    rows_to_save = payload.get("rows") or d.get("extracted_rows", [])
    supplier_override = payload.get("supplier_override")
    source_files = d.get("source_files", [])

    saved, errors = [], []
    for r in rows_to_save:
        if not r.get("product_name") or not r.get("price_original"):
            continue
        try:
            supplier = supplier_override or r.get("supplier") or d["from_addr"]
            currency = r.get("currency", "PLN")
            rate, _ = await get_rate(currency, None)
            price_original = float(r["price_original"])
            quantity = float(r.get("quantity") or 1)
            price_pln = round(convert_to_pln(price_original, currency, rate) * quantity, 4)
            new_id = next_id("quotations")
            q_doc = {
                "id": new_id,
                "created_at": datetime.now(),
                "product_name": str(r["product_name"]).strip(),
                "supplier": supplier,
                "price_original": price_original,
                "currency": currency,
                "quantity": quantity,
                "unit": str(r.get("unit") or "kg"),
                "moq": float(r["moq"]) if r.get("moq") else None,
                "category": str(r.get("category") or "substancja_czynna"),
                "incoterm": str(r["incoterm"]).upper() if r.get("incoterm") else None,
                "notes": str(r.get("notes") or "").strip() or None,
                "quote_date": str(r["quote_date"]) if r.get("quote_date") else None,
                "contact_email": r.get("contact_email") or d.get("from_addr"),
                "source_file": source_files[0] if source_files else None,
                "price_pln": price_pln,
                "exchange_rate_used": rate,
                "inbox_id": inbox_id,
                "price_type": str(r.get("price_type") or "netto").lower() or "netto",
            }
            db.quotations.insert_one(q_doc)
            saved.append(new_id)
        except Exception as e:
            errors.append(str(e))

    db.inbox_emails.update_one({"id": inbox_id}, {"$set": {"status": "confirmed"}})
    return {"saved": len(saved), "errors": errors}


@app.post("/api/inbox/{inbox_id}/reject", tags=["Skrzynka"])
def inbox_reject(inbox_id: int, db: Database = Depends(get_db)):
    db.inbox_emails.update_one({"id": inbox_id}, {"$set": {"status": "rejected"}})
    return {"ok": True}


# ── IMAP config ───────────────────────────────────────────────────────────────

@app.post("/api/config/imap", tags=["Konfiguracja"])
async def save_imap_config(data: dict):
    env_path = os.path.join(os.path.dirname(__file__), ".env")
    fields = {
        "IMAP_HOST":    data.get("imap_host", ""),
        "IMAP_PORT":    str(data.get("imap_port", "993")),
        "IMAP_USER":    data.get("imap_user", ""),
        "IMAP_PASS":    data.get("imap_pass", ""),
        "IMAP_FOLDER":  data.get("imap_folder", "Wyceny"),
        "IMAP_USE_SSL": str(data.get("imap_ssl", True)).lower(),
    }
    for key, val in fields.items():
        if val:
            _save_env_key(env_path, key, val)
    from dotenv import load_dotenv
    load_dotenv(env_path, override=True)
    inbox_svc.IMAP_HOST = fields["IMAP_HOST"]
    inbox_svc.IMAP_PORT = int(fields["IMAP_PORT"])
    inbox_svc.IMAP_USER = fields["IMAP_USER"]
    inbox_svc.IMAP_PASS = fields["IMAP_PASS"]
    inbox_svc.IMAP_FOLDER = fields["IMAP_FOLDER"]
    inbox_svc.IMAP_USE_SSL = fields["IMAP_USE_SSL"] == "true"
    return {"status": "saved"}


# ── Suppliers ─────────────────────────────────────────────────────────────────

@app.get("/api/suppliers", tags=["Dostawcy"])
def list_suppliers(db: Database = Depends(get_db)):
    docs = list(db.quotations.find({}))
    suppliers: dict[str, dict] = {}
    for q in docs:
        s = q.get("supplier", "")
        if s not in suppliers:
            suppliers[s] = {"name": s, "product_count": 0, "categories": set(), "products": []}
        suppliers[s]["product_count"] += 1
        suppliers[s]["categories"].add(q.get("category", ""))
    return [{"name": d["name"], "product_count": d["product_count"], "categories": list(d["categories"])}
            for s, d in sorted(suppliers.items())]


@app.get("/api/suppliers/{supplier_name}/offers", tags=["Dostawcy"])
def supplier_offers(supplier_name: str, db: Database = Depends(get_db)):
    docs = list(db.quotations.find({"supplier": supplier_name}))
    return [_enrich(_doc_to_dict(d)) for d in docs]


@app.get("/api/suppliers/{supplier_name}/pipedrive", tags=["Dostawcy"])
async def supplier_pipedrive(supplier_name: str):
    return await get_supplier_pipedrive(supplier_name)


# ── SMTP / Pipedrive config ───────────────────────────────────────────────────

class SmtpConfig(PydanticBaseModel):
    smtp_host: str = ""
    smtp_port: str = "587"
    smtp_user: str = ""
    smtp_pass: str = ""
    pd_token:  str = ""
    pd_domain: str = ""


@app.post("/api/config/smtp", tags=["Konfiguracja"])
async def save_smtp_config(cfg: SmtpConfig):
    env_path = os.path.join(os.path.dirname(__file__), ".env")
    lines = []
    if os.path.exists(env_path):
        with open(env_path, encoding="utf-8") as f:
            lines = f.readlines()

    def _set(lines, key, value):
        key_eq = f"{key}="
        for i, l in enumerate(lines):
            if l.startswith(key_eq):
                lines[i] = f"{key}={value}\n"
                return lines
        lines.append(f"{key}={value}\n")
        return lines

    if cfg.smtp_host: lines = _set(lines, "SMTP_HOST", cfg.smtp_host)
    if cfg.smtp_port: lines = _set(lines, "SMTP_PORT", cfg.smtp_port)
    if cfg.smtp_user: lines = _set(lines, "SMTP_USER", cfg.smtp_user)
    if cfg.smtp_pass: lines = _set(lines, "SMTP_PASS", cfg.smtp_pass)
    if cfg.pd_token:  lines = _set(lines, "PIPEDRIVE_TOKEN", cfg.pd_token)
    if cfg.pd_domain: lines = _set(lines, "PIPEDRIVE_DOMAIN", cfg.pd_domain)
    with open(env_path, "w", encoding="utf-8") as f:
        f.writelines(lines)
    from dotenv import load_dotenv
    load_dotenv(env_path, override=True)
    import services.pipedrive as pd_mod
    import services.mailer as mailer_mod
    pd_mod.PIPEDRIVE_TOKEN  = os.getenv("PIPEDRIVE_TOKEN", "")
    pd_mod.PIPEDRIVE_DOMAIN = os.getenv("PIPEDRIVE_DOMAIN", "")
    pd_mod.invalidate_cache()
    mailer_mod.SMTP_HOST = os.getenv("SMTP_HOST", "smtp.gmail.com")
    mailer_mod.SMTP_PORT = int(os.getenv("SMTP_PORT", "587"))
    mailer_mod.SMTP_USER = os.getenv("SMTP_USER", "")
    mailer_mod.SMTP_PASS = os.getenv("SMTP_PASS", "")
    mailer_mod.SMTP_FROM = os.getenv("SMTP_FROM", "") or mailer_mod.SMTP_USER
    return {"status": "saved"}


# ── Order email ───────────────────────────────────────────────────────────────

class OrderRequest(PydanticBaseModel):
    supplier: str
    to_email: str
    subject: str
    message: str
    products: list[dict]


@app.post("/api/suppliers/send-order", tags=["Dostawcy"])
async def send_order(req: OrderRequest):
    rows_html = ""
    rows_text = ""
    for p in req.products:
        name = p.get("product_name", "")
        qty  = p.get("order_qty", "—")
        unit = p.get("unit", "")
        ppu  = p.get("price_per_unit_pln", 0)
        orig = p.get("price_original", 0)
        curr = p.get("currency", "PLN")
        rows_html += f"""<tr>
          <td style="padding:6px 12px;border-bottom:1px solid #eee">{name}</td>
          <td style="padding:6px 12px;border-bottom:1px solid #eee;text-align:right">{qty} {unit}</td>
          <td style="padding:6px 12px;border-bottom:1px solid #eee;text-align:right">{orig:.2f} {curr}</td>
          <td style="padding:6px 12px;border-bottom:1px solid #eee;text-align:right">{ppu:.2f} PLN/jedn.</td>
        </tr>"""
        rows_text += f"  - {name}: {qty} {unit} @ {orig:.2f} {curr} ({ppu:.2f} PLN/jedn.)\n"
    body_html = f"""<div style="font-family:Arial,sans-serif;max-width:700px;margin:0 auto">
      <h2 style="color:#1a6b3c">Zapytanie ofertowe / Zamówienie</h2>
      <p>{req.message.replace(chr(10), '<br>')}</p>
      <table style="width:100%;border-collapse:collapse;margin-top:16px">
        <thead><tr style="background:#2c3e50;color:#fff">
          <th style="padding:8px 12px;text-align:left">Produkt</th>
          <th style="padding:8px 12px;text-align:right">Ilość</th>
          <th style="padding:8px 12px;text-align:right">Cena oryg.</th>
          <th style="padding:8px 12px;text-align:right">PLN/jedn.</th>
        </tr></thead>
        <tbody>{rows_html}</tbody>
      </table>
      <p style="margin-top:24px;color:#666;font-size:13px">Wiadomość wygenerowana przez system Comparer.</p>
    </div>"""
    body_text = f"{req.message}\n\nProdukty:\n{rows_text}"
    try:
        send_order_email(req.to_email, req.subject, body_html, body_text)
        return {"status": "sent"}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))
