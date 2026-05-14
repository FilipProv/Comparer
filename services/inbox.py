"""
IMAP inbox monitor — read-only access via EXAMINE command.

Key guarantees:
  • EXAMINE opens the mailbox in read-only mode (RFC 3501 §6.3.2).
    The server MUST NOT change any message flags or state.
  • FETCH BODY.PEEK[] fetches the full message without setting the \\Seen flag.
  • No STORE, COPY, MOVE or EXPUNGE commands are ever issued.
"""
from __future__ import annotations

import email
import imaplib
import json
import os
import re
import uuid
from datetime import datetime
from email.header import decode_header
from email.utils import parseaddr, parsedate_to_datetime
from pathlib import Path
from typing import Optional

from dotenv import load_dotenv

load_dotenv()

IMAP_HOST    = os.getenv("IMAP_HOST", "")
IMAP_PORT    = int(os.getenv("IMAP_PORT", "993"))
IMAP_USER    = os.getenv("IMAP_USER", "")
IMAP_PASS    = os.getenv("IMAP_PASS", "")
IMAP_FOLDER  = os.getenv("IMAP_FOLDER", "INBOX")
IMAP_USE_SSL = os.getenv("IMAP_USE_SSL", "true").lower() == "true"

# Subject keywords that indicate a quotation-related email (case-insensitive)
QUOTATION_KEYWORDS = [
    "wycen",        # wycena, wyceny, wycenę
    "cennik",
    "cena ",
    "ceny ",
    "ofert",        # oferta, ofertowe, oferty
    "zapytanie",
    "quotation",
    "price list",
    "pricelist",
    "price offer",
    "substancj",    # substancja, substancje
    "surowc",       # surowiec, surowce
]

UPLOADS_DIR = Path(__file__).parent.parent / "uploads"
UPLOADS_DIR.mkdir(exist_ok=True)


def is_configured() -> bool:
    return bool(IMAP_HOST and IMAP_USER and IMAP_PASS)


# ── String helpers ────────────────────────────────────────────────────────────

def _decode_header_str(value: str) -> str:
    parts = decode_header(value or "")
    result = []
    for part, charset in parts:
        if isinstance(part, bytes):
            result.append(part.decode(charset or "utf-8", errors="replace"))
        else:
            result.append(str(part))
    return "".join(result)


def _decode_bytes(data: bytes, declared_charset: str) -> str:
    """Try declared charset then common Polish encodings."""
    charsets = [declared_charset or "utf-8", "utf-8", "windows-1250", "iso-8859-2", "latin-1"]
    for cs in charsets:
        try:
            return data.decode(cs)
        except (UnicodeDecodeError, LookupError):
            continue
    return data.decode("utf-8", errors="replace")


def _html_to_text(html: str) -> str:
    import html as html_mod
    text = html_mod.unescape(html)
    text = re.sub(r"<br\s*/?>", "\n", text, flags=re.IGNORECASE)
    text = re.sub(r"<[^>]+>", " ", text)
    text = re.sub(r"[ \t]+", " ", text)
    text = re.sub(r"\n{3,}", "\n\n", text)
    return text.strip()


# ── Message parsing ───────────────────────────────────────────────────────────

def _get_body(msg: email.message.Message) -> str:
    plain = ""
    html_text = ""

    if msg.is_multipart():
        for part in msg.walk():
            ct   = part.get_content_type()
            disp = str(part.get("Content-Disposition") or "")
            if "attachment" in disp:
                continue
            payload = part.get_payload(decode=True)
            if not payload:
                continue
            charset = part.get_content_charset() or "utf-8"
            if ct == "text/plain" and not plain:
                decoded = _decode_bytes(payload, charset).strip()
                if decoded:
                    plain = decoded
            elif ct == "text/html" and not html_text:
                decoded = _decode_bytes(payload, charset)
                html_text = _html_to_text(decoded)
    else:
        payload = msg.get_payload(decode=True)
        if payload:
            charset = msg.get_content_charset() or "utf-8"
            decoded = _decode_bytes(payload, charset)
            if msg.get_content_type() == "text/html":
                plain = _html_to_text(decoded)
            else:
                plain = decoded.strip()

    return plain or html_text


def _save_attachment(part: email.message.Message, ts: str) -> Optional[dict]:
    filename = part.get_filename()
    if not filename:
        return None
    filename = _decode_header_str(filename)
    ext = Path(filename).suffix.lower()
    allowed = {".pdf", ".png", ".jpg", ".jpeg", ".webp", ".gif",
               ".xlsx", ".xls", ".docx", ".doc", ".txt", ".csv"}
    if ext not in allowed:
        return None
    data = part.get_payload(decode=True)
    if not data:
        return None
    safe_name = f"{ts}_{uuid.uuid4().hex[:6]}{ext}"
    (UPLOADS_DIR / safe_name).write_bytes(data)
    return {"original": filename, "saved": safe_name, "size": len(data)}


def _subject_is_quotation(subject: str) -> bool:
    s = subject.lower()
    return any(kw in s for kw in QUOTATION_KEYWORDS)


def _msg_uid(msg: email.message.Message) -> str:
    """Stable unique ID: Message-ID header or hash fallback."""
    mid = msg.get("Message-ID", "").strip()
    if not mid:
        raw = f"{msg.get('From','')}{msg.get('Date','')}{msg.get('Subject','')}"
        mid = str(hash(raw))
    return mid


# ── IMAP connection (read-only) ───────────────────────────────────────────────

def _connect() -> imaplib.IMAP4:
    """Return an authenticated IMAP connection. Caller must close it."""
    if IMAP_USE_SSL:
        conn = imaplib.IMAP4_SSL(IMAP_HOST, IMAP_PORT)
    else:
        conn = imaplib.IMAP4(IMAP_HOST, IMAP_PORT)
    conn.login(IMAP_USER, IMAP_PASS)
    return conn


def _examine(conn: imaplib.IMAP4, folder: str = "INBOX") -> bool:
    """
    Open *folder* in read-only mode using SELECT with readonly=True
    (imaplib sends EXAMINE command internally).
    Returns True on success; tries INBOX as fallback.
    """
    status, _ = conn.select(f'"{folder}"', readonly=True)
    if status == "OK":
        return True
    status, _ = conn.select(folder, readonly=True)
    if status == "OK":
        return True
    status, _ = conn.select("INBOX", readonly=True)
    return status == "OK"


# ── Public API ────────────────────────────────────────────────────────────────

def fetch_new_emails(known_uids: set[str]) -> list[dict]:
    """
    Connect via IMAP EXAMINE (read-only), fetch all messages,
    filter by subject keywords, skip already-known Message-IDs.
    Returns list of raw email dicts — does NOT modify any server state.
    """
    if not is_configured():
        raise ValueError("Brak konfiguracji IMAP — uzupełnij ustawienia w aplikacji.")

    conn = _connect()
    results = []

    try:
        if not _examine(conn, IMAP_FOLDER):
            raise RuntimeError(f"Nie można otworzyć skrzynki '{IMAP_FOLDER}' w trybie read-only.")

        # Fetch UIDs of ALL messages
        status, data = conn.uid("SEARCH", None, "ALL")
        if status != "OK" or not data or not data[0]:
            return []

        uids = data[0].split()

        for uid in uids:
            uid_str = uid.decode()

            # Fetch ONLY headers first (BODY.PEEK[HEADER] — no \Seen flag)
            status, hdr_data = conn.uid(
                "FETCH", uid_str, "(BODY.PEEK[HEADER])"
            )
            if status != "OK" or not hdr_data or not hdr_data[0]:
                continue

            raw_hdr = hdr_data[0][1] if isinstance(hdr_data[0], tuple) else b""
            if not raw_hdr:
                continue

            hdr_msg = email.message_from_bytes(raw_hdr)
            subject = _decode_header_str(hdr_msg.get("Subject", ""))

            if not _subject_is_quotation(subject):
                continue

            msg_id = _msg_uid(hdr_msg)
            if msg_id in known_uids:
                continue

            # Fetch full message — BODY.PEEK[] does NOT set \Seen flag
            status, full_data = conn.uid(
                "FETCH", uid_str, "(BODY.PEEK[])"
            )
            if status != "OK" or not full_data or not full_data[0]:
                continue

            raw_full = full_data[0][1] if isinstance(full_data[0], tuple) else b""
            if not raw_full:
                continue

            msg = email.message_from_bytes(raw_full)

            # Parse date
            date_str = msg.get("Date", "")
            try:
                received_at = parsedate_to_datetime(date_str).isoformat()
            except Exception:
                received_at = datetime.now().isoformat()

            ts = datetime.now().strftime("%Y%m%d_%H%M%S")
            _, from_addr = parseaddr(msg.get("From", ""))
            subject = _decode_header_str(msg.get("Subject", "(brak tematu)"))
            body = _get_body(msg)

            # Save attachments locally (read from message bytes — no server change)
            attachments = []
            if msg.is_multipart():
                for part in msg.walk():
                    if part.get_content_disposition() == "attachment":
                        att = _save_attachment(part, ts)
                        if att:
                            attachments.append(att)

            results.append({
                "imap_uid":    msg_id,
                "received_at": received_at,
                "from_addr":   from_addr,
                "subject":     subject,
                "body":        body,
                "attachments": attachments,
            })

    finally:
        try:
            conn.logout()
        except Exception:
            pass

    return results


async def process_email(raw: dict, db_session) -> dict:
    """Run OCR/AI extraction on email body + attachments."""
    from services.ocr_import import extract_from_file

    all_rows = []
    errors   = []
    source_files = [a["saved"] for a in raw.get("attachments", [])]

    body = raw.get("body", "").strip()
    if len(body) > 50:
        try:
            rows = await extract_from_file("email_body.txt", body.encode("utf-8"))
            for r in rows:
                if not r.get("contact_email") and raw.get("from_addr"):
                    r["contact_email"] = raw["from_addr"]
            all_rows.extend(rows)
        except Exception as e:
            errors.append(f"Treść maila: {e}")

    for att in raw.get("attachments", []):
        path = UPLOADS_DIR / att["saved"]
        if not path.exists():
            continue
        try:
            data = path.read_bytes()
            rows = await extract_from_file(att["original"], data)
            for r in rows:
                if not r.get("contact_email") and raw.get("from_addr"):
                    r["contact_email"] = raw["from_addr"]
            all_rows.extend(rows)
        except Exception as e:
            errors.append(f"{att['original']}: {e}")

    return {
        "imap_uid":       raw.get("imap_uid", ""),
        "received_at":    raw.get("received_at", ""),
        "from_addr":      raw.get("from_addr", ""),
        "subject":        raw.get("subject", ""),
        "body_text":      body[:4000],
        "attachments":    json.dumps(raw.get("attachments", []), ensure_ascii=False),
        "extracted_rows": json.dumps(all_rows, ensure_ascii=False),
        "source_files":   json.dumps(source_files, ensure_ascii=False),
        "status":         "pending" if all_rows else "empty",
        "error":          "; ".join(errors) if errors else None,
    }


def test_connection() -> dict:
    """Test IMAP connection (read-only EXAMINE) and return status info."""
    try:
        conn = _connect()
        ok = _examine(conn, IMAP_FOLDER)
        if ok:
            # Count messages without touching flags
            status, data = conn.uid("SEARCH", None, "ALL")
            total = len(data[0].split()) if status == "OK" and data[0] else 0
        else:
            total = 0
        try:
            conn.logout()
        except Exception:
            pass
        return {
            "ok":       ok,
            "protocol": "IMAP-SSL" if IMAP_USE_SSL else "IMAP",
            "host":     IMAP_HOST,
            "port":     IMAP_PORT,
            "folder":   IMAP_FOLDER,
            "messages": total,
            "readonly": True,
            "keywords": QUOTATION_KEYWORDS,
        }
    except Exception as e:
        return {"ok": False, "error": str(e)}
