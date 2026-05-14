"""
Currency service — fetches EUR/USD → PLN exchange rates from NBP API.
Rates are cached in memory for 1 hour to avoid hammering the API.
Fallback: caller can supply a manual rate if NBP is unavailable.
"""

import time
from datetime import datetime
from typing import Optional
import httpx

NBP_BASE = "https://api.nbp.pl/api/exchangerates/rates/A"
CACHE_TTL = 3600  # seconds

_cache: dict[str, tuple[float, float]] = {}

# Fallback rates (approximate) used when NBP API is unreachable
_FALLBACK_RATES: dict[str, float] = {
    "EUR": 4.25,
    "USD": 3.90,
    "GBP": 4.95,
    "CHF": 4.35,
    "CNY": 0.54,
    "CZK": 0.17,
}
# key: currency code ("EUR"/"USD")  value: (rate, timestamp)


async def _fetch_rate(currency: str) -> Optional[float]:
    """Fetch the current mid rate for `currency` against PLN from NBP."""
    url = f"{NBP_BASE}/{currency.lower()}/?format=json"
    try:
        async with httpx.AsyncClient(timeout=8.0) as client:
            resp = await client.get(url)
            resp.raise_for_status()
            data = resp.json()
            return float(data["rates"][0]["mid"])
    except Exception:
        return None


async def get_rate(currency: str, manual_rate: Optional[float] = None) -> tuple[float, str]:
    """
    Return (rate_to_pln, source_description).
    Priority: cache → NBP API → manual_rate → raises ValueError.
    """
    currency = currency.upper()
    if currency == "PLN":
        return 1.0, "PLN"

    now = time.monotonic()
    cached = _cache.get(currency)
    if cached and (now - cached[1]) < CACHE_TTL:
        return cached[0], "NBP (cache)"

    rate = await _fetch_rate(currency)
    if rate is not None:
        _cache[currency] = (rate, now)
        return rate, f"NBP {datetime.now().strftime('%Y-%m-%d')}"

    if manual_rate is not None and manual_rate > 0:
        return manual_rate, "kurs ręczny"

    fallback = _FALLBACK_RATES.get(currency)
    if fallback:
        return fallback, f"kurs przybliżony ({currency})"

    raise ValueError(
        f"Nie można pobrać kursu {currency}/PLN z NBP API i nie podano kursu ręcznego."
    )


async def get_all_rates() -> dict:
    """Return a dict with EUR and USD rates plus metadata."""
    eur_rate, eur_src = await get_rate("EUR")
    usd_rate, usd_src = await get_rate("USD")
    return {
        "EUR": eur_rate,
        "USD": usd_rate,
        "source": f"EUR: {eur_src} | USD: {usd_src}",
        "fetched_at": datetime.now().isoformat(),
    }


def convert_to_pln(amount: float, currency: str, rate: float) -> float:
    """Multiply amount by rate (rate is already PLN per 1 foreign unit)."""
    if currency.upper() == "PLN":
        return round(amount, 4)
    return round(amount * rate, 4)
