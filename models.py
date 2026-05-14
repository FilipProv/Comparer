from datetime import datetime, date
from typing import Optional
from pydantic import BaseModel, field_validator


# ---------- Pydantic schemas ----------

VALID_CATEGORIES = {"substancja_czynna", "opakowanie", "kapsula"}
VALID_CURRENCIES = {"PLN", "EUR", "USD"}
VALID_UNITS = {"kg", "g", "mg", "szt", "op", "l", "ml"}


class QuotationCreate(BaseModel):
    category: str
    product_name: str
    supplier: str
    quantity: float
    unit: str
    price_original: float
    currency: str
    valid_until: Optional[date] = None
    notes: Optional[str] = None
    moq: Optional[float] = None
    spec_label: Optional[str] = None
    canonical_key: Optional[str] = None
    incoterm: Optional[str] = None
    logistics_cost_pln: Optional[float] = None
    quote_date: Optional[date] = None
    contact_email: Optional[str] = None
    source_file: Optional[str] = None
    price_type: Optional[str] = "netto"

    @field_validator("category")
    @classmethod
    def validate_category(cls, v: str) -> str:
        if v not in VALID_CATEGORIES:
            raise ValueError(f"Kategoria musi być jedną z: {', '.join(VALID_CATEGORIES)}")
        return v

    @field_validator("currency")
    @classmethod
    def validate_currency(cls, v: str) -> str:
        v = v.upper()
        if v not in VALID_CURRENCIES:
            raise ValueError(f"Waluta musi być jedną z: {', '.join(VALID_CURRENCIES)}")
        return v

    @field_validator("quantity", "price_original")
    @classmethod
    def validate_positive(cls, v: float) -> float:
        if v <= 0:
            raise ValueError("Wartość musi być większa od 0")
        return v


class QuotationRead(BaseModel):
    id: int
    created_at: datetime
    category: str
    product_name: str
    supplier: str
    quantity: float
    unit: str
    price_original: float
    currency: str
    price_pln: float
    exchange_rate_used: float
    valid_until: Optional[date] = None
    notes: Optional[str] = None
    moq: Optional[float] = None
    spec_label: Optional[str] = None
    canonical_key: Optional[str] = None
    incoterm: Optional[str] = None
    logistics_cost_pln: Optional[float] = None
    quote_date: Optional[date] = None
    contact_email: Optional[str] = None
    source_file: Optional[str] = None
    price_type: Optional[str] = "netto"
    inbox_id: Optional[int] = None
    price_per_unit_pln: float = 0.0
    effective_price_per_unit_pln: float = 0.0


class QuotationUpdate(BaseModel):
    category: Optional[str] = None
    product_name: Optional[str] = None
    supplier: Optional[str] = None
    quantity: Optional[float] = None
    unit: Optional[str] = None
    price_original: Optional[float] = None
    currency: Optional[str] = None
    valid_until: Optional[date] = None
    notes: Optional[str] = None
    moq: Optional[float] = None
    spec_label: Optional[str] = None
    canonical_key: Optional[str] = None
    incoterm: Optional[str] = None
    logistics_cost_pln: Optional[float] = None
    quote_date: Optional[date] = None
    contact_email: Optional[str] = None
    price_type: Optional[str] = None


class CalcResult(BaseModel):
    id: int
    category: str
    product_name: str
    supplier: str
    unit: str
    price_per_unit_pln: float
    total_cost_pln: float
    moq: Optional[float]
    moq_met: bool
    notes: Optional[str]


class RecommendResult(BaseModel):
    id: int
    category: str
    product_name: str
    supplier: str
    unit: str
    price_original: float
    currency: str
    price_per_unit_pln: float
    effective_price_per_unit_pln: float
    total_cost_pln: float
    effective_total_cost_pln: float
    moq: Optional[float]
    moq_met: bool
    notes: Optional[str]
    incoterm: Optional[str]
    logistics_cost_pln: Optional[float]
    rank: int
    verdict: str
    reason_codes: list[str]
    savings_vs_next_pln: Optional[float]
    savings_vs_next_pct: Optional[float]
    price_spread_alert: bool
    incoterm_mismatch: bool


class DashboardData(BaseModel):
    total_quotations: int
    unique_products: int
    products_multi_supplier: int
    savings_opportunities: list[dict]
    moq_warnings: int


class ExchangeRateResponse(BaseModel):
    EUR: float
    USD: float
    source: str
    fetched_at: str
