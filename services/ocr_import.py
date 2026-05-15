"""
AI-powered quotation extraction from any file.
Supports: PNG/JPG/WEBP images, PDF, Excel, Word, TXT

Provider priority:
  1. Google Gemini (free tier: 1500 req/day) — if GEMINI_API_KEY set
  2. OpenAI GPT-4o (paid)                    — if OPENAI_API_KEY set
"""
from __future__ import annotations
import base64
import io
import json
import os
import re
from pathlib import Path

from dotenv import load_dotenv

load_dotenv()

GROQ_API_KEY   = os.getenv("GROQ_API_KEY", "")
GEMINI_API_KEY = os.getenv("GEMINI_API_KEY", "")
OPENAI_API_KEY = os.getenv("OPENAI_API_KEY", "")

CATALOG_SYSTEM_PROMPT = """Jesteś ekspertem od odczytywania ofert i cenników dostawców.
Przeanalizuj podany tekst i wyodrębnij WSZYSTKIE produkty/substancje — nawet jeśli NIE MA cen.
Interesują Cię: nazwy substancji, informacje o dostępności, MOQ, dostawca, email kontaktowy.

Zwróć JSON (tablicę obiektów) w dokładnie takim formacie:
[
  {
    "product_name": "Pełna nazwa z wariantem np. Acerola organic 17% vC",
    "base_name": "Bazowa nazwa substancji bez specyfikacji np. Acerola",
    "supplier": "Nazwa dostawcy (jeśli widoczna, inaczej null)",
    "moq": 25,
    "unit": "kg",
    "category": "substancja_czynna",
    "notes": "Dodatkowe uwagi np. 'dostępny', '500 kg dostępny', 'dostępno marzec/kwiecień'",
    "contact_email": null
  }
]

Zasady:
- Wyodrębnij KAŻDY produkt/substancję widoczny w tekście, bez względu na to czy jest cena
- product_name: pełna nazwa wraz z wariantem/specyfikacją (procent, forma, ekstrakt itp.)
- base_name: bazowa (generyczna) nazwa substancji BEZ specyfikacji — np. "Acerola", "Chlorella", "Spirulina"
- moq: minimalne zamówienie w jednostkach (liczba) — jeśli widoczne "MOQ=25" → 25; jeśli brak → null
- unit: "kg", "g", "szt", "l" — zgadnij z kontekstu, domyślnie "kg"
- category: "substancja_czynna" dla substancji/suplementów, "opakowanie" dla opakowań, "kapsula" dla kapsułek
- notes: informacje o dostępności, terminie, ilości dostępnej — wklej dosłownie z tekstu
- supplier: szukaj nazwy firmy w nagłówku, stopce, podpisie emaila. Jeśli brak — null
- contact_email: adres email jeśli widoczny
- Zwróć TYLKO czysty JSON bez markdown, komentarzy ani wyjaśnień
"""

SYSTEM_PROMPT = """Jesteś ekspertem od odczytywania cenników i wycen ofertowych.
Przeanalizuj podany obraz lub tekst i wyodrębnij WSZYSTKIE pozycje cenowe.

Zwróć JSON (tablicę obiektów) w dokładnie takim formacie:
[
  {
    "product_name": "Pełna nazwa z wariantem np. Sodium Butyrate 98% regular powder",
    "base_name": "Bazowa nazwa substancji bez specyfikacji np. Sodium Butyrate",
    "supplier": "Nazwa dostawcy (jeśli widoczna, inaczej null)",
    "price_original": 123.45,
    "currency": "PLN",
    "quantity": 1.0,
    "unit": "kg",
    "moq": null,
    "category": "substancja_czynna",
    "incoterm": null,
    "notes": "Dodatkowe uwagi lub specyfikacja",
    "quote_date": null,
    "contact_email": null,
    "price_type": "netto"
  }
]

Zasady — BARDZO WAŻNE:

CENA jest zawsze podawana ZA 1 KG (lub za 1 szt/l). Ilość przy cenie oznacza MOQ (minimalne zamówienie), NIE zmienia jednostki ceny.

Przykład interpretacji:
  "Tauryna 27 zł/kg przy 25 kg"  →  price_original=27, quantity=1, moq=25, unit="kg"
  "Witamina C: 5kg=120zł/kg, 25kg=100zł/kg"  →  dwa wpisy:
      {price_original:120, quantity:1, moq:5, unit:"kg"}
      {price_original:100, quantity:1, moq:25, unit:"kg"}
  "Kapsułki 1000szt - 0,05 zł/szt MOQ 5000szt"  →  price_original=0.05, quantity=1, moq=5000, unit="szt"

Pozostałe zasady:
- currency: tylko "PLN", "EUR" lub "USD"
- category: "substancja_czynna" dla substancji/suplementów, "opakowanie" dla opakowań/butelek, "kapsula" dla kapsułek/tabletek
- unit: "kg", "g", "szt", "l" — odczytaj z dokumentu
- moq: minimalne zamówienie w jednostkach (kg, szt itp.) — jeśli brak, wstaw null
- quantity: zawsze 1 (cena za 1 jednostkę), chyba że cena podana jest za opakowanie (np. "butelka 500ml = 2,50 zł za butelkę")
- supplier: szukaj nazwy firmy w nagłówku, stopce, podpisie emaila, logo, nazwie nadawcy, domenie emaila (np. "A-Sense", "Aogubio"). Jeśli brak — null
- contact_email: adres email nadawcy lub kontaktowy widoczny w dokumencie
- price_type: "netto" jeśli cena jest netto/bez VAT (najczęściej w ofertach B2B), "brutto" jeśli cena zawiera VAT; jeśli nie wskazano — domyślnie "netto"
- base_name: bazowa (generyczna) nazwa substancji/produktu BEZ specyfikacji technicznych (procent czystości, forma, granulacja, powłoka itp.). Przykłady: "Sodium Butyrate 98% regular powder" → base_name="Sodium Butyrate"; "Vitamin C Ascorbic Acid 99% fine" → base_name="Vitamin C Ascorbic Acid"; "Magnesium Citrate" → base_name="Magnesium Citrate". Jeśli produkt nie ma wariantów — wstaw tę samą wartość co product_name.
- Jeśli są progi cenowe (różne ceny przy różnych ilościach) — zwróć OSOBNY wpis dla każdego progu
- Zwróć TYLKO czysty JSON bez markdown, komentarzy ani wyjaśnień
"""


# ─── Helpers ──────────────────────────────────────────────────────────────────

def _to_base64_image(image_bytes: bytes, mime: str) -> str:
    return f"data:{mime};base64,{base64.b64encode(image_bytes).decode()}"


def _pdf_to_images(pdf_bytes: bytes) -> list[tuple[bytes, str]]:
    """Convert each PDF page to PNG bytes."""
    import fitz  # PyMuPDF
    doc = fitz.open(stream=pdf_bytes, filetype="pdf")
    images = []
    for page in doc:
        mat = fitz.Matrix(2, 2)
        pix = page.get_pixmap(matrix=mat)
        images.append((pix.tobytes("png"), "image/png"))
    doc.close()
    return images


def _parse_json_response(raw: str) -> list[dict]:
    raw = re.sub(r"```(?:json)?\s*", "", raw).strip().rstrip("`")
    try:
        data = json.loads(raw)
        if isinstance(data, dict) and "items" in data:
            data = data["items"]
        if not isinstance(data, list):
            data = [data]
        return data
    except json.JSONDecodeError:
        # Try to find a complete [...] array
        m = re.search(r"\[.*\]", raw, re.DOTALL)
        if m:
            try:
                return json.loads(m.group())
            except json.JSONDecodeError:
                pass

        # Response was truncated mid-JSON — recover complete objects
        # Find all complete {...} objects inside the partial array
        items = []
        for m in re.finditer(r"\{[^{}]*(?:\{[^{}]*\}[^{}]*)?\}", raw, re.DOTALL):
            try:
                obj = json.loads(m.group())
                if isinstance(obj, dict) and obj.get("product_name"):
                    items.append(obj)
            except json.JSONDecodeError:
                continue
        return items


# ─── Groq provider ────────────────────────────────────────────────────────────

# Models tried in order; vision models first, text-only fallback last
# Updated May 2026 — see https://console.groq.com/docs/models
_GROQ_VISION_MODELS = [
    "meta-llama/llama-4-scout-17b-16e-instruct",  # vision + text, preview
]
_GROQ_TEXT_MODELS = [
    "llama-3.3-70b-versatile",    # production, best quality text
    "openai/gpt-oss-120b",        # production, highest quality
    "openai/gpt-oss-20b",         # production, fastest
    "llama-3.1-8b-instant",       # production, emergency fallback
]


def _call_groq(content_parts: list[dict], system_prompt: str = SYSTEM_PROMPT) -> list[dict]:
    """Call Groq with automatic model fallback and retry on rate limits."""
    import time
    from groq import Groq, RateLimitError

    client = Groq(api_key=GROQ_API_KEY)

    has_images = any(p["type"] == "image_url" for p in content_parts)

    # Build user message parts (OpenAI-compatible format)
    def build_user_parts(allow_images: bool):
        parts = []
        for p in content_parts:
            if p["type"] == "text":
                parts.append({"type": "text", "text": p["text"]})
            elif p["type"] == "image_url" and allow_images:
                parts.append({
                    "type": "image_url",
                    "image_url": {"url": p["image_url"]["url"]},
                })
        return parts

    models_to_try = []
    if has_images:
        models_to_try = _GROQ_VISION_MODELS + _GROQ_TEXT_MODELS
    else:
        models_to_try = _GROQ_VISION_MODELS + _GROQ_TEXT_MODELS

    last_error = None
    for model in models_to_try:
        is_vision = model in _GROQ_VISION_MODELS
        user_parts = build_user_parts(allow_images=is_vision)

        for attempt in range(3):
            try:
                response = client.chat.completions.create(
                    model=model,
                    messages=[
                        {"role": "system", "content": system_prompt},
                        {"role": "user",   "content": user_parts},
                    ],
                    max_tokens=8192,
                    temperature=0,
                )
                raw = response.choices[0].message.content or ""
                return _parse_json_response(raw)
            except RateLimitError as e:
                last_error = e
                wait = 2 ** (attempt + 1)   # 2, 4, 8 s
                print(f"[Groq] Rate limit on {model} (attempt {attempt+1}), waiting {wait}s …")
                time.sleep(wait)
                if attempt == 2:
                    print(f"[Groq] Giving up on {model}, trying next model.")
                    break
            except Exception as e:
                last_error = e
                print(f"[Groq] Error on {model}: {e}")
                break  # try next model immediately

    raise RuntimeError(f"All Groq models exhausted. Last error: {last_error}")


# ─── Gemini provider ──────────────────────────────────────────────────────────

def _call_gemini(content_parts: list[dict], system_prompt: str = SYSTEM_PROMPT) -> list[dict]:
    """Call Google Gemini via new google-genai SDK."""
    from google import genai
    from google.genai import types

    client = genai.Client(api_key=GEMINI_API_KEY)

    # Build parts list for the new SDK
    parts = [types.Part.from_text(text=system_prompt)]
    for part in content_parts:
        if part["type"] == "text":
            parts.append(types.Part.from_text(text=part["text"]))
        elif part["type"] == "image_url":
            url = part["image_url"]["url"]
            header, b64 = url.split(",", 1)
            mime = header.split(":")[1].split(";")[0]
            img_bytes = base64.b64decode(b64)
            parts.append(types.Part.from_bytes(data=img_bytes, mime_type=mime))

    response = client.models.generate_content(
        model="gemini-2.0-flash-lite",
        contents=[types.Content(role="user", parts=parts)],
        config=types.GenerateContentConfig(
            temperature=0,
            max_output_tokens=4096,
        ),
    )
    raw = response.text or ""
    return _parse_json_response(raw)


# ─── OpenAI provider ──────────────────────────────────────────────────────────

def _call_openai(content_parts: list[dict], system_prompt: str = SYSTEM_PROMPT) -> list[dict]:
    """Call OpenAI GPT-4o (paid)."""
    from openai import OpenAI
    client = OpenAI(api_key=OPENAI_API_KEY)

    response = client.chat.completions.create(
        model="gpt-4o",
        messages=[
            {"role": "system", "content": system_prompt},
            {"role": "user",   "content": content_parts},
        ],
        max_tokens=4096,
        temperature=0,
    )
    raw = response.choices[0].message.content or ""
    return _parse_json_response(raw)


# ─── Sanitize ─────────────────────────────────────────────────────────────────

def _sanitize(rows: list[dict], catalog_mode: bool = False) -> list[dict]:
    """Validate and clean extracted rows, fill defaults."""
    clean = []
    valid_currencies = {"PLN", "EUR", "USD"}
    valid_categories = {"substancja_czynna", "opakowanie", "kapsula"}

    for r in rows:
        if not r.get("product_name"):
            continue

        category = str(r.get("category") or "substancja_czynna").lower()
        if category not in valid_categories:
            category = "substancja_czynna"

        try:
            moq = float(str(r["moq"]).replace(",", ".")) if r.get("moq") else None
        except (ValueError, TypeError):
            moq = None

        if catalog_mode:
            # Catalog mode — no price required
            clean.append({
                "product_name":  str(r["product_name"]).strip(),
                "base_name":     str(r.get("base_name") or "").strip() or None,
                "supplier":      str(r["supplier"]).strip() if r.get("supplier") else None,
                "moq":           moq,
                "unit":          str(r.get("unit") or "kg").strip(),
                "category":      category,
                "notes":         str(r.get("notes") or "").strip() or None,
                "contact_email": r.get("contact_email") or None,
                "_source":       "ocr_catalog",
            })
            continue

        # Normal quotation mode — price required
        if not r.get("price_original"):
            continue
        try:
            price = float(str(r["price_original"]).replace(",", "."))
        except (ValueError, TypeError):
            continue
        if price <= 0:
            continue

        currency = str(r.get("currency") or "PLN").upper()
        if currency not in valid_currencies:
            currency = "PLN"

        try:
            qty = float(str(r.get("quantity") or 1).replace(",", "."))
        except (ValueError, TypeError):
            qty = 1.0

        clean.append({
            "product_name":   str(r["product_name"]).strip(),
            "base_name":      str(r.get("base_name") or "").strip() or None,
            "supplier":       str(r["supplier"]).strip() if r.get("supplier") else None,
            "price_original": round(price, 4),
            "currency":       currency,
            "quantity":       qty,
            "unit":           str(r.get("unit") or "kg").strip(),
            "moq":            moq,
            "category":       category,
            "incoterm":       str(r["incoterm"]).upper() if r.get("incoterm") else None,
            "notes":          str(r.get("notes") or "").strip() or None,
            "quote_date":     r.get("quote_date") or None,
            "contact_email":  r.get("contact_email") or None,
            "price_type":     "brutto" if str(r.get("price_type") or "").lower() == "brutto" else "netto",
            "_source":        "ocr",
        })
    return clean


# ─── Enrich supplier from email domain ────────────────────────────────────────

def _domain_to_name(email: str) -> str | None:
    """Extract a clean company name guess from an email domain."""
    try:
        domain = email.split("@")[1].lower()
        # strip common TLDs and www
        name = re.sub(r"\.(com|pl|de|cn|eu|net|org|co\.uk|com\.cn)$", "", domain)
        name = name.replace("-", " ").replace("_", " ").strip()
        return name.title() if name else None
    except Exception:
        return None


def _enrich_supplier_from_email(rows: list[dict]) -> list[dict]:
    """
    If a row has contact_email but no supplier, guess supplier from email domain.
    Also propagate the most common email/supplier across all rows.
    """
    if not rows:
        return rows

    # Find the most common contact_email across rows
    emails = [r.get("contact_email") for r in rows if r.get("contact_email")]
    best_email: str | None = None
    if emails:
        freq: dict[str, int] = {}
        for e in emails:
            freq[e] = freq.get(e, 0) + 1
        best_email = max(freq, key=lambda k: freq[k])

    # Find the most common supplier name across rows
    suppliers = [r.get("supplier") for r in rows if r.get("supplier")]
    best_supplier: str | None = None
    if suppliers:
        freq2: dict[str, int] = {}
        for s in suppliers:
            freq2[s] = freq2.get(s, 0) + 1
        best_supplier = max(freq2, key=lambda k: freq2[k])

    # Guess supplier from email domain if not detected by AI
    email_supplier: str | None = None
    if best_email and not best_supplier:
        email_supplier = _domain_to_name(best_email)

    final_supplier = best_supplier or email_supplier

    for r in rows:
        # Propagate email to all rows
        if best_email and not r.get("contact_email"):
            r["contact_email"] = best_email
        # Fill missing supplier
        if not r.get("supplier") and final_supplier:
            r["supplier"] = final_supplier

    return rows


# ─── Main entry point ─────────────────────────────────────────────────────────

async def extract_from_file(filename: str, file_bytes: bytes, catalog_mode: bool = False) -> list[dict]:
    """
    Accepts any file, returns extracted quotation rows.
    Uses Gemini if GEMINI_API_KEY set, otherwise OpenAI.
    Raises ValueError if no API key configured.
    """
    has_groq   = bool(GROQ_API_KEY)
    has_gemini = bool(GEMINI_API_KEY)
    has_openai = bool(OPENAI_API_KEY)

    if not has_groq and not has_gemini and not has_openai:
        raise ValueError(
            "Brak klucza API — skonfiguruj darmowy klucz Groq "
            "(console.groq.com) lub Google Gemini (aistudio.google.com/apikey) "
            "w Ustawieniach aplikacji."
        )

    suffix = Path(filename).suffix.lower()
    content_parts: list[dict] = []

    # ── PDF ───────────────────────────────────────────────────────────────────
    if suffix == ".pdf":
        pages = _pdf_to_images(file_bytes)
        if not pages:
            raise ValueError("Nie można odczytać stron z pliku PDF.")
        for i, (img_bytes, mime) in enumerate(pages[:8]):
            if i > 0:
                content_parts.append({"type": "text", "text": f"--- Strona {i+1} ---"})
            content_parts.append({
                "type": "image_url",
                "image_url": {"url": _to_base64_image(img_bytes, mime), "detail": "high"},
            })

    # ── Images ────────────────────────────────────────────────────────────────
    elif suffix in {".png", ".jpg", ".jpeg", ".webp", ".gif", ".bmp", ".tiff", ".tif"}:
        mime_map = {
            ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg",
            ".webp": "image/webp", ".gif": "image/gif",
            ".bmp": "image/bmp", ".tiff": "image/tiff", ".tif": "image/tiff",
        }
        mime = mime_map.get(suffix, "image/png")
        content_parts.append({
            "type": "image_url",
            "image_url": {"url": _to_base64_image(file_bytes, mime), "detail": "high"},
        })

    # ── Excel ─────────────────────────────────────────────────────────────────
    elif suffix in {".xlsx", ".xls"}:
        import pandas as pd
        try:
            dfs = pd.read_excel(io.BytesIO(file_bytes), sheet_name=None, header=None)
            text_parts = []
            for sheet, df in dfs.items():
                text_parts.append(f"=== Arkusz: {sheet} ===")
                text_parts.append(df.fillna("").to_string(index=False))
            text = "\n".join(text_parts)
        except Exception as e:
            raise ValueError(f"Nie można odczytać pliku Excel: {e}")
        content_parts.append({"type": "text", "text": text[:12000]})

    # ── Text / CSV ─────────────────────────────────────────────────────────────
    elif suffix in {".txt", ".csv", ".tsv"}:
        try:
            text = file_bytes.decode("utf-8", errors="replace")
        except Exception:
            text = file_bytes.decode("latin-1", errors="replace")
        content_parts.append({"type": "text", "text": text[:12000]})

    # ── Word ──────────────────────────────────────────────────────────────────
    elif suffix in {".docx", ".doc"}:
        try:
            import docx
            doc = docx.Document(io.BytesIO(file_bytes))
            text = "\n".join(p.text for p in doc.paragraphs)
        except Exception:
            text = file_bytes.decode("utf-8", errors="replace")
        content_parts.append({"type": "text", "text": text[:12000]})

    else:
        try:
            text = file_bytes.decode("utf-8", errors="replace")
        except Exception:
            raise ValueError(f"Nieobsługiwany format pliku: {suffix}")
        content_parts.append({"type": "text", "text": text[:12000]})

    if not content_parts:
        raise ValueError("Nie udało się przetworzyć pliku.")

    intro_text = (
        f"Plik: {filename}\nWyodrębnij wszystkie produkty/substancje z poniższego dokumentu (bez względu na brak ceny):"
        if catalog_mode else
        f"Plik: {filename}\nWyodrębnij wszystkie wyceny produktów z poniższego dokumentu:"
    )
    content_parts.insert(0, {"type": "text", "text": intro_text})

    active_prompt = CATALOG_SYSTEM_PROMPT if catalog_mode else SYSTEM_PROMPT

    # ── Choose provider: Groq → Gemini → OpenAI ──────────────────────────────
    if has_groq:
        rows = _call_groq(content_parts, system_prompt=active_prompt)
    elif has_gemini:
        rows = _call_gemini(content_parts, system_prompt=active_prompt)
    else:
        rows = _call_openai(content_parts, system_prompt=active_prompt)

    rows = _sanitize(rows, catalog_mode=catalog_mode)
    rows = _enrich_supplier_from_email(rows)
    return rows
