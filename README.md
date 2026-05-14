# Comparer — Porównywarka Wycen Ofertowych

Webowa aplikacja do agregacji i porównywania wycen ofertowych dla:
- substancji czynnych
- opakowań
- kapsułek

Kursy walut (EUR, USD → PLN) pobierane automatycznie z **NBP API**.

---

## Wymagania

- Python 3.10+
- pip

## Instalacja

```bash
pip install -r requirements.txt
```

## Uruchomienie

```bash
uvicorn main:app --reload
```

Otwórz przeglądarkę: **http://localhost:8000**

---

## Funkcje

| Funkcja | Opis |
|---|---|
| Import Excel | Wgraj plik .xlsx z wycenami (pobierz szablon z aplikacji) |
| Ręczne dodawanie | Formularz z walidacją i automatycznym przeliczeniem na PLN |
| Porównanie | Tabela z filtrowaniem; najtańsza oferta wyróżniona kolorem |
| Eksport | Pobierz przefiltrowane wyceny jako .xlsx |
| Kursy NBP | Kurs EUR/USD/PLN pobierany automatycznie; cache 1h |
| Kurs ręczny | Jeśli NBP niedostępny, można wpisać kurs ręcznie |

---

## Format pliku Excel (import)

Pobierz szablon z aplikacji (przycisk **Pobierz szablon Excel**).

Wymagane kolumny:

| Kolumna | Opis | Przykład |
|---|---|---|
| produkt | Nazwa substancji/opakowania/kapsułki | Paracetamol |
| dostawca | Nazwa firmy | Firma X Sp. z o.o. |
| ilość | Liczba jednostek | 25 |
| jednostka | kg / g / mg / szt / op / l / ml | kg |
| cena | Cena za podaną ilość | 120.00 |
| waluta | PLN / EUR / USD | EUR |
| kategoria | substancja_czynna / opakowanie / kapsula | substancja_czynna |
| ważna_do | Data ważności oferty (opcja) | 2026-12-31 |
| uwagi | Dowolny komentarz (opcja) | |

---

## Struktura projektu

```
Comparer/
├── main.py                  # FastAPI app + wszystkie endpointy
├── models.py                # SQLAlchemy model + schematy Pydantic
├── database.py              # Konfiguracja SQLite
├── services/
│   ├── currency.py          # Kursy walut NBP + cache
│   └── excel_import.py      # Parsowanie plików Excel
├── static/
│   ├── index.html           # Interfejs użytkownika (Bootstrap 5)
│   ├── style.css
│   └── app.js
├── requirements.txt
└── comparer.db              # Baza SQLite (tworzona automatycznie)
```

## API (FastAPI Swagger)

Dokumentacja API dostępna pod: **http://localhost:8000/docs**
