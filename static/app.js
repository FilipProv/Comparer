/**
 * Comparer — frontend application logic
 */

const App = (() => {
  let _deleteTargetId = null;
  let _previewRows = [];
  let _allProducts = [];
  let _tmData = null;
  const _deleteModal = new bootstrap.Modal(document.getElementById("deleteModal"));

  // ── Utilities ────────────────────────────────────────────────

  function spinner(show) {
    document.getElementById("spinner-overlay").classList.toggle("active", show);
  }

  function toast(message, type = "success") {
    const icons = { success: "check-circle-fill", danger: "x-circle-fill", warning: "exclamation-triangle-fill", info: "info-circle-fill" };
    const id = "t" + Date.now();
    const html = `
      <div id="${id}" class="toast align-items-center text-bg-${type} border-0" role="alert" data-bs-delay="4500">
        <div class="d-flex">
          <div class="toast-body"><i class="bi bi-${icons[type] || "info-circle-fill"} me-2"></i>${message}</div>
          <button type="button" class="btn-close btn-close-white me-2 m-auto" data-bs-dismiss="toast"></button>
        </div>
      </div>`;
    const container = document.getElementById("toast-container");
    container.insertAdjacentHTML("beforeend", html);
    const el = document.getElementById(id);
    new bootstrap.Toast(el).show();
    el.addEventListener("hidden.bs.toast", () => el.remove());
  }

  async function apiFetch(url, options = {}) {
    const res = await fetch(url, options);
    if (!res.ok) {
      let detail = `HTTP ${res.status}`;
      try { detail = (await res.json()).detail || detail; } catch (_) {}
      throw new Error(detail);
    }
    return res;
  }

  function fmt(n, digits = 4) {
    if (n == null) return "—";
    const minFrac = Math.min(2, digits);
    return Number(n).toLocaleString("pl-PL", { minimumFractionDigits: minFrac, maximumFractionDigits: digits });
  }

  // Format MOQ/quantity — shows decimals for values < 1, integers for whole numbers
  function fmtQty(n, unit) {
    if (n == null || n === undefined) return "—";
    const num = Number(n);
    let str;
    if (num < 1)            str = num.toLocaleString("pl-PL", { minimumFractionDigits: 0, maximumFractionDigits: 3 });
    else if (num % 1 === 0) str = num.toLocaleString("pl-PL", { maximumFractionDigits: 0 });
    else                    str = num.toLocaleString("pl-PL", { minimumFractionDigits: 1, maximumFractionDigits: 2 });
    return unit ? `${str} ${unit}` : str;
  }

  function escHtml(str) {
    return String(str ?? "")
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
  }

  function _incotermBadgeCls(inc) {
    if (!inc) return "bg-secondary";
    const u = inc.toUpperCase();
    if (u === "DDP") return "bg-success";
    if (u === "DAP" || u === "DPU") return "bg-info text-dark";
    return "bg-secondary";  // EXW, FOB, CIF, etc. — buyer pays more
  }

  function catLabel(cat) {
    const map = { substancja_czynna: "Subst. czynna", opakowanie: "Opakowanie", kapsula: "Kapsułka" };
    return map[cat] || cat;
  }

  function catBadge(cat) {
    return `<span class="badge badge-${cat}">${catLabel(cat)}</span>`;
  }

  function currBadge(cur) {
    return `<span class="badge badge-${cur}">${cur}</span>`;
  }

  // ── Exchange rates ────────────────────────────────────────────

  async function refreshRates() {
    const badge = document.getElementById("rate-badge");
    badge.innerHTML = `<i class="bi bi-arrow-clockwise me-1"></i>ładowanie…`;
    try {
      const res = await apiFetch("/api/rates");
      const data = await res.json();
      badge.innerHTML = `<i class="bi bi-currency-exchange me-1"></i>EUR ${fmt(data.EUR, 4)} | USD ${fmt(data.USD, 4)} PLN`;
      badge.className = "badge bg-success";
    } catch (e) {
      badge.innerHTML = `<i class="bi bi-exclamation-triangle me-1"></i>Kurs niedostępny`;
      badge.className = "badge bg-danger";
    }
  }

  // ── Dashboard ─────────────────────────────────────────────────

  async function loadDashboard() {
    try {
      const res = await apiFetch("/api/dashboard");
      const data = await res.json();
      _renderDashKpis(data);
      _renderOpportunities(data.savings_opportunities);
    } catch (e) {
      document.getElementById("dash-kpis").innerHTML =
        `<div class="col-12"><div class="alert alert-danger py-2">${escHtml(e.message)}</div></div>`;
    }
  }

  function _renderDashKpis(data) {
    document.getElementById("dash-kpis").innerHTML = `
      <div class="col-6 col-sm-3">
        <div class="summary-card bg-primary text-center">
          <div class="fs-2 fw-bold">${data.total_quotations}</div>
          <div class="small">Wycen w bazie</div>
        </div>
      </div>
      <div class="col-6 col-sm-3">
        <div class="summary-card bg-secondary text-center">
          <div class="fs-2 fw-bold">${data.unique_products}</div>
          <div class="small">Unikalnych produktów</div>
        </div>
      </div>
      <div class="col-6 col-sm-3">
        <div class="summary-card text-center" style="background:#1a6b3c">
          <div class="fs-2 fw-bold">${data.products_multi_supplier}</div>
          <div class="small">Produktów z 2+ dostawcami</div>
        </div>
      </div>
      <div class="col-6 col-sm-3">
        <div class="summary-card text-center" style="background:#7d3c98">
          <div class="fs-2 fw-bold">${data.savings_opportunities.length}</div>
          <div class="small">Okazji do porównania</div>
        </div>
      </div>`;
  }

  function _renderOpportunities(opps) {
    const container = document.getElementById("dash-opportunities");
    document.getElementById("dash-opp-count").textContent = opps.length;

    if (!opps.length) {
      container.innerHTML = `<p class="text-muted">Brak produktów z wieloma ofertami.</p>`;
      return;
    }

    container.innerHTML = `<div class="table-responsive">
      <table class="table table-sm table-hover mb-0 align-middle" style="font-size:.84rem">
        <thead>
          <tr style="background:#2c3e50;color:#fff">
            <th>Produkt</th>
            <th class="text-center">Ofert</th>
            <th class="text-end">Najtaniej PLN/jedn.</th>
            <th class="text-end">Najdrożej PLN/jedn.</th>
            <th class="text-end">Różnica</th>
            <th>Polecany dostawca</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          ${opps.map(o => {
            const spreadColor = o.spread_pct >= 50 ? "text-danger fw-bold" : o.spread_pct >= 25 ? "text-warning fw-semibold" : "text-success";
            return `<tr>
              <td class="fw-semibold">${escHtml(o.product_name)} <span class="text-muted small">/ ${escHtml(o.unit)}</span></td>
              <td class="text-center"><span class="badge bg-secondary">${o.supplier_count}</span></td>
              <td class="text-end text-success fw-bold">${fmt(o.best_ppu, 2)}</td>
              <td class="text-end text-muted">${fmt(o.worst_ppu, 2)}</td>
              <td class="text-end ${spreadColor}">−${o.spread_pct}%</td>
              <td><span class="badge" style="background:#1a6b3c">${escHtml(o.best_supplier)}</span></td>
              <td>
                <button class="btn btn-outline-success btn-sm py-0 px-1"
                  onclick="App.dashSelectProduct('${escHtml(o.product_name)}','${escHtml(o.unit)}')"
                  title="Sprawdź w Zamówieniu">
                  <i class="bi bi-cart-check"></i>
                </button>
              </td>
            </tr>`;
          }).join("")}
        </tbody>
      </table></div>`;
  }

  function dashSelectProduct(name, unit) {
    document.getElementById("dash-quick-product").value = name;
    document.getElementById("dash-quick-unit").value = unit;
    document.getElementById("ord-product").value = name;
    document.getElementById("ord-unit").value = unit;
    toast(`Wybrano: ${name} — przejdź do zakładki Zamówienie lub wpisz ilość poniżej.`, "info");
  }

  function dashQuickOrder() {
    const product = document.getElementById("dash-quick-product").value.trim();
    const qty = document.getElementById("dash-quick-qty").value;
    const unit = document.getElementById("dash-quick-unit").value;
    if (!product || !qty) { toast("Wpisz produkt i ilość.", "warning"); return; }
    // Copy to Order tab and switch
    document.getElementById("ord-product").value = product;
    document.getElementById("ord-qty").value = qty;
    document.getElementById("ord-unit").value = unit;
    bootstrap.Tab.getOrCreateInstance(document.querySelector('[data-bs-target="#tab-order"]')).show();
    runOrder();
  }

  // ── ORDER tab (Recommendations) ───────────────────────────────

  async function _loadProducts() {
    try {
      const res = await apiFetch("/api/products");
      _allProducts = await res.json();
    } catch (_) {}
  }

  function ordSuggest(query) {
    const box = document.getElementById("ord-suggestions");
    if (!query || query.length < 2) { box.innerHTML = ""; return; }
    const q = query.toLowerCase();
    const matches = _allProducts.filter(p => p.product_name.toLowerCase().includes(q)).slice(0, 12);
    if (!matches.length) { box.innerHTML = ""; return; }
    box.innerHTML = matches.map(p => `
      <button type="button" class="list-group-item list-group-item-action py-1 px-2 small"
        onclick="App.ordSelect('${escHtml(p.product_name)}','${escHtml(p.unit)}')">
        ${catBadge(p.category)}
        <span class="ms-1">${escHtml(p.product_name)}</span>
        <span class="text-muted ms-1">(${escHtml(p.unit)})</span>
      </button>`).join("");
  }

  function ordSelect(name, unit) {
    document.getElementById("ord-product").value = name;
    document.getElementById("ord-unit").value = unit;
    document.getElementById("ord-suggestions").innerHTML = "";
  }

  document.addEventListener("click", e => {
    if (!e.target.closest("#ord-product") && !e.target.closest("#ord-suggestions")) {
      const box = document.getElementById("ord-suggestions");
      if (box) box.innerHTML = "";
    }
  });

  async function runOrder() {
    const product = document.getElementById("ord-product").value.trim();
    const qty = parseFloat(document.getElementById("ord-qty").value);
    const unit = document.getElementById("ord-unit").value;
    const overMoq = document.getElementById("ord-over-moq").checked;

    if (!product) { toast("Wpisz nazwę produktu.", "warning"); return; }
    if (!qty || qty <= 0) { toast("Podaj ilość.", "warning"); return; }

    const params = new URLSearchParams({ product_name: product, quantity: qty, unit, include_over_moq: overMoq });

    spinner(true);
    try {
      const res = await apiFetch(`/api/recommendations?${params}`);
      const data = await res.json();
      _renderOrderResults(data, product, qty, unit);
    } catch (e) {
      toast("Błąd: " + e.message, "danger");
    } finally {
      spinner(false);
    }
  }

  function _renderOrderResults(results, product, qty, unit) {
    const wrap = document.getElementById("ord-results-wrap");

    if (!results.length) {
      wrap.innerHTML = `<div class="alert alert-warning">
        <i class="bi bi-search me-2"></i>
        Brak ofert dla <strong>${escHtml(product)}</strong> w jednostce <strong>${escHtml(unit)}</strong>.
        Spróbuj innej nazwy lub jednostki.
      </div>`;
      return;
    }

    const best = results.find(r => r.verdict === "best");
    const spreadAlert = results.some(r => r.price_spread_alert);
    const eligibleCount = results.filter(r => r.moq_met).length;

    // Verdict config
    const VERDICT = {
      best:    { cls: "verdict-best",    icon: "trophy-fill",              label: "NAJLEPSZA OFERTA",  bg: "#d1e7dd", border: "#198754" },
      good:    { cls: "verdict-good",    icon: "check-circle-fill",        label: "dobra oferta",      bg: "#e8f4fd", border: "#0d6efd" },
      caution: { cls: "verdict-caution", icon: "exclamation-triangle-fill",label: "sprawdź spec",      bg: "#fff3cd", border: "#ffc107" },
      blocked: { cls: "verdict-blocked", icon: "x-circle-fill",            label: "MOQ za wysokie",    bg: "#f8d7da", border: "#dc3545" },
    };

    const REASON_LABELS = {
      moq_blocked:            { icon: "x-circle",              text: "MOQ dostawcy > Twoje zamówienie",                    cls: "danger"  },
      price_spread_high:      { icon: "exclamation-triangle",  text: "Duża rozpiętość cen — sprawdź specyfikację COA",     cls: "warning" },
      single_supplier:        { icon: "person-fill",           text: "Jedyny dostawca dla tego produktu",                  cls: "info"    },
      significant_savings:    { icon: "piggy-bank-fill",       text: "Znacząca oszczędność vs kolejna opcja",              cls: "success" },
      incoterm_mismatch:      { icon: "truck",                 text: "Różne Incotermy — porównanie może być niedokładne",  cls: "warning" },
      incoterm_no_logistics:  { icon: "truck",                 text: "Cena nie DDP — brak kosztu logistyki, może być drożej", cls: "warning" },
    };

    const incoMismatch = results.some(r => r.incoterm_mismatch);

    let alertHtml = "";
    if (incoMismatch) {
      alertHtml += `<div class="alert alert-warning py-2 mb-2 small">
        <i class="bi bi-truck me-2"></i>
        <strong>Różne warunki dostawy (Incoterm):</strong> część ofert jest DDP (cena z dostawą), inne nie zawierają kosztów transportu.
        Ranking oparty jest na <strong>efektywnej cenie</strong> (cena + koszt logistyki jeśli podany).
        Dla ofert bez kosztu logistyki rzeczywisty koszt może być wyższy.
      </div>`;
    }
    if (spreadAlert) {
      alertHtml += `<div class="alert alert-warning py-2 mb-3 small">
        <i class="bi bi-exclamation-triangle-fill me-2"></i>
        <strong>Uwaga:</strong> duża rozpiętość cen (powyżej 40%) może oznaczać różne formy, stężenia lub specyfikacje produktu.
        Przed zamówieniem zweryfikuj COA / specyfikację dostawcy.
      </div>`;
    }

    const bestHtml = best ? `<div class="alert alert-success d-flex align-items-center gap-3 mb-3 py-2">
      <i class="bi bi-trophy-fill fs-4 text-warning"></i>
      <div>
        <div class="fw-bold">Polecany: <span class="text-success">${escHtml(best.supplier)}</span></div>
        <div class="small">
          ${fmt(best.price_per_unit_pln, 4)} PLN/${escHtml(unit)} &nbsp;·&nbsp;
          Łącznie: <strong>${fmt(best.total_cost_pln, 2)} PLN</strong> za ${fmt(qty, 2)} ${escHtml(unit)}
          ${best.savings_vs_next_pln ? `&nbsp;·&nbsp; <span class="text-success">oszczędność ${fmt(best.savings_vs_next_pln, 2)} PLN (${best.savings_vs_next_pct}%) vs kolejny</span>` : ""}
        </div>
      </div>
    </div>` : "";

    const cardsHtml = results.map((r, i) => {
      const v = VERDICT[r.verdict] || VERDICT.good;
      const reasonPills = r.reason_codes.map(code => {
        const rl = REASON_LABELS[code];
        if (!rl) return "";
        return `<span class="badge text-bg-${rl.cls} me-1"><i class="bi bi-${rl.icon} me-1"></i>${rl.text}</span>`;
      }).join("");

      const savingsRow = r.savings_vs_next_pln && r.verdict !== "blocked"
        ? `<div class="small text-success mt-1">
            <i class="bi bi-piggy-bank-fill me-1"></i>
            Oszczędzasz ${fmt(r.savings_vs_next_pln, 2)} PLN (${r.savings_vs_next_pct}%) vs następna opcja
          </div>`
        : "";

      const moqRow = r.moq
        ? `<span class="text-muted small ms-3">MOQ: ${fmtQty(r.moq, r.unit)}</span>`
        : `<span class="text-muted small ms-3">brak MOQ</span>`;

      const notesRow = r.notes
        ? `<div class="small text-muted mt-1 fst-italic"><i class="bi bi-info-circle me-1"></i>${escHtml(r.notes.slice(0, 120))}${r.notes.length > 120 ? "…" : ""}</div>`
        : "";

      const rankBadge = ["🥇","🥈","🥉"][i] || `${i+1}.`;

      return `<div class="card mb-2" style="border-left:4px solid ${v.border};background:${v.bg}">
        <div class="card-body py-2 px-3">
          <div class="d-flex align-items-start gap-2">
            <div class="fs-4 mt-1">${rankBadge}</div>
            <div class="flex-grow-1">
              <div class="d-flex align-items-center flex-wrap gap-2">
                <span class="fw-bold fs-6">${escHtml(r.supplier)}</span>
                <span class="badge" style="background:${v.border}">${v.label}</span>
                ${reasonPills}
              </div>
              <div class="d-flex align-items-center flex-wrap gap-3 mt-1">
                <div>
                  <span class="text-muted small">Cena oryg.:</span>
                  <strong>${fmt(r.price_original, 2)} ${currBadge(r.currency)}</strong>
                  ${r.incoterm ? `<span class="badge ms-1 ${_incotermBadgeCls(r.incoterm)}">${escHtml(r.incoterm)}</span>` : ""}
                </div>
                <div>
                  <span class="text-muted small">PLN/${escHtml(unit)}:</span>
                  <strong class="text-dark">${fmt(r.price_per_unit_pln, 4)}</strong>
                  ${r.logistics_cost_pln ? `<span class="text-muted small ms-1">+${fmt(r.logistics_cost_pln,2)} log.</span>` : ""}
                </div>
                ${r.effective_price_per_unit_pln !== r.price_per_unit_pln ? `<div>
                  <span class="text-muted small">Efektywna PLN/${escHtml(unit)}:</span>
                  <strong class="text-warning">${fmt(r.effective_price_per_unit_pln, 4)}</strong>
                </div>` : ""}
                <div>
                  <span class="text-muted small">Łącznie za ${fmt(qty, 2)} ${escHtml(unit)}:</span>
                  <strong class="fs-6" style="color:${v.border}">${fmt(r.effective_total_cost_pln ?? r.total_cost_pln, 2)} PLN</strong>
                  ${r.effective_total_cost_pln !== r.total_cost_pln ? `<span class="text-muted small ms-1">(bez log.: ${fmt(r.total_cost_pln,2)})</span>` : ""}
                </div>
                ${moqRow}
              </div>
              ${savingsRow}
              ${notesRow}
            </div>
          </div>
        </div>
      </div>`;
    }).join("");

    wrap.innerHTML = `
      ${alertHtml}
      ${bestHtml}
      <div class="d-flex justify-content-between align-items-center mb-2">
        <h6 class="mb-0 fw-semibold">
          Ranking dostawców — <span class="text-muted fw-normal">${escHtml(product)}, ${fmt(qty, 2)} ${escHtml(unit)}</span>
        </h6>
        <span class="text-muted small">${eligibleCount} ofert spełnia MOQ · ${results.length - eligibleCount} poza MOQ</span>
      </div>
      ${cardsHtml}`;
  }

  // ── Comparison table (All quotations) ────────────────────────

  async function loadQuotations() {
    const params = new URLSearchParams();
    const v = id => document.getElementById(id).value.trim();
    if (v("f-category"))  params.set("category",      v("f-category"));
    if (v("f-product"))   params.set("product_name",  v("f-product"));
    if (v("f-supplier"))  params.set("supplier",       v("f-supplier"));
    if (v("f-currency"))  params.set("currency",       v("f-currency"));
    if (v("f-date-from")) params.set("date_from",      v("f-date-from"));
    if (v("f-date-to"))   params.set("date_to",        v("f-date-to"));

    spinner(true);
    try {
      const res = await apiFetch(`/api/quotations?${params}`);
      const data = await res.json();
      _renderTable(data);
    } catch (e) {
      toast("Błąd ładowania: " + e.message, "danger");
    } finally {
      spinner(false);
    }
  }

  function _renderTable(rows) {
    const tbody = document.getElementById("quotation-tbody");
    const footer = document.getElementById("table-footer");

    if (!rows.length) {
      tbody.innerHTML = `<tr><td colspan="14" class="text-center text-secondary py-4">
        <i class="bi bi-inbox me-2"></i>Brak wyników.
      </td></tr>`;
      footer.textContent = "";
      return;
    }

    const bestPpu = {};
    rows.forEach(r => {
      const key = `${r.category}|${r.product_name}`;
      if (!bestPpu[key] || r.price_per_unit_pln < bestPpu[key]) bestPpu[key] = r.price_per_unit_pln;
    });

    const today = new Date().toISOString().slice(0, 10);
    tbody.innerHTML = rows.map(r => {
      const key = `${r.category}|${r.product_name}`;
      const isBest = r.price_per_unit_pln === bestPpu[key];
      const expired = r.valid_until && r.valid_until < today;
      const validUntilCell = expired
        ? `<span class="badge bg-danger" title="Wycena wygasła ${r.valid_until}"><i class="bi bi-exclamation-triangle-fill me-1"></i>${r.valid_until}</span>`
        : (r.valid_until || "—");
      const notes = r.notes ? `<span title="${escHtml(r.notes)}" class="text-muted small">${escHtml(r.notes.slice(0, 30))}${r.notes.length > 30 ? "…" : ""}</span>` : "—";
      return `<tr class="${isBest ? "best-price" : ""}${expired ? " table-expired" : ""}" data-id="${r.id}">
        <td>${catBadge(r.category)}</td>
        <td class="fw-semibold${expired ? " text-muted" : ""}">
          ${escHtml(r.product_name)}
          ${expired ? `<span class="badge bg-danger ms-1" style="font-size:.65rem">Wygasła</span>` : ""}
        </td>
        <td>${escHtml(r.supplier)}</td>
        <td class="text-end">${fmt(r.quantity, 2)}</td>
        <td>${escHtml(r.unit)}</td>
        <td class="text-end">${fmt(r.price_original, 2)}</td>
        <td>${currBadge(r.currency)}</td>
        <td class="text-end text-muted small">${r.currency === "PLN" ? "—" : fmt(r.exchange_rate_used, 4)}</td>
        <td class="text-end fw-semibold">${fmt(r.price_pln, 2)}</td>
        <td class="text-end ${expired ? "text-muted" : "text-success fw-bold"}">${fmt(r.price_per_unit_pln, 4)}</td>
        <td>${r.incoterm ? `<span class="badge ${_incotermBadgeCls(r.incoterm)}">${escHtml(r.incoterm)}</span>` : "—"}</td>
        <td>${r.price_type === "brutto" ? `<span class="badge bg-warning text-dark">Brutto</span>` : `<span class="badge bg-light text-secondary border">Netto</span>`}</td>
        <td class="text-muted small">${r.quote_date || "—"}</td>
        <td>${validUntilCell}</td>
        <td class="text-muted small">${r.contact_email ? `<a href="mailto:${escHtml(r.contact_email)}" title="${escHtml(r.contact_email)}">${escHtml(r.contact_email.length > 22 ? r.contact_email.slice(0,22)+"…" : r.contact_email)}</a>` : "—"}</td>
        <td>${notes}${r.source_file ? `<a href="#" onclick="event.preventDefault();App.previewFile('${encodeURIComponent(r.source_file)}')" class="ms-1 text-muted" title="Podgląd pliku: ${escHtml(r.source_file)}"><i class="bi bi-paperclip"></i></a>` : ""}</td>
        <td>
          <button class="btn btn-outline-danger btn-sm py-0 px-1" onclick="App.requestDelete(${r.id})" title="Usuń">
            <i class="bi bi-trash3"></i>
          </button>
        </td>
      </tr>`;
    }).join("");

    footer.textContent = `Łącznie: ${rows.length} wycen`;
  }

  function clearFilters() {
    ["f-category", "f-currency"].forEach(id => document.getElementById(id).value = "");
    ["f-product", "f-supplier", "f-date-from", "f-date-to"].forEach(id => document.getElementById(id).value = "");
    loadQuotations();
  }

  // ── Delete ────────────────────────────────────────────────────

  function requestDelete(id) {
    _deleteTargetId = id;
    _deleteModal.show();
  }

  document.getElementById("confirm-delete-btn").addEventListener("click", async () => {
    if (!_deleteTargetId) return;
    _deleteModal.hide();
    spinner(true);
    try {
      await apiFetch(`/api/quotations/${_deleteTargetId}`, { method: "DELETE" });
      toast("Wycena usunięta.");
      loadQuotations();
      loadSummary();
      loadDashboard();
    } catch (e) {
      toast("Błąd usuwania: " + e.message, "danger");
    } finally {
      spinner(false);
      _deleteTargetId = null;
    }
  });

  // ── Add form ──────────────────────────────────────────────────

  function onCurrencyChange(sel) {
    const wrap = document.getElementById("manual-rate-wrap");
    wrap.style.display = sel.value && sel.value !== "PLN" ? "" : "none";
  }

  async function submitAddForm(event) {
    event.preventDefault();
    const fd = new FormData(event.target);
    const payload = Object.fromEntries(fd.entries());
    const manualRate = payload.manual_rate ? parseFloat(payload.manual_rate) : null;
    delete payload.manual_rate;
    if (!payload.valid_until)    delete payload.valid_until;
    if (!payload.quote_date)     delete payload.quote_date;
    if (!payload.contact_email)  delete payload.contact_email;
    if (!payload.notes)          delete payload.notes;
    if (!payload.base_name)      delete payload.base_name;
    payload.quantity       = parseFloat(payload.quantity);
    payload.price_original = parseFloat(payload.price_original);
    if (payload.moq) payload.moq = parseFloat(payload.moq);
    else delete payload.moq;

    let url = "/api/quotations";
    if (manualRate) url += `?manual_rate=${manualRate}`;

    spinner(true);
    try {
      await apiFetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      toast("Wycena zapisana!", "success");
      event.target.reset();
      document.getElementById("manual-rate-wrap").style.display = "none";
      loadDashboard();
      _loadProducts();
      bootstrap.Tab.getOrCreateInstance(document.querySelector('[data-bs-target="#tab-dashboard"]')).show();
    } catch (e) {
      toast("Błąd zapisu: " + e.message, "danger");
    } finally {
      spinner(false);
    }
  }

  // ── Import (generic) ─────────────────────────────────────────

  async function previewImport() {
    const fileInput = document.getElementById("import-file");
    if (!fileInput.files.length) { toast("Wybierz plik.", "warning"); return; }
    const fd = new FormData();
    fd.append("file", fileInput.files[0]);
    spinner(true);
    try {
      const res = await apiFetch("/api/import/preview", { method: "POST", body: fd });
      const data = await res.json();
      _previewRows = data.rows;
      _renderImportErrors(data.errors);
      _renderPreviewTable(data.rows);
      document.getElementById("confirm-import-btn").disabled = data.rows.length === 0;
    } catch (e) {
      toast("Błąd podglądu: " + e.message, "danger");
    } finally {
      spinner(false);
    }
  }

  function _renderImportErrors(errors) {
    const container = document.getElementById("import-errors");
    if (!errors.length) { container.innerHTML = ""; return; }
    container.innerHTML = `<div class="alert alert-warning p-2 small">
      <strong>Ostrzeżenia (${errors.length}):</strong>
      <ul class="mb-0 ps-3 mt-1">${errors.map(e => `<li>${escHtml(e)}</li>`).join("")}</ul>
    </div>`;
  }

  function _renderPreviewTable(rows) {
    const wrap = document.getElementById("preview-table-wrap");
    if (!rows.length) {
      wrap.innerHTML = `<p class="text-warning small p-2">Brak prawidłowych wierszy.</p>`;
      return;
    }
    wrap.innerHTML = `
      <table class="table table-sm table-hover mb-0">
        <thead><tr><th>Kategoria</th><th>Produkt</th><th>Dostawca</th><th>Ilość</th><th>Jedn.</th><th>Cena</th><th>Waluta</th><th>Ważna do</th></tr></thead>
        <tbody>${rows.map(r => `<tr>
          <td>${catBadge(r.category)}</td>
          <td>${escHtml(r.product_name)}</td>
          <td>${escHtml(r.supplier)}</td>
          <td class="text-end">${fmt(r.quantity, 2)}</td>
          <td>${escHtml(r.unit)}</td>
          <td class="text-end">${fmt(r.price_original, 2)}</td>
          <td>${currBadge(r.currency)}</td>
          <td>${r.valid_until || "—"}</td>
        </tr>`).join("")}</tbody>
      </table>
      <p class="small text-muted mt-1 px-1">Gotowe: <strong>${rows.length}</strong> wierszy</p>`;
  }

  async function confirmImport() {
    const fileInput = document.getElementById("import-file");
    if (!fileInput.files.length) { toast("Wybierz plik.", "warning"); return; }
    const fd = new FormData();
    fd.append("file", fileInput.files[0]);
    let url = "/api/import/confirm";
    const eur = document.getElementById("imp-eur").value;
    const usd = document.getElementById("imp-usd").value;
    const params = new URLSearchParams();
    if (eur) params.set("manual_eur", eur);
    if (usd) params.set("manual_usd", usd);
    if ([...params].length) url += "?" + params;

    spinner(true);
    try {
      const res = await apiFetch(url, { method: "POST", body: fd });
      const data = await res.json();
      toast(`Import: zapisano ${data.saved}, pominięto ${data.skipped}.`, data.saved > 0 ? "success" : "warning");
      if (data.errors.length) _renderImportErrors(data.errors);
      document.getElementById("confirm-import-btn").disabled = true;
      document.getElementById("import-file").value = "";
      _renderPreviewTable([]);
      loadDashboard();
      _loadProducts();
    } catch (e) {
      toast("Błąd importu: " + e.message, "danger");
    } finally {
      spinner(false);
    }
  }

  // ── Import (native) ───────────────────────────────────────────

  async function nativePreview() {
    const fileInput = document.getElementById("native-file");
    if (!fileInput.files.length) { toast("Wybierz plik.", "warning"); return; }
    const fd = new FormData();
    fd.append("file", fileInput.files[0]);
    spinner(true);
    try {
      const res = await apiFetch("/api/import/native/preview", { method: "POST", body: fd });
      const data = await res.json();
      _renderNativeErrors(data.errors);
      _renderNativePreview(data.rows);
      document.getElementById("native-confirm-btn").disabled = data.rows.length === 0;
    } catch (e) {
      toast("Błąd podglądu: " + e.message, "danger");
    } finally {
      spinner(false);
    }
  }

  function _renderNativeErrors(errors) {
    const container = document.getElementById("native-errors");
    if (!errors.length) { container.innerHTML = ""; return; }
    container.innerHTML = `<div class="alert alert-warning p-2 small">
      <strong>Ostrzeżenia (${errors.length}):</strong>
      <ul class="mb-0 ps-3 mt-1">${errors.map(e => `<li>${escHtml(e)}</li>`).join("")}</ul>
    </div>`;
  }

  function _renderNativePreview(rows) {
    const wrap = document.getElementById("native-preview-wrap");
    if (!rows.length) {
      wrap.innerHTML = `<p class="text-warning small p-2">Brak rozpoznanych wierszy.</p>`;
      return;
    }
    const counts = {};
    rows.forEach(r => { counts[r.category] = (counts[r.category] || 0) + 1; });
    const summary = Object.entries(counts).map(([k, v]) => `${catBadge(k)} ×${v}`).join("  ");
    wrap.innerHTML = `
      <div class="mb-2 small">${summary} &nbsp;|&nbsp; Łącznie: <strong>${rows.length}</strong></div>
      <div style="max-height:340px;overflow-y:auto">
      <table class="table table-sm table-hover mb-0">
        <thead><tr><th>Kategoria</th><th>Produkt</th><th>Dostawca</th><th>Ilość</th><th>Jedn.</th><th>Cena PLN</th><th>Uwagi</th></tr></thead>
        <tbody>${rows.map(r => `<tr>
          <td>${catBadge(r.category)}</td>
          <td class="fw-semibold">${escHtml(r.product_name)}</td>
          <td>${escHtml(r.supplier)}</td>
          <td class="text-end">${fmt(r.quantity, 0)}</td>
          <td>${escHtml(r.unit)}</td>
          <td class="text-end text-success fw-semibold">${fmt(r.price_original, 2)}</td>
          <td class="text-muted small">${escHtml(r.notes || "")}</td>
        </tr>`).join("")}</tbody>
      </table></div>`;
  }

  async function nativeConfirm() {
    const fileInput = document.getElementById("native-file");
    if (!fileInput.files.length) { toast("Wybierz plik.", "warning"); return; }
    const fd = new FormData();
    fd.append("file", fileInput.files[0]);
    spinner(true);
    try {
      const res = await apiFetch("/api/import/native/confirm", { method: "POST", body: fd });
      const data = await res.json();
      toast(`Import: zapisano ${data.saved} wycen.`, data.saved > 0 ? "success" : "warning");
      if (data.errors.length) _renderNativeErrors(data.errors);
      document.getElementById("native-confirm-btn").disabled = true;
      document.getElementById("native-file").value = "";
      document.getElementById("native-preview-wrap").innerHTML = `<p class="text-muted small p-2">Zaimportowano.</p>`;
      loadDashboard();
      _loadProducts();
    } catch (e) {
      toast("Błąd importu: " + e.message, "danger");
    } finally {
      spinner(false);
    }
  }

  // ── Pricelist tabs ────────────────────────────────────────────

  const _plData = { sub: [], other: [] };
  const _plCatFilter = { sub: "all", other: "all" };

  async function loadPricelist(which) {
    const cats = which === "sub"
      ? ["substancja_czynna"]
      : ["opakowanie", "kapsula"];

    const wrap = document.getElementById(`pl-${which}-wrap`);
    wrap.innerHTML = `<div class="text-center text-secondary py-5">
      <div class="spinner-border text-primary" role="status"></div>
      <div class="mt-2 small">Ładowanie…</div>
    </div>`;

    try {
      const all = [];
      for (const cat of cats) {
        const res = await apiFetch(`/api/quotations?category=${cat}`);
        const rows = await res.json();
        all.push(...rows);
      }
      _plData[which] = all;
      plClearFilters(which);          // reset filters on fresh load
      _plPopulateSuppliers(which);
      _renderPricelist(which);
    } catch (e) {
      wrap.innerHTML = `<div class="alert alert-danger">${escHtml(e.message)}</div>`;
    }
  }

  function _plPopulateSuppliers(which) {
    const sel = document.getElementById(`pl-${which}-supplier`);
    if (!sel) return;
    const suppliers = [...new Set((_plData[which] || []).map(r => r.supplier))].sort();
    sel.innerHTML = `<option value="">Wszyscy</option>` +
      suppliers.map(s => `<option value="${escHtml(s)}">${escHtml(s)}</option>`).join("");
  }

  function plFilter(which) {
    _renderPricelist(which);
  }

  function plSetCat(which, cat, btn) {
    _plCatFilter[which] = cat;
    document.querySelectorAll("#pl-other-cat-filter .btn").forEach(b => b.classList.remove("active"));
    btn.classList.add("active");
    _renderPricelist(which);
  }

  function plClearFilters(which) {
    const ids = ["search", "supplier", "incoterm", "sort"];
    ids.forEach(id => {
      const el = document.getElementById(`pl-${which}-${id}`);
      if (el) el.value = id === "sort" ? "name" : "";
    });
    const multi = document.getElementById(`pl-${which}-multi`);
    const nomoq = document.getElementById(`pl-${which}-nomoq`);
    if (multi) multi.checked = false;
    if (nomoq) nomoq.checked = false;
    if (which === "other") {
      _plCatFilter.other = "all";
      document.querySelectorAll("#pl-other-cat-filter .btn").forEach((b, i) => {
        b.classList.toggle("active", i === 0);
      });
    }
    _renderPricelist(which);
  }

  function _renderPricelist(which) {
    const wrap = document.getElementById(`pl-${which}-wrap`);
    const countBadge = document.getElementById(`pl-${which}-count`);

    const query    = (document.getElementById(`pl-${which}-search`)?.value   || "").toLowerCase().trim();
    const supplier = (document.getElementById(`pl-${which}-supplier`)?.value  || "");
    const incoterm = (document.getElementById(`pl-${which}-incoterm`)?.value  || "");
    const sortBy   = (document.getElementById(`pl-${which}-sort`)?.value      || "name");
    const onlyMulti = document.getElementById(`pl-${which}-multi`)?.checked   || false;
    const onlyNoMoq = document.getElementById(`pl-${which}-nomoq`)?.checked   || false;
    const catFilter = _plCatFilter[which] || "all";

    // Client-side base name extraction when base_name not stored in DB
    function _clientBaseName(r) {
      if (r.base_name) return r.base_name;
      return (r.product_name || "")
        .replace(/\s+\d[\d.,]*\s*%.*$/i, "")   // strip "98% regular powder", "90% coated" etc.
        .replace(/\s+(regular|coated|fine|granulated|powder|extract|complex|premium|micronized|buffered|sustained|release|enteric)\b.*$/i, "")
        .trim() || r.product_name;
    }

    let rows = _plData[which] || [];
    if (catFilter !== "all") rows = rows.filter(r => r.category === catFilter);
    if (supplier) rows = rows.filter(r => r.supplier === supplier);
    if (incoterm) rows = rows.filter(r => (r.incoterm || "").toUpperCase() === incoterm);

    // Group by base_name (client-extracted or stored) → then by product_name
    if (query) rows = rows.filter(r =>
      r.product_name.toLowerCase().includes(query) ||
      _clientBaseName(r).toLowerCase().includes(query)
    );

    const superGroups = {};
    rows.forEach(r => {
      const bn = _clientBaseName(r);
      const sgKey = `${r.category}||${bn}`;
      if (!superGroups[sgKey]) superGroups[sgKey] = {
        category: r.category,
        base_name: bn,
        variants: {}
      };
      const vKey = r.product_name;
      if (!superGroups[sgKey].variants[vKey]) superGroups[sgKey].variants[vKey] = [];
      superGroups[sgKey].variants[vKey].push(r);
    });

    let groupList = Object.values(superGroups).map(sg => ({
      ...sg,
      variantList: Object.entries(sg.variants).map(([name, offers]) => ({ product_name: name, offers })),
      allOffers: Object.values(sg.variants).flat(),
    }));

    if (onlyMulti) groupList = groupList.filter(sg => {
      const suppliers = new Set(sg.allOffers.map(o => o.supplier));
      return suppliers.size >= 2;
    });
    if (onlyNoMoq) groupList = groupList.filter(sg =>
      sg.allOffers.every(o => !o.moq)
    );

    if (countBadge) countBadge.textContent = groupList.length;

    if (!groupList.length) {
      const hint = query || supplier || incoterm || onlyMulti || onlyNoMoq
        ? "Brak wyników dla wybranych filtrów."
        : "Brak danych — zaimportuj pliki przez zakładkę Import.";
      wrap.innerHTML = `<div class="alert alert-secondary">${hint}</div>`;
      return;
    }

    // Sort groups
    groupList.sort((a, b) => {
      if (sortBy === "price") {
        const bestA = Math.min(...a.allOffers.map(o => o.price_per_unit_pln));
        const bestB = Math.min(...b.allOffers.map(o => o.price_per_unit_pln));
        return bestA - bestB;
      }
      if (sortBy === "offers") return b.allOffers.length - a.allOffers.length;
      return a.category.localeCompare(b.category) || a.base_name.localeCompare(b.base_name);
    });

    const sorted = groupList;

    // Active filter chips
    const chips = [];
    if (query)      chips.push(`Produkt: <strong>${escHtml(query)}</strong>`);
    if (supplier)   chips.push(`Dostawca: <strong>${escHtml(supplier)}</strong>`);
    if (incoterm)   chips.push(`Incoterm: <strong>${escHtml(incoterm)}</strong>`);
    if (onlyMulti)  chips.push(`<strong>2+ dostawców</strong>`);
    if (onlyNoMoq)  chips.push(`<strong>bez MOQ</strong>`);
    const chipBar = chips.length
      ? `<div class="mb-2 d-flex align-items-center gap-2 flex-wrap small text-muted">
          <i class="bi bi-funnel-fill"></i>Filtry:
          ${chips.map(c => `<span class="badge text-bg-light border">${c}</span>`).join("")}
          <button class="btn btn-link btn-sm p-0 ms-1 text-danger" onclick="App.plClearFilters('${which}')">Wyczyść wszystkie</button>
        </div>`
      : "";

    // Group by category for section headers
    const byCategory = {};
    sorted.forEach(g => {
      if (!byCategory[g.category]) byCategory[g.category] = [];
      byCategory[g.category].push(g);
    });

    const CAT_LABELS = {
      substancja_czynna: { label: "Substancje czynne", icon: "capsule", color: "#0d6efd" },
      opakowanie:        { label: "Opakowania",         icon: "box-seam", color: "#6f42c1" },
      kapsula:           { label: "Kapsułki",           icon: "circle",   color: "#20c997" },
    };

    let html = `<div class="pricelist-wrap">${chipBar}`;

    Object.entries(byCategory).forEach(([cat, catGroups]) => {
      const info = CAT_LABELS[cat] || { label: cat, icon: "tag", color: "#6c757d" };
      html += `<div class="mb-4">
        <div class="d-flex align-items-center gap-2 mb-2 pb-1" style="border-bottom:2px solid ${info.color}">
          <i class="bi bi-${info.icon}" style="color:${info.color};font-size:1.1rem"></i>
          <span class="fw-bold" style="color:${info.color}">${escHtml(info.label)}</span>
          <span class="badge bg-secondary">${catGroups.length}</span>
        </div>
        <div class="table-responsive">
          <table class="table table-sm table-hover align-middle mb-0" style="font-size:.85rem">
            <thead>
              <tr style="background:#2c3e50;color:#fff">
                <th style="width:30%" class="ps-2">Produkt</th>
                <th style="width:5%" class="text-center">Ofert</th>
                <th style="width:11%" class="text-end">Najtaniej PLN/jedn.</th>
                <th style="width:16%">Najtańszy dostawca</th>
                <th style="width:7%" class="text-center">Incoterm</th>
                <th style="width:7%">MOQ</th>
                <th style="width:12%" class="text-end">Koszt @ MOQ</th>
                <th style="width:12%">Spec</th>
              </tr>
            </thead>
            <tbody>`;

      // Helper functions
      const plToday = new Date().toISOString().slice(0, 10);
      const effMoq = o => o.moq ?? o.quantity;
      const hasNoMoq = o => !o.moq && (o.quantity == null || o.quantity <= 1);
      const isExpired = o => !!(o.valid_until && o.valid_until < plToday);

      function _freshnessCell(offer) {
        const dateStr = offer.quote_date || offer.created_at;
        if (!dateStr) return '<span class="text-muted">—</span>';
        const days = Math.floor((Date.now() - new Date(dateStr)) / 86400000);
        if (days < 30)  return `<span class="badge bg-success-subtle text-success border border-success-subtle" title="${new Date(dateStr).toLocaleDateString('pl-PL')}">${days}d</span>`;
        if (days < 90)  return `<span class="badge bg-warning-subtle text-warning border border-warning-subtle" title="${new Date(dateStr).toLocaleDateString('pl-PL')}">${days}d</span>`;
        return `<span class="badge bg-danger-subtle text-danger border border-danger-subtle" title="${new Date(dateStr).toLocaleDateString('pl-PL')}">${days}d</span>`;
      }

      function _moqCell(offer, small) {
        const em = effMoq(offer);
        const isExplicit = !!offer.moq;
        const tag = small ? "small" : "span";
        if (hasNoMoq(offer)) return `<span class="text-success fw-semibold">brak</span>`;
        const note = !isExplicit ? ` <span class="text-muted" title="wynika z podanej ilości">(z ilości)</span>` : "";
        return `<${tag} class="${small ? "text-muted" : ""}">${fmtQty(em, offer.unit)}${note}</${tag}>`;
      }

      function _costCell(offer, cls) {
        const em = effMoq(offer);
        if (!em || !offer.price_per_unit_pln || hasNoMoq(offer)) return "—";
        return `<span class="fw-semibold ${cls}">${fmt(em * offer.price_per_unit_pln, 2)} zł</span>`;
      }

      // Renders supplier blocks for a given set of offers (used for both single & multi-variant)
      function _renderSupplierBlocks(offers, overallBestPpu) {
        const bySupplier = {};
        [...offers].sort((a, b) => a.price_per_unit_pln - b.price_per_unit_pln).forEach(o => {
          if (!bySupplier[o.supplier]) bySupplier[o.supplier] = [];
          bySupplier[o.supplier].push(o);
        });
        const suppliersSorted = Object.entries(bySupplier).sort((a, b) => {
          const bA = Math.min(...a[1].map(o => o.price_per_unit_pln));
          const bB = Math.min(...b[1].map(o => o.price_per_unit_pln));
          return bA - bB;
        });
        let h = "";
        suppliersSorted.forEach(([supplierName, tiers], supIdx) => {
          const isTop = supIdx === 0;
          const sortedTiers = [...tiers].sort((a, b) => (effMoq(a) || 0) - (effMoq(b) || 0));
          const bestTierPpu = Math.min(...tiers.map(o => o.price_per_unit_pln));
          const allTiersExpired = tiers.every(o => isExpired(o));
          const borderColor = allTiersExpired ? "#dc3545" : (isTop ? "#198754" : "#6c757d");
          const headerBg = allTiersExpired ? "#fff0f0" : (isTop ? "#d1e7dd" : "#e9ecef");
          h += `<div class="supplier-block" style="border-left:3px solid ${borderColor};margin:0;padding:0">
            <div class="d-flex align-items-center gap-2 px-3 py-2"
                 style="background:${headerBg};border-bottom:1px solid #dee2e6">
              ${allTiersExpired ? `<i class="bi bi-exclamation-triangle-fill text-danger" style="font-size:.9rem"></i>` : (isTop ? `<span style="font-size:1rem">🥇</span>` : `<span class="text-muted" style="font-size:.8rem;width:1.2rem;text-align:center">${supIdx+1}.</span>`)}
              <span class="fw-bold${allTiersExpired ? " text-muted" : ""}" style="font-size:.9rem">${escHtml(supplierName)}</span>
              ${tiers.length > 1 ? `<span class="badge bg-secondary" style="font-size:.68rem">${tiers.length} progi MOQ</span>` : ""}
              ${allTiersExpired ? `<span class="badge bg-danger ms-1" style="font-size:.68rem">Wygasła</span>` : ""}
              <span class="ms-auto fw-bold ${allTiersExpired ? "text-muted text-decoration-line-through" : (isTop ? "text-success" : "text-secondary")}" style="font-size:.85rem">
                od ${fmt(bestTierPpu, 4)} PLN/jedn.
              </span>
              ${allTiersExpired ? `<span class="badge bg-danger" style="font-size:.65rem" title="Wygasła ${sortedTiers[0].valid_until}"><i class="bi bi-clock-history"></i></span>` : _freshnessCell(sortedTiers[0])}
            </div>
            <table class="table table-sm mb-0" style="font-size:.81rem">
              <thead>
                <tr style="background:#f1f3f5;color:#6c757d;font-size:.75rem">
                  <th style="width:90px;padding-left:2.5rem">MOQ</th>
                  <th class="text-end">Cena oryg.</th>
                  <th class="text-end">PLN/jedn.</th>
                  <th class="text-end">Koszt @ MOQ</th>
                  <th class="text-center">Incoterm</th>
                  <th>Typ ceny</th>
                  <th>Data wyceny</th>
                  <th>Ważna do</th>
                  <th>Spec</th>
                  <th style="min-width:100px">Uwagi</th>
                  <th style="width:32px"></th>
                </tr>
              </thead>
              <tbody>`;
          sortedTiers.forEach(o => {
            const isCheapest = o.price_per_unit_pln === bestTierPpu;
            const tierExpired = isExpired(o);
            const notesDisplay = o.notes
              ? escHtml(o.notes.slice(0, 60)) + (o.notes.length > 60 ? "…" : "")
              : '<span class="text-muted opacity-40" style="font-size:.75rem">dodaj uwagę</span>';
            h += `<tr style="${tierExpired ? "background:#fff5f5;opacity:.8" : (isCheapest && tiers.length > 1 ? "background:#f0fff4" : "")}">
              <td class="ps-4 fw-semibold small">${_moqCell(o, true)}</td>
              <td class="text-end${tierExpired ? " text-muted text-decoration-line-through" : ""}">${fmt(o.price_original, 2)} ${currBadge(o.currency)}</td>
              <td class="text-end fw-bold ${tierExpired ? "text-muted" : (isCheapest ? "text-success" : "")}">${fmt(o.price_per_unit_pln, 4)}</td>
              <td class="text-end small">${_costCell(o, tierExpired ? "text-muted" : "text-muted")}</td>
              <td class="text-center">${o.incoterm ? `<span class="badge ${_incotermBadgeCls(o.incoterm)}">${escHtml(o.incoterm)}</span>` : "—"}</td>
              <td class="small">${o.price_type === "brutto" ? `<span class="badge bg-warning text-dark">Brutto</span>` : `<span class="badge bg-light text-secondary border">Netto</span>`}</td>
              <td class="small text-muted">${o.quote_date || "—"}</td>
              <td class="small ${tierExpired ? "text-danger fw-semibold" : "text-muted"}">${tierExpired ? `<i class="bi bi-exclamation-triangle-fill me-1"></i>${o.valid_until}` : (o.valid_until || "—")}</td>
              <td class="small text-muted">${o.spec_label ? escHtml(o.spec_label.slice(0,18)) : "—"}</td>
              <td class="small pl-notes-cell" data-id="${o.id}"
                data-notes="${escHtml(o.notes||"")}"
                style="cursor:pointer;min-width:90px"
                onclick="App.plEditNotes(this)">
                <span class="pl-notes-text">${notesDisplay}</span>
                <i class="bi bi-pencil-fill ms-1 text-muted opacity-0 pl-notes-icon" style="font-size:.7rem"></i>
              </td>
              <td class="text-center">
                <button class="btn btn-link btn-sm p-0 text-danger opacity-25 pl-del-btn"
                  title="Usuń tę wycenę"
                  onclick="event.stopPropagation();App.plDeleteOffer(${o.id},'${escHtml(o.supplier)}','${escHtml(o.product_name)}')">
                  <i class="bi bi-trash3" style="font-size:.8rem"></i>
                </button>
              </td>
            </tr>`;
          });
          h += `</tbody></table></div>`;
        });
        return h;
      }

      catGroups.forEach(sg => {
        const isMultiVariant = sg.variantList.length > 1;
        const sorted_all = [...sg.allOffers].sort((a, b) => a.price_per_unit_pln - b.price_per_unit_pln);
        const best = sorted_all[0];
        const hasMultiple = sg.allOffers.length > 1 || isMultiVariant;
        const groupId = `pl-${which}-${encodeURIComponent(sg.base_name.replace(/\s/g,"_")).slice(0,20)}-${Math.random().toString(36).slice(2,6)}`;

        // Offer with the smallest effective MOQ (shown in summary row MOQ column)
        const minMoqOffer = [...sg.allOffers].sort((a, b) => {
          const ea = hasNoMoq(a) ? 0 : (effMoq(a) || Infinity);
          const eb = hasNoMoq(b) ? 0 : (effMoq(b) || Infinity);
          return ea - eb;
        })[0];

        // Summary row — shows base_name (+ variant count badge if multi)
        const bestHasNoMoq = hasNoMoq(best);
        const bestWithMoq = bestHasNoMoq && !isMultiVariant
          ? sorted_all.find(o => !hasNoMoq(o) && o.id !== best.id) || null
          : null;

        // Expired state of the whole super-group
        const allExpired = sg.allOffers.every(o => isExpired(o));
        const someExpired = !allExpired && sg.allOffers.some(o => isExpired(o));

        function _summaryRow(offer, isSecondary) {
          const offerExpired = isExpired(offer);
          let rowBg;
          if (allExpired) rowBg = "background:#fff5f5";
          else if (isSecondary) rowBg = "background:#e8f4fd";
          else rowBg = "background:#f0fff4";
          const label = isSecondary
            ? `<span class="badge ms-1" style="background:#0d6efd;font-size:.68rem">najlepsza z MOQ</span>`
            : ``;
          const chevron = (!isSecondary && hasMultiple)
            ? `<i class="bi bi-chevron-right pl-chevron me-1" id="chev-${groupId}" style="font-size:.75rem;color:#6c757d;transition:transform .2s"></i>`
            : `<span class="me-3"></span>`;
          const clickAttr = (!isSecondary && hasMultiple) ? `onclick="App._plToggle('${groupId}')"` : "";
          const cursor = (!isSecondary && hasMultiple) ? "pointer" : "default";
          const displayName = isMultiVariant ? escHtml(sg.base_name) : escHtml(sg.variantList[0]?.product_name || sg.base_name);
          const offerCount = !isSecondary
            ? `<td class="text-center text-muted">${sg.allOffers.length}</td>`
            : `<td></td>`;
          const expiredBadge = !isSecondary && allExpired
            ? `<span class="badge bg-danger ms-1" style="font-size:.65rem" title="Wszystkie wyceny po terminie ważności"><i class="bi bi-exclamation-triangle-fill me-1"></i>Wygasłe</span>`
            : (!isSecondary && someExpired
              ? `<span class="badge bg-warning text-dark ms-1" style="font-size:.65rem" title="Część wycen po terminie ważności"><i class="bi bi-exclamation-circle me-1"></i>Część wygasła</span>`
              : "");
          const priceClass = offerExpired ? "text-muted" : (isSecondary ? "text-primary" : "text-success");
          return `<tr class="pl-product-row${!isSecondary && hasMultiple ? " pl-expandable" : ""}${allExpired ? " pl-all-expired" : ""}"
              style="cursor:${cursor};${rowBg}${allExpired ? ";opacity:.75" : ""}"
              ${clickAttr}>
            <td class="ps-2 fw-semibold">
              ${chevron}
              ${!isSecondary ? `<span${allExpired ? ' class="text-muted"' : ""}>${displayName}</span>` : ""}
              ${!isSecondary && isMultiVariant ? `<span class="badge ms-1" style="background:#6f42c1;font-size:.7rem">${sg.variantList.length} warianty</span>` : ""}
              ${!isSecondary && !isMultiVariant && hasMultiple ? `<span class="badge bg-secondary ms-1" style="font-size:.7rem">${sg.allOffers.length}</span>` : ""}
              ${expiredBadge}
              ${label}
            </td>
            ${offerCount}
            <td class="text-end fw-bold ${priceClass}">${fmt(offer.price_per_unit_pln, 4)}</td>
            <td>
              <span class="badge" style="background:${offerExpired ? "#6c757d" : (isSecondary ? "#0d6efd" : "#1a6b3c")};font-size:.78rem">${escHtml(offer.supplier)}</span>
              <span class="ms-1">${offerExpired ? `<span class="badge bg-danger" style="font-size:.65rem" title="Wygasła ${offer.valid_until}"><i class="bi bi-clock-history"></i></span>` : _freshnessCell(offer)}</span>
            </td>
            <td class="text-center">${offer.incoterm ? `<span class="badge ${_incotermBadgeCls(offer.incoterm)}">${escHtml(offer.incoterm)}</span>` : "—"}</td>
            <td class="small">${_moqCell(minMoqOffer, false)}${minMoqOffer !== offer ? `<span class="text-muted ms-1" style="font-size:.68rem" title="Najtańsza oferta ma inne MOQ">(min)</span>` : ""}</td>
            <td class="text-end small">${_costCell(minMoqOffer, priceClass)}</td>
            <td class="text-muted small">${offer.spec_label ? escHtml(offer.spec_label.slice(0,18)) : "—"}</td>
          </tr>`;
        }

        html += _summaryRow(best, false);
        if (bestWithMoq) html += _summaryRow(bestWithMoq, true);

        if (hasMultiple) {
          html += `<tr id="${groupId}" style="display:none"><td colspan="8" class="p-0" style="background:#f8f9fa">`;

          if (isMultiVariant) {
            // Multi-variant: show each variant as a labeled section, then supplier blocks
            sg.variantList
              .sort((a, b) => Math.min(...a.offers.map(o => o.price_per_unit_pln)) - Math.min(...b.offers.map(o => o.price_per_unit_pln)))
              .forEach((v, vIdx) => {
                const vBest = Math.min(...v.offers.map(o => o.price_per_unit_pln));
                const vAllExpired = v.offers.every(o => isExpired(o));
                html += `<div style="border-top:${vIdx > 0 ? "2px solid #dee2e6" : "none"}">
                  <div class="d-flex align-items-center gap-2 px-3 py-2" style="background:${vAllExpired ? "#fff0f0" : "#f0f4ff"};border-bottom:1px solid #dee2e6">
                    <i class="bi bi-diagram-2 ${vAllExpired ? "text-danger" : "text-primary"}" style="font-size:.85rem"></i>
                    <span class="fw-semibold ${vAllExpired ? "text-muted" : "text-primary"}" style="font-size:.88rem">${escHtml(v.product_name)}</span>
                    <span class="badge bg-light text-secondary border ms-1" style="font-size:.68rem">${v.offers.length} ofert${v.offers.length === 1 ? "a" : ""}</span>
                    ${vAllExpired ? `<span class="badge bg-danger ms-1" style="font-size:.68rem"><i class="bi bi-exclamation-triangle-fill me-1"></i>Wygasłe</span>` : ""}
                    <span class="ms-auto ${vAllExpired ? "text-muted text-decoration-line-through" : "text-success fw-bold"}" style="font-size:.82rem">od ${fmt(vBest, 4)} PLN/jedn.</span>
                  </div>
                  ${_renderSupplierBlocks(v.offers, vBest)}
                </div>`;
              });
          } else {
            // Single variant: just show supplier blocks
            html += _renderSupplierBlocks(sg.allOffers, Math.min(...sg.allOffers.map(o => o.price_per_unit_pln)));
          }

          html += `</td></tr>`;
        }
      });

      html += `</tbody></table></div></div>`;
    });

    html += `</div>`;
    wrap.innerHTML = html;
  }

  function _plToggle(groupId) {
    const row = document.getElementById(groupId);
    const chev = document.getElementById(`chev-${groupId}`);
    if (!row) return;
    const open = row.style.display !== "none";
    row.style.display = open ? "none" : "";
    if (chev) chev.style.transform = open ? "" : "rotate(90deg)";
  }

  function plEditNotes(cell) {
    if (cell.querySelector("textarea")) return; // already editing

    const id           = parseInt(cell.dataset.id);
    const currentNotes = cell.dataset.notes || "";

    // Stash original HTML in dataset so cancel can restore it safely
    cell.dataset.originalHtml = cell.innerHTML;
    cell.onclick = null; // disable while editing

    cell.innerHTML = `
      <textarea class="form-control form-control-sm"
        style="min-width:180px;font-size:.8rem;resize:vertical"
        rows="2"
        placeholder="Wpisz uwagę…">${escHtml(currentNotes)}</textarea>
      <div class="d-flex gap-1 mt-1">
        <button class="btn btn-success btn-sm py-0 px-2" style="font-size:.75rem"
          onclick="event.stopPropagation();App._plSaveNotes(this)">
          <i class="bi bi-check2"></i> Zapisz
        </button>
        <button class="btn btn-outline-secondary btn-sm py-0 px-2" style="font-size:.75rem"
          onclick="event.stopPropagation();App._plCancelNotes(this)">
          Anuluj
        </button>
      </div>`;

    cell.querySelector("textarea").focus();
  }

  async function _plSaveNotes(btn) {
    const cell  = btn.closest("td");
    const id    = parseInt(cell.dataset.id);
    const ta    = cell.querySelector("textarea");
    const notes = ta.value.trim();

    btn.disabled = true;
    btn.innerHTML = '<span class="spinner-border spinner-border-sm"></span>';

    try {
      const res = await fetch(`/api/quotations/${id}/notes`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ notes }),
      });
      if (!res.ok) throw new Error("HTTP " + res.status);

      // Update local data cache
      for (const key of Object.keys(_plData)) {
        const item = (_plData[key] || []).find(r => r.id === id);
        if (item) { item.notes = notes || null; break; }
      }

      // Update dataset so next edit opens with correct value
      cell.dataset.notes = notes;
      delete cell.dataset.originalHtml;

      const display = notes
        ? escHtml(notes.slice(0, 60)) + (notes.length > 60 ? "…" : "")
        : '<span class="text-muted opacity-50">dodaj uwagę</span>';
      cell.innerHTML = `<span class="pl-notes-text">${display}</span>
        <i class="bi bi-pencil-fill ms-1 text-muted opacity-0 pl-notes-icon" style="font-size:.7rem"></i>`;
      cell.onclick = () => App.plEditNotes(cell);
      toast("Uwaga zapisana", "success");
    } catch (e) {
      toast("Błąd zapisu: " + e.message, "danger");
      btn.disabled = false;
      btn.innerHTML = '<i class="bi bi-check2"></i> Zapisz';
    }
  }

  function _plCancelNotes(btn) {
    const cell         = btn.closest("td");
    const originalHTML = cell.dataset.originalHtml || "";
    cell.innerHTML     = originalHTML;
    delete cell.dataset.originalHtml;
    cell.onclick = () => App.plEditNotes(cell);
  }

  // ── Delete offer from pricelist ──────────────────────────────────────────
  async function plDeleteOffer(id, supplier, product) {
    const confirmed = window.confirm(
      `Usunąć wycenę:\n"${product}" od "${supplier}"?\n\nTej operacji nie można cofnąć.`
    );
    if (!confirmed) return;

    try {
      const res = await fetch(`/api/quotations/${id}`, { method: "DELETE" });
      if (!res.ok && res.status !== 204) throw new Error("HTTP " + res.status);

      // Remove from local cache and re-render
      for (const key of Object.keys(_plData)) {
        _plData[key] = (_plData[key] || []).filter(r => r.id !== id);
      }
      _renderPricelist("sub");
      _renderPricelist("other");
      toast(`Usunięto wycenę: ${product} / ${supplier}`, "success");
    } catch (e) {
      toast("Błąd usuwania: " + e.message, "danger");
    }
  }

  // ── Duplicate detection ───────────────────────────────────────────────────
  function _checkDuplicates(rows) {
    /**
     * Given a list of rows to save, check against _plData for existing
     * quotations with the same product (case-insensitive) + supplier.
     * Returns array of duplicate descriptors.
     */
    const existing = [...(_plData["sub"] || []), ...(_plData["other"] || [])];
    const dupes = [];
    for (const r of rows) {
      const pNorm = (r.product_name || "").toLowerCase().trim();
      const sNorm = (r.supplier || "").toLowerCase().trim();
      if (!pNorm || !sNorm) continue;
      const match = existing.find(e =>
        e.product_name.toLowerCase().trim() === pNorm &&
        e.supplier.toLowerCase().trim() === sNorm
      );
      if (match) dupes.push({ row: r, existing: match });
    }
    return dupes;
  }

  async function _confirmDuplicates(dupes) {
    /**
     * Show a confirmation dialog listing duplicates.
     * Returns true if user wants to save anyway, false to cancel.
     */
    if (!dupes.length) return true;
    const lines = dupes.map(d =>
      `• ${d.row.product_name} / ${d.row.supplier} — już istnieje (${d.existing.price_original} ${d.existing.currency})`
    ).join("\n");
    return window.confirm(
      `Wykryto ${dupes.length} duplikat${dupes.length > 1 ? "y" : ""}:\n\n${lines}\n\nZapisać mimo to?`
    );
  }

  function plExport(cat) {
    if (cat === "other") {
      window.location.href = `/api/export?category=opakowanie`;
      setTimeout(() => { window.location.href = `/api/export?category=kapsula`; }, 500);
    } else {
      window.location.href = `/api/export?category=${cat}`;
    }
  }

  // ── Mapping importer ──────────────────────────────────────────

  let _mapFileBytes = null;    // stored for re-use in preview/import
  let _mapDetectData = null;   // result from /api/import/map/detect
  let _mapCurrentMapping = {}; // {original_col: field_key}

  async function mapDetect() {
    const fileInput = document.getElementById("map-file");
    if (!fileInput.files.length) { toast("Wybierz plik Excel.", "warning"); return; }

    spinner(true);
    try {
      const fd = new FormData();
      fd.append("file", fileInput.files[0]);
      const res = await apiFetch("/api/import/map/detect", { method: "POST", body: fd });
      _mapDetectData = await res.json();
      // Store file for later
      _mapFileBytes = fileInput.files[0];
      _renderMapTable(_mapDetectData);
      document.getElementById("map-step2").style.display = "";
      document.getElementById("map-import-btn").disabled = true;
      document.getElementById("map-export-btn").disabled = true;
      document.getElementById("map-flow-hint").style.display = "none";
      document.getElementById("map-preview-wrap").innerHTML = "";
      document.getElementById("map-errors").innerHTML = "";
    } catch (e) {
      toast("Błąd analizy: " + e.message, "danger");
    } finally {
      spinner(false);
    }
  }

  function _renderMapTable(data) {
    const { columns, mapping, sample_rows, our_fields } = data;

    // Build current mapping state from detection
    _mapCurrentMapping = {};
    columns.forEach(col => {
      _mapCurrentMapping[col] = mapping[col]?.field || "_skip";
    });

    const fieldOptions = our_fields.map(f =>
      `<option value="${escHtml(f.key)}">${escHtml(f.label)}${f.required ? " *" : ""}</option>`
    ).join("");

    const tbody = document.getElementById("map-table-body");
    tbody.innerHTML = columns.map((col, colIdx) => {
      const m = mapping[col] || { field: "_skip", score: 0 };
      const samples = sample_rows.map(r => escHtml(r[colIdx] || "")).filter(Boolean).slice(0, 2).join(" / ") || "—";
      const score = m.score;
      const scoreCls = score >= 80 ? "text-success fw-bold" : score >= 50 ? "text-warning" : "text-muted";
      const scoreDot = score >= 80 ? "🟢" : score >= 50 ? "🟡" : "⚪";

      const colId = `map-sel-${colIdx}`;
      return `<tr>
        <td class="ps-3 fw-semibold">${escHtml(col)}</td>
        <td class="text-muted small">${samples}</td>
        <td>
          <select class="form-select form-select-sm" id="${colId}"
            onchange="App._mapUpdate('${escHtml(col)}', this.value)">
            ${fieldOptions}
          </select>
        </td>
        <td class="text-center ${scoreCls}">${scoreDot} ${score > 0 ? score + "%" : "—"}</td>
      </tr>`;
    }).join("");

    // Set selected values
    columns.forEach((col, colIdx) => {
      const sel = document.getElementById(`map-sel-${colIdx}`);
      if (sel) sel.value = _mapCurrentMapping[col] || "_skip";
    });
  }

  function _mapUpdate(col, fieldKey) {
    _mapCurrentMapping[col] = fieldKey;
    // Reset preview when mapping changes
    document.getElementById("map-preview-wrap").innerHTML = "";
    document.getElementById("map-import-btn").disabled = true;
    document.getElementById("map-export-btn").disabled = true;
    document.getElementById("map-flow-hint").style.display = "none";
  }

  async function mapPreview() {
    if (!_mapFileBytes) { toast("Brak pliku.", "warning"); return; }
    spinner(true);
    try {
      const fd = new FormData();
      fd.append("file", _mapFileBytes);

      // Apply supplier override if set
      const supplierOverride = document.getElementById("map-supplier-override").value.trim();
      const mappingToSend = { ..._mapCurrentMapping };
      if (supplierOverride && !Object.values(mappingToSend).includes("supplier")) {
        // no supplier column mapped — we'll handle it on import via override
        mappingToSend["__supplier_override__"] = "supplier";
      }

      const params = new URLSearchParams({ mapping_json: JSON.stringify(_mapCurrentMapping) });
      const res = await apiFetch(`/api/import/map/confirm?${params}&_dry_run=1`, { method: "POST", body: fd });

      // Fake dry run — just detect for preview
      const previewFd = new FormData();
      previewFd.append("file", _mapFileBytes);
      previewFd.append("mapping_json", JSON.stringify(_mapCurrentMapping));

      // Use detect data + current mapping to build preview locally
      _renderMapPreview();
    } catch (e) {
      toast("Błąd podglądu: " + e.message, "danger");
    } finally {
      spinner(false);
    }
  }

  function _renderMapPreview() {
    if (!_mapDetectData) return;
    const { columns, sample_rows, our_fields } = _mapDetectData;

    // Build field label map
    const fieldLabels = {};
    our_fields.forEach(f => { fieldLabels[f.key] = f.label; });

    // Show how the sample rows will be mapped
    const mappedCols = columns
      .map((col, i) => ({ col, field: _mapCurrentMapping[col] || "_skip", idx: i }))
      .filter(x => x.field !== "_skip");

    const thead = `<tr>${mappedCols.map(x =>
      `<th class="small">${escHtml(fieldLabels[x.field] || x.field)}<br><span class="text-muted" style="font-size:.75rem">${escHtml(x.col)}</span></th>`
    ).join("")}</tr>`;

    const tbody = _mapDetectData.sample_rows.map(row =>
      `<tr>${mappedCols.map(x => `<td class="small">${escHtml(row[x.idx] || "—")}</td>`).join("")}</tr>`
    ).join("");

    const supplierOverride = document.getElementById("map-supplier-override").value.trim();
    const hasSupplier = Object.values(_mapCurrentMapping).includes("supplier");
    const supplierNote = !hasSupplier && supplierOverride
      ? `<div class="alert alert-info py-1 small mb-2"><i class="bi bi-info-circle me-1"></i>Dostawca zostanie ustawiony jako: <strong>${escHtml(supplierOverride)}</strong></div>`
      : !hasSupplier ? `<div class="alert alert-warning py-1 small mb-2"><i class="bi bi-exclamation-triangle me-1"></i>Nie zmapowano kolumny <strong>Dostawca</strong> — wpisz go w polu "Dostawca" powyżej lub zmapuj kolumnę.</div>` : "";

    const requiredFields = our_fields.filter(f => f.required).map(f => f.key);
    const mappedFieldKeys = Object.values(_mapCurrentMapping).filter(v => v !== "_skip");
    const missingReq = requiredFields.filter(f => !mappedFieldKeys.includes(f));
    const missingNote = missingReq.length
      ? `<div class="alert alert-danger py-1 small mb-2"><i class="bi bi-x-circle me-1"></i>Brakuje wymaganych pól: <strong>${missingReq.map(f => fieldLabels[f] || f).join(", ")}</strong></div>`
      : "";

    const canImport = missingReq.length === 0 && (hasSupplier || supplierOverride);

    document.getElementById("map-errors").innerHTML = missingNote + supplierNote;
    document.getElementById("map-preview-wrap").innerHTML = `
      <p class="small text-muted mb-2">Podgląd pierwszych ${_mapDetectData.sample_rows.length} wierszy po mapowaniu:</p>
      <div class="table-responsive">
        <table class="table table-sm table-bordered mb-0" style="font-size:.82rem">
          <thead style="background:#2c3e50;color:#fff">${thead}</thead>
          <tbody>${tbody}</tbody>
        </table>
      </div>
      <p class="text-muted small mt-1">Dane wyglądają poprawnie? Kliknij "Importuj do bazy".</p>`;

    document.getElementById("map-import-btn").disabled = !canImport;
    document.getElementById("map-export-btn").disabled = false;
    document.getElementById("map-flow-hint").style.display = "";
  }

  async function mapExportTemplate() {
    if (!_mapFileBytes) { toast("Brak pliku.", "warning"); return; }
    const supplierOverride = document.getElementById("map-supplier-override").value.trim();
    const params = new URLSearchParams({ mapping_json: JSON.stringify(_mapCurrentMapping) });
    if (supplierOverride) params.set("supplier_override", supplierOverride);

    // Build form and submit — triggers file download
    const fd = new FormData();
    fd.append("file", _mapFileBytes);

    spinner(true);
    try {
      const res = await apiFetch(`/api/import/map/export?${params}`, { method: "POST", body: fd });
      const blob = await res.blob();
      // Extract filename from Content-Disposition header
      const cd = res.headers.get("Content-Disposition") || "";
      const match = cd.match(/filename=([^;]+)/);
      const filename = match ? match[1].trim() : "wycena_szablon.xlsx";
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
      toast("Plik pobrany — otwórz w Excelu, sprawdź i popraw, a następnie wgraj przez zakładkę Import.", "success");
    } catch (e) {
      toast("Błąd eksportu: " + e.message, "danger");
    } finally {
      spinner(false);
    }
  }

  async function mapImport() {
    if (!_mapFileBytes) { toast("Brak pliku.", "warning"); return; }

    const supplierOverride = document.getElementById("map-supplier-override").value.trim();
    const mappingToSend = { ..._mapCurrentMapping };

    // If supplier not mapped but override given — add a virtual mapping marker in notes
    // The backend will pick it up from supplier column if it exists
    const fd = new FormData();
    fd.append("file", _mapFileBytes);

    const params = new URLSearchParams({ mapping_json: JSON.stringify(mappingToSend) });
    if (supplierOverride) params.set("supplier_override", supplierOverride);

    spinner(true);
    try {
      const res = await apiFetch(`/api/import/map/confirm?${params}`, { method: "POST", body: fd });
      const data = await res.json();
      toast(`Import: zapisano ${data.saved} wycen${data.skipped ? `, pominięto ${data.skipped}` : ""}.`,
        data.saved > 0 ? "success" : "warning");
      if (data.errors?.length) {
        document.getElementById("map-errors").innerHTML =
          `<div class="alert alert-warning p-2 small"><strong>Błędy:</strong><ul class="mb-0">${data.errors.map(e => `<li>${escHtml(e)}</li>`).join("")}</ul></div>`;
      }
      document.getElementById("map-import-btn").disabled = true;
      loadDashboard();
      _loadProducts();
    } catch (e) {
      toast("Błąd importu: " + e.message, "danger");
    } finally {
      spinner(false);
    }
  }

  // ── Export ────────────────────────────────────────────────────

  function exportExcel() {
    const params = new URLSearchParams();
    const v = id => document.getElementById(id).value.trim();
    if (v("f-category"))  params.set("category",     v("f-category"));
    if (v("f-product"))   params.set("product_name", v("f-product"));
    if (v("f-supplier"))  params.set("supplier",     v("f-supplier"));
    window.location.href = `/api/export?${params}`;
  }

  // ── Treomag ───────────────────────────────────────────────────

  async function loadTreomag() {
    document.getElementById("tm-table-wrap").innerHTML =
      `<div class="text-center text-secondary py-5">
        <div class="spinner-border text-warning" role="status"></div>
        <div class="mt-2">Parsowanie plików…</div>
      </div>`;
    try {
      const res = await apiFetch("/api/treomag");
      _tmData = await res.json();
      _renderTreomag(_tmData);
    } catch (e) {
      document.getElementById("tm-table-wrap").innerHTML =
        `<div class="alert alert-danger">${escHtml(e.message)}</div>`;
    }
  }

  function _tmFilteredGroups() {
    if (!_tmData) return [];
    const cat = document.getElementById("tm-filter-cat").value;
    const avail = document.getElementById("tm-filter-avail").value;
    return _tmData.groups.filter(g => {
      if (cat && g.category !== cat) return false;
      if (avail === "both" && !g.multi_supplier) return false;
      if (avail === "amita" && (g.multi_supplier || !g.offers.some(o => o.supplier === "AMITA HC"))) return false;
      if (avail === "emma"  && (g.multi_supplier || !g.offers.some(o => o.supplier === "EMMA TRADE"))) return false;
      return true;
    });
  }

  function _renderTreomag(data) {
    const matched    = data.groups.filter(g => g.multi_supplier).length;
    const amitaOnly  = data.groups.filter(g => !g.multi_supplier && g.offers[0]?.supplier === "AMITA HC").length;
    const emmaOnly   = data.groups.filter(g => !g.multi_supplier && g.offers[0]?.supplier === "EMMA TRADE").length;
    const rates = data.rates || {};

    document.getElementById("tm-kpis").innerHTML = `
      <div class="col-auto"><div class="summary-card bg-primary">
        <div class="fs-3 fw-bold">${data.amita_count}</div><div class="small">AMITA HC</div>
      </div></div>
      <div class="col-auto"><div class="summary-card bg-success">
        <div class="fs-3 fw-bold">${data.emma_count}</div><div class="small">EMMA TRADE</div>
      </div></div>
      <div class="col-auto"><div class="summary-card" style="background:#e67e22">
        <div class="fs-3 fw-bold">${matched}</div><div class="small">U obu</div>
      </div></div>
      <div class="col-auto"><div class="summary-card bg-secondary">
        <div class="fs-3 fw-bold">${amitaOnly + emmaOnly}</div><div class="small">Tylko jeden</div>
      </div></div>
      <div class="col-auto ms-auto"><div class="summary-card" style="background:#2980b9;font-size:.8rem">
        <div class="fw-bold mb-1">Kursy NBP</div>
        <div>EUR = ${fmt(rates.EUR, 4)} PLN</div>
        <div>USD = ${fmt(rates.USD, 4)} PLN</div>
      </div></div>`;

    const keminEl = document.getElementById("tm-kemin-note");
    if (data.kemin_note) { keminEl.innerHTML = `<i class="bi bi-info-circle me-2"></i>${escHtml(data.kemin_note)}`; keminEl.style.display = ""; }

    const warnEl = document.getElementById("tm-warnings");
    warnEl.innerHTML = data.warnings?.length
      ? `<div class="alert alert-warning py-2 small mb-2">${data.warnings.map(w => escHtml(w)).join("<br>")}</div>` : "";

    const cats = [...new Set(data.groups.map(g => g.category))].sort();
    const catSel = document.getElementById("tm-filter-cat");
    catSel.innerHTML = `<option value="">Wszystkie kategorie</option>` +
      cats.map(c => `<option value="${escHtml(c)}">${escHtml(c)}</option>`).join("");

    _renderTreomogTable();
  }

  function _renderTreomogTable() {
    const groups = _tmFilteredGroups();
    const wrap = document.getElementById("tm-table-wrap");
    if (!groups.length) { wrap.innerHTML = `<div class="alert alert-secondary">Brak wyników.</div>`; return; }

    const SUPPLIERS = ["AMITA HC", "EMMA TRADE"];
    const SUP_COLOR = { "AMITA HC": "#0d6efd", "EMMA TRADE": "#198754" };
    const byCategory = {};
    groups.forEach(g => { if (!byCategory[g.category]) byCategory[g.category] = []; byCategory[g.category].push(g); });

    let html = `<div class="table-responsive">
      <table class="table table-sm align-middle mb-0" id="tm-table">
        <thead>
          <tr style="background:#2c3e50;color:#fff;font-size:.82rem">
            <th style="width:28%">Produkt</th>
            <th style="width:10%">Dostępność</th>
            ${SUPPLIERS.map(s => `<th colspan="3" class="text-center" style="border-left:2px solid #fff;background:${SUP_COLOR[s]}cc">${s}</th>`).join("")}
          </tr>
          <tr style="background:#34495e;color:#ccc;font-size:.78rem">
            <th></th><th></th>
            ${SUPPLIERS.map(() => `<th class="text-end" style="border-left:2px solid #555">Cena oryg.</th><th class="text-end">PLN/kg</th><th>MOQ</th>`).join("")}
          </tr>
        </thead>
        <tbody>`;

    Object.entries(byCategory).forEach(([cat, catGroups]) => {
      html += `<tr class="table-dark"><td colspan="8" class="fw-semibold small py-1 ps-2">
        <i class="bi bi-tag-fill me-1"></i>${escHtml(cat).toUpperCase()}
        <span class="badge bg-secondary ms-2">${catGroups.length}</span>
      </td></tr>`;

      catGroups.forEach(group => {
        const offerBySupplier = {};
        group.offers.forEach(o => { offerBySupplier[o.supplier] = o; });
        const allPrices = group.offers.map(o => o.price_pln).filter(Boolean);
        const bestPln = allPrices.length ? Math.min(...allPrices) : null;
        const availBadge = group.multi_supplier
          ? `<span class="badge" style="background:#e67e22">Obaj ✓</span>`
          : `<span class="badge bg-secondary">${escHtml(group.offers[0]?.supplier?.split(" ")[0] || "—")}</span>`;

        const rowCells = SUPPLIERS.map(sup => {
          const offer = offerBySupplier[sup];
          if (!offer) return `<td class="text-center text-muted" style="border-left:2px solid #dee2e6" colspan="3">—</td>`;
          const isBest = group.multi_supplier && offer.price_pln === bestPln;
          const priceCls = isBest ? "fw-bold text-success" : "";
          const cellBg = isBest ? 'style="background:#d1e7dd"' : "";
          const winner = isBest ? "🏆 " : "";
          const tiersHtml = offer.tiers?.length
            ? `<br><small class="text-muted">Progi: ${offer.tiers.map(t => `${fmtQty(t.moq, "kg")}→${fmt(t.price_pln||t.price,2)}PLN`).join(", ")}</small>` : "";
          const noteHtml = offer.notes ? `<br><small class="text-muted fst-italic">${escHtml(offer.notes.slice(0,40))}</small>` : "";
          const moqStr = offer.moq ? fmtQty(offer.moq, offer.unit || "kg") : "brak";
          const leadStr = offer.lead_time ? `<br><small class="text-muted">${escHtml(offer.lead_time)}</small>` : "";
          return `
            <td class="text-end small ${priceCls}" ${cellBg} style="border-left:2px solid #dee2e6">
              ${winner}${fmt(offer.price_original,2)} ${offer.currency}/kg${tiersHtml}
            </td>
            <td class="text-end fw-semibold ${priceCls}" ${cellBg}>${fmt(offer.price_pln,2)}${leadStr}</td>
            <td class="small" ${cellBg}>${moqStr}${noteHtml}</td>`;
        }).join("");

        html += `<tr style="font-size:.83rem;${!group.multi_supplier?'color:#6c757d':''}">
          <td class="fw-semibold">${escHtml(group.group_name)}</td>
          <td>${availBadge}</td>
          ${rowCells}
        </tr>`;
      });
    });

    html += `</tbody></table></div>
      <p class="text-muted small mt-2">🏆 = najtańsza opcja w wierszu &nbsp;·&nbsp;
        <span class="badge" style="background:#e67e22">Obaj ✓</span> = dostępny u obu dostawców</p>`;
    wrap.innerHTML = html;
  }

  // ── Summary ───────────────────────────────────────────────────

  async function loadSummary() {
    try {
      const res = await apiFetch("/api/summary");
      const data = await res.json();
      _renderSummaryStats(data);
      _renderSummaryTable(data.products);
    } catch (_) {}
  }

  function _renderSummaryStats(data) {
    const counts = { substancja_czynna: 0, opakowanie: 0, kapsula: 0 };
    data.products.forEach(p => { if (counts[p.category] !== undefined) counts[p.category]++; });
    document.getElementById("summary-stats").innerHTML = `
      <div class="col-auto"><div class="summary-card bg-primary">
        <div class="fs-2 fw-bold">${data.total_quotations}</div><div class="small">Wszystkich wycen</div>
      </div></div>
      <div class="col-auto"><div class="summary-card bg-info text-dark">
        <div class="fs-2 fw-bold">${counts.substancja_czynna}</div><div class="small">Substancje czynne</div>
      </div></div>
      <div class="col-auto"><div class="summary-card" style="background:#6f42c1">
        <div class="fs-2 fw-bold">${counts.opakowanie}</div><div class="small">Opakowania</div>
      </div></div>
      <div class="col-auto"><div class="summary-card bg-success">
        <div class="fs-2 fw-bold">${counts.kapsula}</div><div class="small">Kapsułki</div>
      </div></div>`;
  }

  function _renderSummaryTable(products) {
    const tbody = document.getElementById("summary-tbody");
    if (!products.length) {
      tbody.innerHTML = `<tr><td colspan="5" class="text-center text-secondary py-4">Brak danych.</td></tr>`;
      return;
    }
    tbody.innerHTML = products
      .sort((a, b) => a.category.localeCompare(b.category) || a.product_name.localeCompare(b.product_name))
      .map(p => `<tr>
        <td class="ps-3">${catBadge(p.category)}</td>
        <td class="fw-semibold">${escHtml(p.product_name)}</td>
        <td class="text-center">${p.offer_count}</td>
        <td class="text-end text-success fw-bold">${fmt(p.best_price_per_unit_pln, 4)} PLN</td>
        <td>${escHtml(p.best_supplier)}</td>
      </tr>`).join("");
  }

  // ── Tab hooks ─────────────────────────────────────────────────

  // Bug fix: also listen to pill tabs (data-bs-toggle="pill") for sub-tabs like OCR
  document.querySelectorAll('[data-bs-toggle="tab"],[data-bs-toggle="pill"]').forEach(tab => {
    tab.addEventListener("shown.bs.tab", e => {
      const target = e.target.getAttribute("data-bs-target");
      if (target === "#tab-dashboard")       loadDashboard();
      if (target === "#tab-order")           _loadProducts();
      if (target === "#tab-pricelist-sub")   loadPricelist("sub");
      if (target === "#tab-pricelist-other") loadPricelist("other");
      if (target === "#tab-compare")         loadQuotations();
      if (target === "#tab-summary")         loadSummary();
      if (target === "#tab-suppliers")        _initSuppliers();
      if (target === "#tab-inbox")            _initInbox();
      if (target === "#sub-import-ocr")       _ocrInit();
      if (target === "#tab-add")              _addOcrInit();
      if (target === "#add-mode-file")        _addOcrInit();
    });
  });

  ["tm-filter-cat", "tm-filter-avail"].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.addEventListener("change", _renderTreomogTable);
  });

  // ── Init ──────────────────────────────────────────────────────

  function init() {
    refreshRates();
    loadDashboard();
    _loadProducts();
  }

  document.addEventListener("DOMContentLoaded", init);

  // ── Suppliers tab ─────────────────────────────────────────────────────────

  // Inbox state
  let _inboxAll = [];
  let _inboxFilter = "active";  // shows new + pending
  let _inboxReviewId = null;
  let _inboxModal = null;

  let _suppliers = [];
  let _supSelected = null;
  let _supOffers = [];
  let _supChecked = new Set();
  let _supPipedrive = null;
  let _supSelectedContact = null;   // currently selected contact person
  let _orderModal = null;
  let _smtpModal  = null;

  // ── "Dodaj wycenę" — OCR mode ─────────────────────────────────────────────

  let _addOcrFiles = [];          // array of File objects (multi-file)
  let _addOcrRows = [];
  let _addOcrSourceFile = null;   // saved filename on server (last processed)
  let _addOcrSourceOrig = null;   // original filename (last processed)

  let _addOcrKeyOk = false;

  function _addOcrInit() {
    // Populate all datalists: OCR supplier, form supplier, form product
    const ocrDl  = document.getElementById("add-ocr-supplier-list");
    const supDl  = document.getElementById("form-supplier-list");
    const prodDl = document.getElementById("form-product-list");

    const fillSuppliers = (list) => {
      const opts = list.map(s => `<option value="${escHtml(s.name)}">`).join("");
      if (ocrDl) ocrDl.innerHTML = opts;
      if (supDl) supDl.innerHTML = opts;
    };

    const fillProducts = (names) => {
      if (prodDl) prodDl.innerHTML = names.map(n => `<option value="${escHtml(n)}">`).join("");
    };

    // Suppliers
    if (_suppliers.length) {
      fillSuppliers(_suppliers);
    } else {
      apiFetch("/api/suppliers").then(r => r.json()).then(list => {
        fillSuppliers(list);
      }).catch(() => {});
    }

    // Products — fetch all unique product names from DB
    apiFetch("/api/products/names").then(r => r.json()).then(data => {
      fillProducts(data.names || []);
    }).catch(() => {});
    // Check OpenAI key status
    fetch("/api/config/openai-status").then(r => r.json()).then(d => {
      _addOcrKeyOk = d.configured;
      const w = document.getElementById("add-ocr-key-warning");
      if (w) w.style.display = d.configured ? "none" : "";
    }).catch(() => {});
  }

  function addOcrDrop(e) {
    e.preventDefault();
    document.getElementById("add-ocr-dropzone").classList.remove("ocr-drag-over");
    const files = [...(e.dataTransfer?.files || [])];
    if (files.length) _addOcrAddFiles(files);
  }

  function addOcrFileSelected(input) {
    const files = [...(input.files || [])];
    if (files.length) _addOcrAddFiles(files);
    input.value = ""; // reset so same file can be re-added
  }

  function _addOcrAddFiles(newFiles) {
    const allowed = new Set([".png",".jpg",".jpeg",".webp",".gif",".pdf",
                             ".xlsx",".xls",".txt",".csv",".docx",".doc"]);
    newFiles.forEach(f => {
      const ext = "." + f.name.split(".").pop().toLowerCase();
      if (!allowed.has(ext)) { toast(`Nieobsługiwany format: ${f.name}`, "warning"); return; }
      // Avoid duplicates by name+size
      if (_addOcrFiles.some(x => x.name === f.name && x.size === f.size)) return;
      _addOcrFiles.push(f);
    });
    _addOcrRenderFileList();
    document.getElementById("add-ocr-analyze-btn").disabled = _addOcrFiles.length === 0;
  }

  function _addOcrRenderFileList() {
    const listWrap = document.getElementById("add-ocr-file-list");
    const items    = document.getElementById("add-ocr-file-items");
    if (!_addOcrFiles.length) { listWrap.style.display = "none"; return; }
    listWrap.style.display = "";

    const IMG_TYPES = ["image/png","image/jpeg","image/gif","image/webp"];

    items.innerHTML = _addOcrFiles.map((f, i) => {
      const isImg = IMG_TYPES.includes(f.type);
      const icon  = isImg ? "bi-image" : f.name.endsWith(".pdf") ? "bi-filetype-pdf"
                  : f.name.match(/\.xlsx?$/) ? "bi-file-earmark-excel"
                  : f.name.match(/\.docx?$/) ? "bi-file-earmark-word" : "bi-file-text";
      return `<div class="d-flex align-items-center gap-2 p-2 border rounded bg-light ocr-file-item" data-idx="${i}">
        <i class="bi ${icon} text-purple fs-5 flex-shrink-0"></i>
        <div class="flex-grow-1 min-w-0">
          <div class="small fw-semibold text-truncate">${escHtml(f.name)}</div>
          <div class="text-muted" style="font-size:.72rem">${_fmtSize(f.size)}</div>
        </div>
        ${isImg ? `<img class="rounded" src="${URL.createObjectURL(f)}"
            style="width:48px;height:36px;object-fit:cover;border:1px solid #dee2e6">` : ""}
        <button class="btn btn-sm btn-outline-danger p-1 flex-shrink-0"
          onclick="App._addOcrRemoveFile(${i})" title="Usuń">
          <i class="bi bi-x"></i>
        </button>
      </div>`;
    }).join("");
  }

  function _addOcrRemoveFile(idx) {
    _addOcrFiles.splice(idx, 1);
    _addOcrRenderFileList();
    document.getElementById("add-ocr-analyze-btn").disabled = _addOcrFiles.length === 0;
  }

  function addOcrClear() {
    _addOcrFiles = [];
    _addOcrRows = [];
    document.getElementById("add-ocr-file-input").value = "";
    document.getElementById("add-ocr-file-list").style.display = "none";
    document.getElementById("add-ocr-file-items").innerHTML = "";
    document.getElementById("add-ocr-analyze-btn").disabled = true;
    document.getElementById("add-ocr-import-btn").style.display = "none";
    document.getElementById("add-ocr-selall-btn").style.display = "none";
    document.getElementById("add-ocr-count").style.display = "none";
    document.getElementById("add-ocr-results").innerHTML = `
      <div class="text-center text-muted py-5 px-3">
        <i class="bi bi-stars fs-1 d-block mb-3 opacity-25 text-purple"></i>
        <p class="mb-1 fw-semibold">Wgraj pliki z wyceną</p>
        <p class="small">Możesz wgrać kilka plików naraz — screenshoty, PDF-y, Excele, Word.</p>
      </div>`;
  }

  // ── Paste-text mode ──────────────────────────────────────────────────────
  let _pasteTextRows = [];

  function pasteTextChanged() {
    const ta   = document.getElementById("paste-text-input");
    const btn  = document.getElementById("paste-text-analyze-btn");
    const span = document.getElementById("paste-text-chars");
    const len  = (ta.value || "").length;
    span.textContent = len;
    btn.disabled = len < 10;
  }

  function pasteTextClear() {
    _pasteTextRows = [];
    document.getElementById("paste-text-input").value = "";
    document.getElementById("paste-text-supplier").value = "";
    document.getElementById("paste-text-chars").textContent = "0";
    document.getElementById("paste-text-analyze-btn").disabled = true;
    document.getElementById("paste-text-save-btn").disabled = true;
    document.getElementById("paste-text-footer").style.display = "none";
    document.getElementById("paste-text-count").textContent = "0";
    document.getElementById("paste-text-results").innerHTML = `
      <div class="text-center text-muted p-4">
        <i class="bi bi-clipboard fs-1 d-block mb-2 opacity-25"></i>
        Wklej tekst i kliknij „Analizuj"
      </div>`;
  }

  async function addOcrAnalyzeText() {
    const ta  = document.getElementById("paste-text-input");
    const txt = (ta.value || "").trim();
    if (txt.length < 10) { toast("Wklej treść wyceny", "warning"); return; }

    const prog    = document.getElementById("paste-text-progress");
    const btn     = document.getElementById("paste-text-analyze-btn");
    const results = document.getElementById("paste-text-results");
    const footer  = document.getElementById("paste-text-footer");
    const countBadge = document.getElementById("paste-text-count");

    prog.style.display = "";
    btn.disabled = true;
    results.innerHTML = `<div class="text-center text-muted py-5">
      <div class="spinner-border mb-3" style="color:#198754"></div>
      <div class="fw-semibold">AI analizuje tekst…</div>
      <div class="small text-muted mt-1">To może potrwać kilka sekund</div>
    </div>`;
    footer.style.display = "none";

    try {
      // Send pasted text as a .txt file to the existing OCR endpoint
      const supplierHint = (document.getElementById("paste-text-supplier").value || "").trim();
      const blob = new Blob([txt], { type: "text/plain" });
      const form = new FormData();
      form.append("file", blob, "wklejony_tekst.txt");
      if (supplierHint) form.append("supplier_hint", supplierHint);

      const res = await fetch("/api/import/ocr", { method: "POST", body: form });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.detail || `HTTP ${res.status}`);
      }
      const data = await res.json();
      _pasteTextRows = data.rows || [];

      // Auto-fill supplier from AI if not already set
      const supField = document.getElementById("paste-text-supplier");
      if (!supField.value.trim() && _pasteTextRows.length) {
        const freq = {};
        _pasteTextRows.forEach(r => r.supplier && (freq[r.supplier] = (freq[r.supplier]||0)+1));
        const top = Object.entries(freq).sort((a,b)=>b[1]-a[1])[0];
        if (top) supField.value = top[0];
      }

      _pasteTextRenderResults(_pasteTextRows);
    } catch(err) {
      results.innerHTML = `<div class="alert alert-danger m-3"><i class="bi bi-exclamation-triangle me-2"></i>${escHtml(err.message)}</div>`;
      footer.style.display = "none";
    } finally {
      prog.style.display = "none";
      btn.disabled = false;
    }
  }

  function _pasteTextRenderResults(rows) {
    const results    = document.getElementById("paste-text-results");
    const footer     = document.getElementById("paste-text-footer");
    const saveBtn    = document.getElementById("paste-text-save-btn");
    const countBadge = document.getElementById("paste-text-count");

    countBadge.textContent = rows.length;

    if (!rows.length) {
      results.innerHTML = `<div class="text-center text-muted py-5">
        <i class="bi bi-inbox fs-1 d-block mb-2 opacity-25"></i>
        <div class="fw-semibold">Brak wykrytych pozycji</div>
        <div class="small mt-1">Spróbuj z bardziej szczegółowym tekstem</div>
      </div>`;
      footer.style.display = "none";
      return;
    }

    const catLabel = {substancja_czynna:"Substancja", opakowanie:"Opakowanie", kapsula:"Kapsułka"};
    let html = `<table class="table table-sm mb-0 align-middle" style="font-size:.83rem">
      <thead class="table-light sticky-top">
        <tr>
          <th style="width:36px">
            <input type="checkbox" class="form-check-input" id="paste-text-chk-all"
              onchange="App.pasteTextToggleAll(this.checked)">
          </th>
          <th>Produkt</th><th>Dostawca</th><th class="text-end">Cena/jedn.</th><th>Waluta</th>
          <th class="text-end">MOQ</th><th>Jedn.</th><th>Kategoria</th>
        </tr>
      </thead><tbody>`;

    rows.forEach((r, i) => {
      html += `<tr>
        <td><input type="checkbox" class="form-check-input paste-text-chk" data-idx="${i}" checked></td>
        <td style="min-width:140px">
          <input type="text" class="ocr-edit-input fw-semibold" value="${escHtml(r.product_name||"")}"
            onchange="window._pasteTextUpdate(${i},'product_name',this.value)" style="min-width:130px">
        </td>
        <td style="min-width:110px">
          <input type="text" class="ocr-edit-input text-muted" value="${escHtml(r.supplier||"")}" placeholder="—"
            onchange="window._pasteTextUpdate(${i},'supplier',this.value)" style="min-width:100px">
        </td>
        <td class="text-end" style="min-width:75px">
          <input type="number" class="ocr-edit-input text-end fw-semibold text-success"
            value="${r.price_original ?? ""}" step="any"
            onchange="window._pasteTextUpdate(${i},'price_original',parseFloat(this.value))" style="width:70px">
        </td>
        <td>
          <select class="ocr-edit-select" onchange="window._pasteTextUpdate(${i},'currency',this.value)" style="width:65px">
            ${["PLN","EUR","USD"].map(c=>`<option${(r.currency||"PLN")===c?" selected":""}>${c}</option>`).join("")}
          </select>
        </td>
        <td class="text-end">
          <input type="number" class="ocr-edit-input text-end" value="${r.moq ?? ""}" step="any" placeholder="—"
            onchange="window._pasteTextUpdate(${i},'moq',this.value?parseFloat(this.value):null)" style="width:60px">
        </td>
        <td>
          <input type="text" class="ocr-edit-input" value="${escHtml(r.unit||"kg")}"
            onchange="window._pasteTextUpdate(${i},'unit',this.value)" style="width:42px">
        </td>
        <td>
          <select class="ocr-edit-select" onchange="window._pasteTextUpdate(${i},'category',this.value)" style="width:100px">
            ${Object.entries(catLabel).map(([v,l])=>`<option value="${v}"${(r.category||"substancja_czynna")===v?" selected":""}>${l}</option>`).join("")}
          </select>
        </td>
      </tr>`;
    });

    html += `</tbody></table>`;
    results.innerHTML = html;
    footer.style.removeProperty("display");
    saveBtn.disabled = false;
  }

  window._pasteTextUpdate = function(idx, field, value) {
    if (_pasteTextRows[idx]) _pasteTextRows[idx][field] = value;
  };

  function pasteTextToggleAll(checked) {
    document.querySelectorAll(".paste-text-chk").forEach(c => c.checked = checked);
  }

  async function pasteTextSave() {
    const checked = [...document.querySelectorAll(".paste-text-chk:checked")]
      .map(c => ({..._pasteTextRows[+c.dataset.idx]})).filter(Boolean);
    if (!checked.length) { toast("Zaznacz co najmniej jedną pozycję", "warning"); return; }

    const supplierOverride = (document.getElementById("paste-text-supplier").value || "").trim();
    if (supplierOverride) checked.forEach(r => { if (!r.supplier) r.supplier = supplierOverride; });

    // Apply global quote fields to all rows
    const globalPriceType  = document.getElementById("paste-global-price-type")?.value || "netto";
    const globalIncoterm   = document.getElementById("paste-global-incoterm")?.value || null;
    const globalQuoteDate  = document.getElementById("paste-global-quote-date")?.value || null;
    const globalValidUntil = document.getElementById("paste-global-valid-until")?.value || null;
    checked.forEach(r => {
      r.price_type  = globalPriceType;
      r.incoterm    = globalIncoterm || r.incoterm || null;
      r.quote_date  = globalQuoteDate || r.quote_date || null;
      r.valid_until = globalValidUntil || r.valid_until || null;
    });

    // Duplicate check
    const dupes = _checkDuplicates(checked);
    if (dupes.length && !(await _confirmDuplicates(dupes))) return;

    const btn = document.getElementById("paste-text-save-btn");
    btn.disabled = true;
    try {
      const res = await fetch("/api/import/ocr/confirm", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ rows: checked, source_file: null }),
      });
      if (!res.ok) throw new Error((await res.json().catch(()=>({}))).detail || `HTTP ${res.status}`);
      const d = await res.json();
      toast(`Zapisano ${d.saved} pozycji`, "success");
      pasteTextClear();
      loadPricelist("sub");
      loadPricelist("other");
    } catch(err) {
      toast("Błąd zapisu: " + err.message, "danger");
      btn.disabled = false;
    }
  }

  // ── File OCR mode ─────────────────────────────────────────────────────────
  async function addOcrAnalyze() {
    if (!_addOcrFiles.length) { toast("Dodaj przynajmniej jeden plik", "warning"); return; }

    const prog    = document.getElementById("add-ocr-progress");
    const progMsg = prog.querySelector(".small");
    const btn     = document.getElementById("add-ocr-analyze-btn");
    const results = document.getElementById("add-ocr-results");
    prog.style.display = "";
    btn.disabled = true;
    _addOcrRows = [];

    const total = _addOcrFiles.length;
    const allRows = [];
    const errors  = [];

    for (let i = 0; i < total; i++) {
      const file = _addOcrFiles[i];
      if (progMsg) progMsg.textContent =
        total > 1 ? `Analizuję plik ${i+1} z ${total}: ${file.name}…`
                  : `AI analizuje ${file.name}…`;
      results.innerHTML = `<div class="text-center text-muted py-5">
        <div class="spinner-border text-purple mb-3"></div>
        <div class="fw-semibold">${escHtml(total > 1 ? `Plik ${i+1}/${total}: ${file.name}` : file.name)}</div>
        <div class="small text-muted mt-1">AI analizuje zawartość…</div>
        ${total > 1 ? `<div class="progress mt-3 mx-auto" style="max-width:200px;height:6px">
          <div class="progress-bar bg-purple" style="width:${Math.round(i/total*100)}%"></div>
        </div>` : ""}
      </div>`;

      try {
        const form = new FormData();
        form.append("file", file);
        const res = await fetch("/api/import/ocr", { method: "POST", body: form });
        if (!res.ok) {
          const err = await res.json().catch(() => ({}));
          throw new Error(err.detail || `HTTP ${res.status}`);
        }
        const data = await res.json();
        const rows = data.rows || [];
        // Tag each row with source filename for reference
        rows.forEach(r => { r._source_file = file.name; });
        allRows.push(...rows);
        _addOcrSourceFile = data.source_file || null;
        _addOcrSourceOrig = data.source_file_orig || null;
      } catch(e) {
        errors.push({ file: file.name, msg: e.message });
      }
    }

    _addOcrRows = allRows;
    _addOcrRenderResults(_addOcrRows);

    if (errors.length) {
      const errHtml = errors.map(e =>
        `<li><strong>${escHtml(e.file)}</strong>: ${escHtml(e.msg)}</li>`
      ).join("");
      results.insertAdjacentHTML("afterbegin",
        `<div class="alert alert-warning mx-3 mt-3 mb-0 small">
          <i class="bi bi-exclamation-triangle me-1"></i>
          Błędy przy ${errors.length} plikach:<ul class="mb-0 mt-1">${errHtml}</ul>
        </div>`);
    }

    // Auto-fill supplier from AI results
    if (_addOcrRows.length) {
      const supField = document.getElementById("add-ocr-supplier");
      const supHint  = document.getElementById("add-ocr-supplier-hint");
      const freq = {};
      _addOcrRows.forEach(r => r.supplier && (freq[r.supplier] = (freq[r.supplier]||0)+1));
      const topSupplier = Object.entries(freq).sort((a,b)=>b[1]-a[1])[0]?.[0] || null;

      let matchedSupplier = topSupplier;
      if (topSupplier && _suppliers.length) {
        const norm = s => s.toLowerCase().replace(/[^a-z0-9]/g, "");
        const n = norm(topSupplier);
        const m = _suppliers.find(s => { const sn = norm(s.name); return sn===n||sn.includes(n)||n.includes(sn); });
        if (m) matchedSupplier = m.name;
      }
      if (supField && !supField.value.trim() && matchedSupplier)
        supField.value = matchedSupplier;

      const detectedEmail = _addOcrRows.map(r=>r.contact_email).filter(Boolean)[0] || null;
      if (supHint) {
        const parts = [];
        if (detectedEmail) parts.push(`<i class="bi bi-envelope me-1"></i>${escHtml(detectedEmail)}`);
        if (topSupplier && topSupplier !== matchedSupplier)
          parts.push(`AI: <em>${escHtml(topSupplier)}</em>`);
        supHint.innerHTML = parts.length ? `<small class="text-muted">${parts.join(' · ')}</small>` : "";
      }
    }

    prog.style.display = "none";
    btn.disabled = false;
    if (total > 1 && _addOcrRows.length)
      toast(`Wykryto ${_addOcrRows.length} pozycji z ${total} plików`, "success");
  }

  function _addOcrRenderResults(rows) {
    const wrap   = document.getElementById("add-ocr-results");
    const badge  = document.getElementById("add-ocr-count");
    const impBtn = document.getElementById("add-ocr-import-btn");
    const selBtn = document.getElementById("add-ocr-selall-btn");
    badge.textContent = `${rows.length} pozycji`;
    badge.style.display = rows.length ? "" : "none";
    impBtn.style.display = rows.length ? "" : "none";
    selBtn.style.display = rows.length ? "" : "none";

    if (!rows.length) {
      wrap.innerHTML = `<div class="alert alert-warning m-3"><i class="bi bi-exclamation-circle me-2"></i>Nie znaleziono pozycji cenowych. Sprawdź jakość pliku.</div>`;
      return;
    }

    const catLabel = {substancja_czynna:"Substancja", opakowanie:"Opakowanie", kapsula:"Kapsułka"};
    wrap.innerHTML = `
      <div class="table-responsive">
        <table class="table table-sm table-hover align-middle mb-0" style="font-size:.83rem">
          <thead>
            <tr style="background:#2c3e50;color:#fff">
              <th style="width:3%">
                <input type="checkbox" class="form-check-input" id="add-ocr-chk-all"
                  onchange="App.addOcrToggleAll(this.checked)">
              </th>
              <th>Produkt</th>
              <th>Dostawca</th>
              <th class="text-end">Cena/kg</th>
              <th>Waluta</th>
              <th class="text-end">MOQ</th>
              <th>Jedn.</th>
              <th>Kategoria</th>
            </tr>
          </thead>
          <tbody>
            ${rows.map((r, i) => `
              <tr>
                <td><input type="checkbox" class="form-check-input add-ocr-chk" checked data-idx="${i}"></td>
                <td style="min-width:160px">
                  <input type="text" class="ocr-edit-input fw-semibold"
                    id="add-ocr-prod-${i}"
                    value="${escHtml(r.product_name)}" style="min-width:140px"
                    onchange="window._addOcrUpdate(${i},'product_name',this.value)">
                  ${r._suggested_product ? `
                  <div class="mt-1">
                    <span class="text-muted" style="font-size:.75rem">Baza: </span>
                    <a href="#" class="text-success fw-semibold" style="font-size:.75rem;text-decoration:none"
                      onclick="event.preventDefault();
                        document.getElementById('add-ocr-prod-${i}').value='${escHtml(r._suggested_product)}';
                        window._addOcrUpdate(${i},'product_name','${escHtml(r._suggested_product)}');
                        this.parentElement.remove()">
                      ✓ ${escHtml(r._suggested_product)}
                    </a>
                  </div>` : ''}
                </td>
                <td style="min-width:120px">
                  <input type="text" class="ocr-edit-input text-muted"
                    id="add-ocr-sup-${i}"
                    value="${escHtml(r.supplier||'')}" placeholder="—" style="width:120px"
                    onchange="window._addOcrUpdate(${i},'supplier',this.value)">
                  ${r._suggested_supplier ? `
                  <div class="mt-1">
                    <span class="text-muted" style="font-size:.75rem">Baza: </span>
                    <a href="#" class="text-primary fw-semibold" style="font-size:.75rem;text-decoration:none"
                      onclick="event.preventDefault();
                        document.getElementById('add-ocr-sup-${i}').value='${escHtml(r._suggested_supplier)}';
                        window._addOcrUpdate(${i},'supplier','${escHtml(r._suggested_supplier)}');
                        this.parentElement.remove()">
                      ✓ ${escHtml(r._suggested_supplier)}
                    </a>
                  </div>` : ''}
                  ${r._supplier_from_email ? `<div style="font-size:.72rem" class="text-info"><i class="bi bi-envelope me-1"></i>z emaila</div>` : ''}
                </td>
                <td class="text-end">
                  <input type="number" class="ocr-edit-input text-end fw-semibold text-success"
                    value="${r.price_original}" step="any" style="width:80px"
                    onchange="window._addOcrUpdate(${i},'price_original',parseFloat(this.value))">
                </td>
                <td>
                  <select class="ocr-edit-select" style="width:65px"
                    onchange="window._addOcrUpdate(${i},'currency',this.value)">
                    ${["PLN","EUR","USD"].map(c=>`<option ${r.currency===c?"selected":""}>${c}</option>`).join("")}
                  </select>
                </td>
                <td class="text-end">
                  <input type="number" class="ocr-edit-input text-end"
                    value="${r.moq ?? ''}" step="any" placeholder="—" style="width:60px"
                    onchange="window._addOcrUpdate(${i},'moq',this.value?parseFloat(this.value):null)">
                </td>
                <td>
                  <input type="text" class="ocr-edit-input"
                    value="${escHtml(r.unit||'kg')}" style="width:42px"
                    onchange="window._addOcrUpdate(${i},'unit',this.value)">
                </td>
                <td>
                  <select class="ocr-edit-select" style="width:100px"
                    onchange="window._addOcrUpdate(${i},'category',this.value)">
                    ${Object.entries(catLabel).map(([v,l])=>`<option value="${v}" ${r.category===v?"selected":""}>${l}</option>`).join("")}
                  </select>
                </td>
              </tr>`).join("")}
          </tbody>
        </table>
      </div>`;
  }

  window._addOcrUpdate = function(idx, field, value) {
    if (_addOcrRows[idx]) _addOcrRows[idx][field] = value;
  };

  function addOcrToggleAll(checked) {
    document.querySelectorAll(".add-ocr-chk").forEach(cb => cb.checked = checked);
  }

  function addOcrSelectAll() {
    const all = document.getElementById("add-ocr-chk-all");
    if (all) all.checked = true;
    addOcrToggleAll(true);
  }

  async function addOcrConfirm() {
    const checked = [...document.querySelectorAll(".add-ocr-chk:checked")]
      .map(cb => parseInt(cb.dataset.idx));
    if (!checked.length) { toast("Zaznacz co najmniej jedną pozycję", "warning"); return; }
    const rows = checked.map(i => ({..._addOcrRows[i]}));
    const supplierOverride = document.getElementById("add-ocr-supplier")?.value.trim() || null;
    if (supplierOverride) rows.forEach(r => { if (!r.supplier) r.supplier = supplierOverride; });

    // Apply global quote fields to all rows
    const globalPriceType  = document.getElementById("ocr-global-price-type")?.value || "netto";
    const globalIncoterm   = document.getElementById("ocr-global-incoterm")?.value || null;
    const globalQuoteDate  = document.getElementById("ocr-global-quote-date")?.value || null;
    const globalValidUntil = document.getElementById("ocr-global-valid-until")?.value || null;
    rows.forEach(r => {
      r.price_type  = globalPriceType;
      r.incoterm    = globalIncoterm || r.incoterm || null;
      r.quote_date  = globalQuoteDate || r.quote_date || null;
      r.valid_until = globalValidUntil || r.valid_until || null;
    });

    // Duplicate check
    const dupes = _checkDuplicates(rows);
    if (dupes.length && !(await _confirmDuplicates(dupes))) return;

    spinner(true);
    try {
      const res = await apiFetch("/api/import/ocr/confirm", {
        method:"POST", headers:{"Content-Type":"application/json"},
        body: JSON.stringify({rows, supplier_override: supplierOverride, source_file: _addOcrSourceFile}),
      });
      const data = await res.json();
      toast(`Zapisano ${data.saved} wycen${data.errors.length?`, błędów: ${data.errors.length}`:""}`, "success");
      addOcrClear();
      loadPricelist("sub");
      loadPricelist("other");
    } catch(e) {
      toast("Błąd zapisu: " + e.message, "danger");
    } finally { spinner(false); }
  }

  // ── OCR / AI Import ───────────────────────────────────────────────────────

  let _ocrFile = null;
  let _ocrRows = [];
  let _ocrKeyModal = null;

  function _ocrInit() {
    if (!_ocrKeyModal) {
      _ocrKeyModal = new bootstrap.Modal(document.getElementById("openaiKeyModal"));
    }
    // Check if key is configured
    fetch("/api/config/openai-status").then(r => r.json()).then(d => {
      const warn = document.getElementById("ocr-key-warning");
      if (warn) warn.style.display = d.configured ? "none" : "";
    }).catch(() => {});
  }

  function ocrShowKeyModal() {
    if (!_ocrKeyModal) _ocrKeyModal = new bootstrap.Modal(document.getElementById("openaiKeyModal"));
    // Refresh status badges in modal
    fetch("/api/config/openai-status").then(r => r.json()).then(d => {
      const ok   = '<span class="badge bg-success"><i class="bi bi-check-circle me-1"></i>Skonfigurowany</span>';
      const miss = '<span class="badge bg-secondary"><i class="bi bi-dash me-1"></i>Brak</span>';
      const grb = document.getElementById("groq-status-badge");
      const gb  = document.getElementById("gemini-status-badge");
      const ob  = document.getElementById("openai-status-badge");
      if (grb) grb.innerHTML = d.has_groq   ? ok : miss;
      if (gb)  gb.innerHTML  = d.has_gemini  ? ok : miss;
      if (ob)  ob.innerHTML  = d.has_openai  ? ok : miss;
    }).catch(() => {});
    _ocrKeyModal.show();
  }

  async function ocrSaveGroqKey() {
    const key = document.getElementById("groq-key-input").value.trim();
    if (!key) { toast("Wpisz klucz Groq (gsk_...)", "warning"); return; }
    try {
      await apiFetch("/api/config/groq", {
        method: "POST",
        headers: {"Content-Type":"application/json"},
        body: JSON.stringify({groq_key: key}),
      }).then(r => r.json());
      _addOcrKeyOk = true;
      ["ocr-key-warning", "add-ocr-key-warning"].forEach(id => {
        const el = document.getElementById(id);
        if (el) el.style.display = "none";
      });
      const grb = document.getElementById("groq-status-badge");
      if (grb) grb.innerHTML = '<span class="badge bg-success"><i class="bi bi-check-circle me-1"></i>Skonfigurowany</span>';
      toast("Klucz Groq zapisany — możesz analizować pliki!", "success");
      if (_ocrKeyModal) _ocrKeyModal.hide();
    } catch(e) { toast("Błąd: " + e.message, "danger"); }
  }

  async function ocrSaveGeminiKey() {
    const key = document.getElementById("gemini-key-input").value.trim();
    if (!key) { toast("Wpisz klucz Gemini (AIza...)", "warning"); return; }
    try {
      await apiFetch("/api/config/gemini", {
        method: "POST",
        headers: {"Content-Type":"application/json"},
        body: JSON.stringify({gemini_key: key}),
      }).then(r => r.json());
      _addOcrKeyOk = true;
      // Hide warnings
      ["ocr-key-warning", "add-ocr-key-warning"].forEach(id => {
        const el = document.getElementById(id);
        if (el) el.style.display = "none";
      });
      // Update badge
      const gb = document.getElementById("gemini-status-badge");
      if (gb) gb.innerHTML = '<span class="badge bg-success"><i class="bi bi-check-circle me-1"></i>Skonfigurowany</span>';
      toast("Klucz Gemini zapisany — możesz analizować pliki!", "success");
      if (_ocrKeyModal) _ocrKeyModal.hide();
    } catch(e) { toast("Błąd: " + e.message, "danger"); }
  }

  async function ocrSaveKey() {
    const key = document.getElementById("openai-key-input").value.trim();
    if (!key) { toast("Wpisz klucz OpenAI (sk-...)", "warning"); return; }
    try {
      await apiFetch("/api/config/openai", {
        method: "POST",
        headers: {"Content-Type":"application/json"},
        body: JSON.stringify({openai_key: key}),
      }).then(r => r.json());
      _addOcrKeyOk = true;
      ["ocr-key-warning", "add-ocr-key-warning"].forEach(id => {
        const el = document.getElementById(id);
        if (el) el.style.display = "none";
      });
      toast("Klucz OpenAI zapisany", "success");
      if (_ocrKeyModal) _ocrKeyModal.hide();
    } catch(e) { toast("Błąd: " + e.message, "danger"); }
  }

  function ocrDrop(e) {
    e.preventDefault();
    document.getElementById("ocr-dropzone").style.background = "";
    const file = e.dataTransfer?.files?.[0];
    if (file) _ocrSetFile(file);
  }

  function ocrFileSelected(input) {
    if (input.files?.[0]) _ocrSetFile(input.files[0]);
  }

  function _ocrSetFile(file) {
    _ocrFile = file;
    document.getElementById("ocr-file-name").textContent = file.name;
    document.getElementById("ocr-file-size").textContent = _fmtSize(file.size);
    document.getElementById("ocr-file-info").classList.remove("d-none");
    document.getElementById("ocr-analyze-btn").disabled = false;

    // Show image preview for image files
    const imgTypes = ["image/png","image/jpeg","image/gif","image/webp","image/bmp"];
    const prevWrap = document.getElementById("ocr-img-preview");
    if (imgTypes.includes(file.type)) {
      const reader = new FileReader();
      reader.onload = e => {
        document.getElementById("ocr-preview-img").src = e.target.result;
        prevWrap.classList.remove("d-none");
      };
      reader.readAsDataURL(file);
    } else {
      prevWrap.classList.add("d-none");
    }
  }

  function _fmtSize(bytes) {
    if (bytes < 1024) return bytes + " B";
    if (bytes < 1024*1024) return (bytes/1024).toFixed(1) + " KB";
    return (bytes/1024/1024).toFixed(1) + " MB";
  }

  function ocrClearFile() {
    _ocrFile = null;
    _ocrRows = [];
    document.getElementById("ocr-file-input").value = "";
    document.getElementById("ocr-file-info").classList.add("d-none");
    document.getElementById("ocr-img-preview").classList.add("d-none");
    document.getElementById("ocr-analyze-btn").disabled = true;
    document.getElementById("ocr-import-btn").style.display = "none";
    document.getElementById("ocr-select-all-btn").style.display = "none";
    document.getElementById("ocr-count-badge").style.display = "none";
    document.getElementById("ocr-results-wrap").innerHTML = `
      <div class="text-center text-muted py-5">
        <i class="bi bi-stars fs-1 d-block mb-3 opacity-25"></i>
        <p>Wgraj plik i kliknij <strong>Analizuj</strong></p>
      </div>`;
  }

  async function ocrAnalyze() {
    if (!_ocrFile) return;
    const progress = document.getElementById("ocr-progress");
    const msgEl   = document.getElementById("ocr-progress-msg");
    const btn     = document.getElementById("ocr-analyze-btn");
    progress.style.display = "";
    btn.disabled = true;
    msgEl.textContent = "Wysyłam do GPT-4o…";

    const form = new FormData();
    form.append("file", _ocrFile);
    try {
      const res = await fetch("/api/import/ocr", {method:"POST", body: form});
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.detail || `HTTP ${res.status}`);
      }
      const data = await res.json();
      _ocrRows = data.rows || [];
      msgEl.textContent = `Gotowe — wyodrębniono ${_ocrRows.length} pozycji`;
      _ocrRenderResults(_ocrRows);
    } catch(e) {
      progress.style.display = "none";
      btn.disabled = false;
      if (e.message.includes("Brak klucza")) {
        ocrShowKeyModal();
      } else {
        toast("Błąd OCR: " + e.message, "danger");
      }
    } finally {
      setTimeout(() => { progress.style.display = "none"; btn.disabled = false; }, 1500);
    }
  }

  function _ocrRenderResults(rows) {
    const wrap  = document.getElementById("ocr-results-wrap");
    const badge = document.getElementById("ocr-count-badge");
    const impBtn = document.getElementById("ocr-import-btn");
    const selBtn = document.getElementById("ocr-select-all-btn");

    badge.textContent = `${rows.length} pozycji`;
    badge.style.display = rows.length ? "" : "none";
    impBtn.style.display = rows.length ? "" : "none";
    selBtn.style.display = rows.length ? "" : "none";

    if (!rows.length) {
      wrap.innerHTML = `<div class="alert alert-warning m-3">
        <i class="bi bi-exclamation-circle me-2"></i>
        Nie znaleziono żadnych pozycji cenowych. Spróbuj z innym plikiem lub sprawdź jego jakość.
      </div>`;
      return;
    }

    const catLabel = {substancja_czynna:"Substancja", opakowanie:"Opakowanie", kapsula:"Kapsułka"};
    const catColor = {substancja_czynna:"primary", opakowanie:"success", kapsula:"warning"};

    wrap.innerHTML = `
      <div class="table-responsive">
        <table class="table table-sm table-hover align-middle" style="font-size:.83rem">
          <thead>
            <tr style="background:#2c3e50;color:#fff">
              <th style="width:3%">
                <input type="checkbox" class="form-check-input" id="ocr-chk-all"
                  onchange="App.ocrToggleAll(this.checked)">
              </th>
              <th>Produkt</th>
              <th>Dostawca</th>
              <th class="text-end">Cena</th>
              <th class="text-center">Waluta</th>
              <th class="text-end">Ilość</th>
              <th>Jedn.</th>
              <th>Kategoria</th>
              <th>Uwagi</th>
            </tr>
          </thead>
          <tbody>
            ${rows.map((r, i) => `
              <tr>
                <td><input type="checkbox" class="form-check-input ocr-row-chk" checked data-idx="${i}"></td>
                <td>
                  <input type="text" class="form-control form-control-sm border-0 p-0 fw-semibold"
                    value="${escHtml(r.product_name)}" style="background:transparent"
                    onchange="_ocrUpdateRow(${i},'product_name',this.value)">
                </td>
                <td>
                  <input type="text" class="form-control form-control-sm border-0 p-0 text-muted"
                    value="${escHtml(r.supplier||'')}" placeholder="—" style="background:transparent;width:110px"
                    onchange="_ocrUpdateRow(${i},'supplier',this.value)">
                </td>
                <td class="text-end">
                  <input type="number" class="form-control form-control-sm border-0 p-0 text-end fw-semibold text-success"
                    value="${r.price_original}" step="any" style="background:transparent;width:80px"
                    onchange="_ocrUpdateRow(${i},'price_original',parseFloat(this.value))">
                </td>
                <td class="text-center">
                  <select class="form-select form-select-sm border-0 p-0" style="background:transparent;width:70px"
                    onchange="_ocrUpdateRow(${i},'currency',this.value)">
                    ${["PLN","EUR","USD"].map(c =>
                      `<option ${r.currency===c?"selected":""}>${c}</option>`).join("")}
                  </select>
                </td>
                <td class="text-end">
                  <input type="number" class="form-control form-control-sm border-0 p-0 text-end"
                    value="${r.quantity}" step="any" style="background:transparent;width:60px"
                    onchange="_ocrUpdateRow(${i},'quantity',parseFloat(this.value))">
                </td>
                <td>
                  <input type="text" class="form-control form-control-sm border-0 p-0"
                    value="${escHtml(r.unit||'kg')}" style="background:transparent;width:45px"
                    onchange="_ocrUpdateRow(${i},'unit',this.value)">
                </td>
                <td>
                  <select class="form-select form-select-sm border-0 p-0" style="background:transparent;width:100px"
                    onchange="_ocrUpdateRow(${i},'category',this.value)">
                    ${Object.entries(catLabel).map(([v,l]) =>
                      `<option value="${v}" ${r.category===v?"selected":""}>${l}</option>`).join("")}
                  </select>
                </td>
                <td class="text-muted small">${escHtml(r.notes||"")}</td>
              </tr>`).join("")}
          </tbody>
        </table>
      </div>`;
  }

  // exposed to inline onchange
  window._ocrUpdateRow = function(idx, field, value) {
    if (_ocrRows[idx]) _ocrRows[idx][field] = value;
  };

  function ocrToggleAll(checked) {
    document.querySelectorAll(".ocr-row-chk").forEach(cb => cb.checked = checked);
  }

  function ocrSelectAll() {
    const allChk = document.getElementById("ocr-chk-all");
    if (allChk) allChk.checked = true;
    ocrToggleAll(true);
  }

  async function ocrConfirm() {
    const checked = [...document.querySelectorAll(".ocr-row-chk:checked")]
      .map(cb => parseInt(cb.dataset.idx));
    if (!checked.length) { toast("Zaznacz przynajmniej jedną pozycję", "warning"); return; }

    const rows = checked.map(i => _ocrRows[i]);
    const supplierOverride = document.getElementById("ocr-supplier")?.value.trim() || null;

    spinner(true);
    try {
      const res = await apiFetch("/api/import/ocr/confirm", {
        method: "POST",
        headers: {"Content-Type":"application/json"},
        body: JSON.stringify({rows, supplier_override: supplierOverride}),
      });
      const data = await res.json();
      toast(`Zaimportowano ${data.saved} wycen${data.errors.length ? `, błędów: ${data.errors.length}` : ""}`, "success");
      if (data.errors.length) {
        console.warn("OCR import errors:", data.errors);
      }
      ocrClearFile();
    } catch(e) {
      toast("Błąd importu: " + e.message, "danger");
    } finally { spinner(false); }
  }

  // ── Public API ────────────────────────────────────────────────
  return {
    refreshRates,
    loadDashboard,
    dashSelectProduct,
    dashQuickOrder,
    ordSuggest,
    ordSelect,
    runOrder,
    loadQuotations,
    clearFilters,
    requestDelete,
    onCurrencyChange,
    submitAddForm,
    previewImport,
    confirmImport,
    nativePreview,
    nativeConfirm,
    exportExcel,
    loadSummary,
    loadTreomag,
    // pricelist
    loadPricelist,
    plFilter,
    plSetCat,
    plClearFilters,
    plExport,
    _plToggle,
    plEditNotes,
    _plSaveNotes,
    _plCancelNotes,
    plDeleteOffer,
    // mapping importer
    mapDetect,
    mapPreview,
    mapExportTemplate,
    mapImport,
    _mapUpdate,
    // legacy calc still works if bookmarked
    calcSuggest: ordSuggest,
    calcSelect: ordSelect,
    runCalc: runOrder,
    _toast: toast,
    // Dodaj wycenę OCR
    addOcrDrop,
    addOcrFileSelected,
    addOcrClear,
    addOcrAnalyze,
    _addOcrRemoveFile,
    addOcrToggleAll,
    addOcrSelectAll,
    addOcrConfirm,
    // Paste text mode
    pasteTextChanged,
    pasteTextClear,
    addOcrAnalyzeText,
    pasteTextToggleAll,
    pasteTextSave,
    // OCR
    ocrShowKeyModal,
    ocrSaveKey,
    ocrSaveGeminiKey,
    ocrSaveGroqKey,
    ocrDrop,
    ocrFileSelected,
    ocrClearFile,
    ocrAnalyze,
    ocrToggleAll,
    ocrSelectAll,
    ocrConfirm,
    // suppliers
    supFilter,
    supSelect,
    supSelectContact,
    supToggleProduct,
    supOpenOrder,
    supSendOrder,
    saveSmtpConfig,
    openSmtpModal,
    previewFile,
    // Inbox
    inboxCheck,
    inboxTestConnection,
    inboxSetFilter,
    inboxOpen,
    inboxConfirm,
    inboxReject,
    inboxCheckAll,
    inboxRejectDirect,
  };

  async function _initSuppliers() {
    if (_orderModal) return;
    _orderModal = new bootstrap.Modal(document.getElementById("orderModal"));
    _smtpModal  = new bootstrap.Modal(document.getElementById("smtpModal"));
    const listEl = document.getElementById("sup-list");
    listEl.innerHTML = `<div class="text-center py-4"><div class="spinner-border spinner-border-sm text-success"></div></div>`;
    try {
      _suppliers = await apiFetch("/api/suppliers").then(r => r.json());
      _renderSupList(_suppliers);
    } catch(e) {
      listEl.innerHTML = `<div class="alert alert-danger m-2 small">Błąd: ${escHtml(e.message)}</div>`;
    }
  }

  function _renderSupList(list) {
    const el = document.getElementById("sup-list");
    if (!list.length) {
      el.innerHTML = `<p class="text-muted text-center p-3 small">Brak wyników</p>`;
      return;
    }
    const catIcons = {substancja_czynna:"capsule", opakowanie:"box-seam", kapsula:"circle"};
    el.innerHTML = list.map(s => {
      const badges = s.categories.map(c =>
        `<i class="bi bi-${catIcons[c]||"tag"}" title="${c}" style="font-size:.75rem;color:#6c757d"></i>`
      ).join(" ");
      const isActive = _supSelected === s.name;
      return `<div class="sup-item d-flex align-items-center gap-2 px-3 py-2 border-bottom ${isActive ? "active" : ""}"
          style="cursor:pointer" onclick="App.supSelect('${escHtml(s.name).replace(/'/g,"\\'")}')">
        <div class="flex-grow-1 min-w-0">
          <div class="fw-semibold text-truncate" style="font-size:.88rem">${escHtml(s.name)}</div>
          <div class="d-flex align-items-center gap-1 mt-1">${badges}
            <span class="text-muted" style="font-size:.78rem">${s.product_count} ofert</span>
          </div>
        </div>
        <i class="bi bi-chevron-right text-muted flex-shrink-0" style="font-size:.8rem"></i>
      </div>`;
    }).join("");
  }

  function supFilter() {
    const q = document.getElementById("sup-search").value.toLowerCase();
    _renderSupList(q ? _suppliers.filter(s => s.name.toLowerCase().includes(q)) : _suppliers);
  }

  async function supSelect(name) {
    _supSelected = name;
    _supChecked = new Set();
    _supSelectedContact = null;
    // highlight in list
    document.querySelectorAll(".sup-item").forEach(el => el.classList.remove("active","bg-white"));
    document.querySelectorAll(".sup-item").forEach(el => {
      if (el.textContent.includes(name)) el.classList.add("active");
    });

    const detail = document.getElementById("sup-detail");
    detail.innerHTML = `<div class="text-center py-5"><div class="spinner-border text-success"></div><div class="small text-muted mt-2">Ładowanie…</div></div>`;

    const [offers, pdData] = await Promise.all([
      apiFetch(`/api/suppliers/${encodeURIComponent(name)}/offers`).then(r => r.json()).catch(() => []),
      apiFetch(`/api/suppliers/${encodeURIComponent(name)}/pipedrive`).then(r => r.json()).catch(() => ({found: false})),
    ]);
    _supOffers = Array.isArray(offers) ? offers : [];
    _supPipedrive = pdData;
    _renderSupDetail(name, _supOffers, pdData);
  }

  function _renderSupDetail(name, offers, pd) {
    const el = document.getElementById("sup-detail");

    // Pipedrive card
    let pdHtml = "";
    if (pd && pd.found) {
      const persons = pd.persons || [];
      const externalPersons = persons.filter(p => !p.internal);
      const hasExternal = externalPersons.length > 0;

      // Build selectable contact rows (radio buttons)
      const personRows = persons.map((p, idx) => {
        const isInternal = p.internal === true;
        const radioId = `sup-contact-${idx}`;
        const isFirst = idx === 0;
        const badge = isInternal
          ? `<span class="badge bg-warning text-dark" style="font-size:.62rem">wewnętrzny</span>`
          : "";
        const emailLink = p.email
          ? `<span class="d-inline-flex align-items-center gap-1">
               <a href="mailto:${escHtml(p.email)}" class="text-decoration-none small text-primary" onclick="event.stopPropagation()">
                 <i class="bi bi-envelope-fill me-1"></i>${escHtml(p.email)}
               </a>
               <button class="btn btn-link btn-sm p-0 text-muted" style="font-size:.7rem" title="Kopiuj email"
                 onclick="event.stopPropagation();navigator.clipboard.writeText('${escHtml(p.email)}').then(()=>App._toast('Skopiowano email','success'))">
                 <i class="bi bi-copy"></i>
               </button>
             </span>`
          : `<span class="text-muted small fst-italic">brak e-mail</span>`;
        const phoneLink = p.phone
          ? `<a href="tel:${escHtml(p.phone)}" class="text-decoration-none small text-success ms-2" onclick="event.stopPropagation()">
               <i class="bi bi-telephone-fill me-1"></i>${escHtml(p.phone)}
             </a>`
          : "";
        const titleTxt = p.title ? `<span class="text-muted small fst-italic d-block">${escHtml(p.title)}</span>` : "";

        return `<label for="${radioId}" class="d-flex align-items-start gap-2 px-3 py-2 border-bottom sup-contact-row
            ${isInternal ? "bg-warning bg-opacity-10" : ""}"
            style="cursor:pointer;transition:background .15s"
            onmouseover="this.style.background='${isInternal ? "#fff8e1" : "#f0f7ff"}'"
            onmouseout="this.style.background='${isInternal ? "#fffde7" : ""}'"
          >
          <input type="radio" class="form-check-input mt-1 flex-shrink-0" name="sup-contact-radio"
            id="${radioId}" value="${idx}"
            ${!isInternal && isFirst ? "checked" : (isInternal && idx === 0 ? "checked" : "")}
            onchange="App.supSelectContact(${idx})">
          <i class="bi bi-person-circle ${isInternal ? "text-warning" : "text-primary"} fs-5 flex-shrink-0 mt-1"></i>
          <div class="flex-grow-1 min-w-0">
            <div class="d-flex align-items-center gap-2 flex-wrap">
              <span class="fw-semibold">${escHtml(p.name || "—")}</span>
              ${badge}
            </div>
            ${titleTxt}
            <div class="d-flex flex-wrap align-items-center gap-1 mt-1">
              ${emailLink}${phoneLink}
            </div>
          </div>
        </label>`;
      }).join("");

      // Set initial selected contact
      const firstExternal = externalPersons[0] || persons[0];
      if (firstExternal) {
        _supSelectedContact = firstExternal;
      }

      pdHtml = `<div class="card mb-3 border-success">
        <div class="card-header py-2 d-flex align-items-center gap-2" style="background:#e8f5e9">
          <i class="bi bi-diagram-3 text-success"></i>
          <strong class="me-1">Pipedrive CRM</strong>
          <span class="badge bg-success" style="font-size:.68rem">${escHtml(pd.name)}</span>
          ${pd.address ? `<span class="ms-auto small text-muted"><i class="bi bi-geo-alt me-1"></i>${escHtml(pd.address)}</span>` : ""}
        </div>
        <div class="card-body p-0">
          ${personRows || `<div class="text-muted small p-3">
            <i class="bi bi-exclamation-circle me-1"></i>
            Brak kontaktów w Pipedrive.
            <a href="https://provitax.pipedrive.com/organizations" target="_blank" class="ms-1">Dodaj kontakt →</a>
          </div>`}
        </div>
      </div>`;
    } else {
      pdHtml = `<div class="alert alert-light py-2 small mb-3">
        <i class="bi bi-info-circle me-1"></i>
        Nie znaleziono w Pipedrive.
        <a href="#" onclick="App.openSmtpModal();return false" class="ms-1">Skonfiguruj Pipedrive →</a>
      </div>`;
    }

    // Group offers by product
    const byProduct = {};
    offers.forEach(o => {
      if (!byProduct[o.product_name]) byProduct[o.product_name] = [];
      byProduct[o.product_name].push(o);
    });

    const catLabel = {substancja_czynna:"Substancja czynna", opakowanie:"Opakowanie", kapsula:"Kapsułka"};

    let tableRows = Object.entries(byProduct).map(([pname, rows]) => {
      const best = [...rows].sort((a,b) => a.price_per_unit_pln - b.price_per_unit_pln)[0];
      return rows.map((o, i) => {
        const id = `schk-${o.id}`;
        const eff = o.moq || o.quantity;
        return `<tr>
          ${i === 0 ? `<td class="ps-2" rowspan="${rows.length}" style="vertical-align:middle">
            <input type="checkbox" class="form-check-input" id="${id}"
              onchange="App.supToggleProduct(${o.id})" style="width:1.1rem;height:1.1rem">
          </td>` : ""}
          ${i === 0 ? `<td class="fw-semibold" rowspan="${rows.length}" style="vertical-align:middle">${escHtml(pname)}</td>` : ""}
          ${i === 0 ? `<td class="small text-muted" rowspan="${rows.length}" style="vertical-align:middle">${catLabel[best.category]||best.category}</td>` : ""}
          <td class="text-end">${fmt(o.quantity,0)} ${escHtml(o.unit)}</td>
          <td class="text-end fw-semibold text-success">${fmt(o.price_per_unit_pln,4)}</td>
          <td class="text-end text-muted small">${fmt(o.price_original,2)} ${escHtml(o.currency)}</td>
          <td class="small text-muted">${eff > 1 ? fmt(eff,0)+" "+escHtml(o.unit) : "brak"}</td>
          <td class="small text-muted">${o.incoterm ? `<span class="badge ${_incotermBadgeCls(o.incoterm)}">${escHtml(o.incoterm)}</span>` : "—"}</td>
          <td class="small text-muted">${o.notes ? escHtml(o.notes.slice(0,40)) : "—"}</td>
        </tr>`;
      }).join("");
    }).join("");

    el.innerHTML = `
      <div class="d-flex align-items-center gap-2 mb-3 flex-wrap">
        <h5 class="mb-0 fw-bold">${escHtml(name)}</h5>
        <span class="badge bg-secondary">${offers.length} ofert</span>
        <div class="ms-auto d-flex gap-2">
          <button class="btn btn-sm btn-outline-secondary" onclick="App.openSmtpModal()">
            <i class="bi bi-gear me-1"></i>Ustawienia
          </button>
          <button class="btn btn-sm btn-success" onclick="App.supOpenOrder()">
            <i class="bi bi-send me-1"></i>Wyślij zamówienie
          </button>
        </div>
      </div>

      ${pdHtml}

      <div class="table-responsive">
        <table class="table table-sm table-hover align-middle mb-0" style="font-size:.84rem">
          <thead>
            <tr style="background:#2c3e50;color:#fff">
              <th style="width:3%"></th>
              <th style="width:28%">Produkt</th>
              <th style="width:12%">Kategoria</th>
              <th style="width:8%" class="text-end">Ilość</th>
              <th style="width:11%" class="text-end">PLN/jedn.</th>
              <th style="width:10%" class="text-end">Cena oryg.</th>
              <th style="width:8%">MOQ</th>
              <th style="width:8%" class="text-center">Incoterm</th>
              <th>Uwagi</th>
            </tr>
          </thead>
          <tbody>${tableRows}</tbody>
        </table>
      </div>
      <div id="sup-selection-bar" class="mt-3" style="display:none">
        <div class="alert alert-success d-flex align-items-center gap-2 py-2">
          <i class="bi bi-check2-square fs-5"></i>
          <span>Wybrano: <strong id="sup-sel-count">0</strong> produktów</span>
          <button class="btn btn-success btn-sm ms-auto" onclick="App.supOpenOrder()">
            <i class="bi bi-send me-1"></i>Wyślij zamówienie
          </button>
        </div>
      </div>`;
  }

  function supSelectContact(idx) {
    const persons = _supPipedrive?.persons || [];
    _supSelectedContact = persons[idx] || null;
  }

  function supToggleProduct(offerId) {
    if (_supChecked.has(offerId)) _supChecked.delete(offerId);
    else _supChecked.add(offerId);
    const bar = document.getElementById("sup-selection-bar");
    const cnt = document.getElementById("sup-sel-count");
    if (bar) {
      bar.style.display = _supChecked.size > 0 ? "" : "none";
      if (cnt) cnt.textContent = _supChecked.size;
    }
  }

  function supOpenOrder() {
    if (!_supSelected) { toast("Wybierz dostawcę", "warning"); return; }
    const selected = _supChecked.size > 0
      ? _supOffers.filter(o => _supChecked.has(o.id))
      : _supOffers;

    if (!selected.length) { toast("Brak wybranych produktów", "warning"); return; }

    const toInput = document.getElementById("ord-to");
    const hintsEl = document.getElementById("ord-to-hints");
    const contact = _supSelectedContact && !_supSelectedContact.internal
      ? _supSelectedContact
      : (_supPipedrive?.persons || []).find(p => !p.internal && p.email) || null;

    if (contact) {
      toInput.value = contact.email || "";
      const nameInfo = contact.name ? `<i class="bi bi-person me-1"></i>${escHtml(contact.name)}` : "";
      hintsEl.innerHTML = nameInfo
        ? `<span class="text-success">${nameInfo}</span> — wybrany kontakt z Pipedrive`
        : "";
    } else {
      toInput.value = "";
      hintsEl.innerHTML = `<span class="text-muted">Wybierz osobę kontaktową w karcie dostawcy</span>`;
    }

    // Product preview
    const preview = document.getElementById("ord-products-preview");
    preview.innerHTML = selected.map(o =>
      `<div class="d-flex gap-2 py-1 border-bottom">
        <span class="fw-semibold flex-grow-1">${escHtml(o.product_name)}</span>
        <span class="text-muted">${fmt(o.quantity,0)} ${escHtml(o.unit)}</span>
        <span class="text-success fw-semibold">${fmt(o.price_per_unit_pln,4)} PLN/jedn.</span>
      </div>`
    ).join("");

    // Qty inputs
    const qtyWrap = document.getElementById("ord-qty-inputs");
    qtyWrap.innerHTML = selected.map(o =>
      `<div class="d-flex align-items-center gap-2 mb-2">
        <span class="flex-grow-1 small">${escHtml(o.product_name)}</span>
        <input type="number" class="form-control form-control-sm" style="width:90px"
          id="oqty-${o.id}" placeholder="ilość" min="0" step="any">
        <span class="small text-muted">${escHtml(o.unit)}</span>
      </div>`
    ).join("");

    // Default message
    const names = selected.map(o => `- ${o.product_name} (${fmt(o.quantity,0)} ${o.unit})`).join("\n");
    document.getElementById("ord-message").value =
      `Dzień dobry,\n\nZwracamy się z prośbą o potwierdzenie dostępności i warunków dostawy dla następujących produktów:\n\n${names}\n\nProsimy o potwierdzenie cen, terminów realizacji oraz warunków płatności.\n\nZ poważaniem`;

    document.getElementById("ord-subject").value = `Zapytanie ofertowe — ${_supSelected}`;
    _orderModal.show();
  }

  async function supSendOrder() {
    const to      = document.getElementById("ord-to").value.trim();
    const subject = document.getElementById("ord-subject").value.trim();
    const message = document.getElementById("ord-message").value.trim();
    if (!to) { toast("Podaj adres e-mail odbiorcy", "warning"); return; }

    const selected = _supChecked.size > 0
      ? _supOffers.filter(o => _supChecked.has(o.id))
      : _supOffers;

    const products = selected.map(o => ({
      ...o,
      order_qty: parseFloat(document.getElementById(`oqty-${o.id}`)?.value || o.quantity),
    }));

    spinner(true);
    try {
      await apiFetch("/api/suppliers/send-order", {
        method: "POST",
        headers: {"Content-Type":"application/json"},
        body: JSON.stringify({ supplier: _supSelected, to_email: to, subject, message, products }),
      });
      _orderModal.hide();
      toast(`E-mail wysłany do ${to}`, "success");
    } catch(e) {
      toast("Błąd wysyłki: " + e.message, "danger");
    } finally { spinner(false); }
  }

  let _previewModal = null;

  function previewFile(encodedFilename) {
    const filename = decodeURIComponent(encodedFilename);
    const url = `/api/uploads/${encodedFilename}`;
    const ext = filename.split(".").pop().toLowerCase();

    const body  = document.getElementById("preview-body");
    const title = document.getElementById("preview-filename");
    const dlBtn = document.getElementById("preview-download-btn");

    title.textContent = filename;
    dlBtn.href = url;
    dlBtn.download = filename;

    // Render preview based on file type
    if (["png","jpg","jpeg","webp","gif","bmp"].includes(ext)) {
      body.innerHTML = `<div class="text-center p-3">
        <img src="${url}" class="img-fluid rounded" style="max-height:75vh;object-fit:contain"
          alt="${escHtml(filename)}" onerror="this.outerHTML='<div class=\'p-4 text-danger\'>Nie można załadować obrazu.</div>'">
      </div>`;
    } else if (ext === "pdf") {
      body.innerHTML = `<iframe src="${url}" style="width:100%;height:78vh;border:none"></iframe>`;
    } else if (["xlsx","xls","csv","txt","docx","doc"].includes(ext)) {
      body.innerHTML = `<div class="d-flex flex-column align-items-center justify-content-center py-5 gap-3">
        <i class="bi bi-file-earmark-text text-muted" style="font-size:4rem"></i>
        <div class="text-muted">Podgląd niedostępny dla tego formatu</div>
        <a href="${url}" download="${escHtml(filename)}" class="btn btn-primary">
          <i class="bi bi-download me-2"></i>Pobierz plik
        </a>
      </div>`;
    } else {
      body.innerHTML = `<div class="d-flex flex-column align-items-center justify-content-center py-5 gap-3">
        <i class="bi bi-file-earmark text-muted" style="font-size:4rem"></i>
        <a href="${url}" download="${escHtml(filename)}" class="btn btn-primary">
          <i class="bi bi-download me-2"></i>Pobierz plik
        </a>
      </div>`;
    }

    if (!_previewModal) _previewModal = new bootstrap.Modal(document.getElementById("filePreviewModal"));
    _previewModal.show();
  }

  function openSmtpModal() {
    if (!_smtpModal) _smtpModal = new bootstrap.Modal(document.getElementById("smtpModal"));
    _smtpModal.show();
  }

  async function saveSmtpConfig() {
    const cfg = {
      smtp_host: document.getElementById("cfg-smtp-host").value,
      smtp_port: document.getElementById("cfg-smtp-port").value,
      smtp_user: document.getElementById("cfg-smtp-user").value,
      smtp_pass: document.getElementById("cfg-smtp-pass").value,
      pd_token:  document.getElementById("cfg-pd-token").value,
      pd_domain: document.getElementById("cfg-pd-domain").value,
    };
    try {
      await apiFetch("/api/config/smtp", {
        method: "POST",
        headers: {"Content-Type":"application/json"},
        body: JSON.stringify(cfg),
      });
      _smtpModal.hide();
      toast("Ustawienia zapisane", "success");
    } catch(e) { toast("Błąd zapisu: " + e.message, "danger"); }
  }

  // ── Inbox (Skrzynka wycen) ─────────────────────────────────────────────────

  function _getInboxModal() {
    if (!_inboxModal)
      _inboxModal = new bootstrap.Modal(document.getElementById("inboxReviewModal"));
    return _inboxModal;
  }

  async function _initInbox() {
    // Update badge and status
    try {
      const st = await apiFetch("/api/inbox/status").then(r => r.json());
      const info = document.getElementById("inbox-imap-info");
      if (info) {
        info.textContent = st.configured
          ? `${st.user} → ${st.folder}`
          : "Brak konfiguracji IMAP";
      }
    } catch(e) {}
    await _loadInbox();
  }

  async function _loadInbox() {
    try {
      _inboxAll = await apiFetch("/api/inbox").then(r => r.json());
      _renderInbox();
      _updateInboxBadge();
    } catch(e) {}
  }

  function _updateInboxBadge() {
    const badge = document.getElementById("inbox-badge");
    if (!badge) return;
    const pending = _inboxAll.filter(e => e.status === "pending").length;
    badge.textContent = pending;
    badge.style.display = pending > 0 ? "" : "none";
  }

  function inboxSetFilter(filter, btn) {
    _inboxFilter = filter;
    document.querySelectorAll("#inbox-filter-btns .btn").forEach(b => {
      b.classList.toggle("active", b === btn);
    });
    _renderInbox();
  }

  function _renderInbox() {
    const list = document.getElementById("inbox-list");
    const empty = document.getElementById("inbox-empty");
    if (!list) return;

    let items = _inboxAll;
    if (_inboxFilter === "active")
      items = items.filter(e => ["new","pending","error"].includes(e.status));
    else if (_inboxFilter !== "all")
      items = items.filter(e => e.status === _inboxFilter);

    if (items.length === 0) {
      list.innerHTML = "";
      if (empty) empty.style.display = "";
      return;
    }
    if (empty) empty.style.display = "none";

    list.innerHTML = items.map(e => {
      const rows = Array.isArray(e.extracted_rows) ? e.extracted_rows : [];
      const atts = Array.isArray(e.attachments) ? e.attachments : [];
      const qCount = e.quotation_count || 0;
      const inDb = qCount > 0;

      const statusClass = {new:"primary", pending:"warning", confirmed:"success", rejected:"secondary", empty:"info", error:"danger"}[e.status] || "secondary";
      const statusLabel = {new:"Nowy", pending:"Do sprawdzenia", confirmed:"Potwierdzone", rejected:"Odrzucone", empty:"Bez wycen", error:"Błąd"}[e.status] || e.status;
      const date = e.received_at ? new Date(e.received_at).toLocaleString("pl-PL") : "—";

      const preview = rows.slice(0,3).map(r =>
        `<span class="badge bg-light text-dark border me-1">${escHtml(r.product_name||"")} ${escHtml(String(r.price_original||""))} ${escHtml(r.currency||"")}</span>`
      ).join("") + (rows.length > 3 ? `<span class="text-muted small">+${rows.length-3} więcej</span>` : "");

      const dbBadge = inDb
        ? `<span class="badge bg-success bg-opacity-75 ms-1" title="${qCount} wycen zapisanych w bazie">
             <i class="bi bi-check2-circle me-1"></i>W bazie (${qCount})
           </span>`
        : "";

      return `<div class="card mb-2 border-${statusClass}${inDb ? ' border-opacity-50' : ''}">
        <div class="card-body py-2 px-3${inDb ? ' bg-success bg-opacity-10' : ''}">
          <div class="d-flex align-items-start gap-3 flex-wrap">
            <div class="flex-grow-1">
              <div class="d-flex align-items-center gap-2 mb-1 flex-wrap">
                <span class="badge bg-${statusClass}">${statusLabel}</span>
                ${dbBadge}
                <strong class="small">${escHtml(e.subject||"(brak tematu)")}</strong>
              </div>
              <div class="text-muted small mb-1">
                <i class="bi bi-person me-1"></i>${escHtml(e.from_addr||"")}
                <span class="ms-2"><i class="bi bi-clock me-1"></i>${date}</span>
                ${atts.length ? `<span class="ms-2"><i class="bi bi-paperclip me-1"></i>${atts.length} zał.</span>` : ""}
              </div>
              <div>${preview || '<span class="text-muted small">Brak wykrytych pozycji</span>'}</div>
              ${e.error ? `<div class="text-danger small mt-1"><i class="bi bi-exclamation-triangle me-1"></i>${escHtml(e.error.slice(0,120))}</div>` : ""}
            </div>
            <div class="d-flex flex-column gap-1 text-end" style="min-width:110px">
              ${(e.status === "pending" || e.status === "new" || e.status === "error") ? `
                <button class="btn btn-sm btn-success" onclick="App.inboxOpen(${e.id})">
                  <i class="bi bi-eye me-1"></i>Przejrzyj
                </button>
                <button class="btn btn-sm btn-outline-danger" onclick="App.inboxRejectDirect(${e.id})">
                  <i class="bi bi-x"></i> Odrzuć
                </button>
              ` : `
                <button class="btn btn-sm btn-outline-secondary" onclick="App.inboxOpen(${e.id})">
                  <i class="bi bi-eye me-1"></i>Szczegóły
                </button>
              `}
            </div>
          </div>
        </div>
      </div>`;
    }).join("");
  }

  async function inboxCheck() {
    const btn = document.querySelector('[onclick="App.inboxCheck()"]');
    if (btn) { btn.disabled = true; btn.innerHTML = '<span class="spinner-border spinner-border-sm me-1"></span>Pobieranie…'; }
    try {
      const res = await apiFetch("/api/inbox/check", {method:"POST"}).then(r => r.json());
      toast(`Pobrano ${res.fetched} maili, zapisano ${res.saved}`, res.saved > 0 ? "success" : "info");
      await _loadInbox();
    } catch(e) {
      toast("Błąd: " + e.message, "danger");
    } finally {
      if (btn) { btn.disabled = false; btn.innerHTML = '<i class="bi bi-arrow-repeat me-1"></i>Sprawdź teraz'; }
    }
  }

  async function inboxTestConnection() {
    const btn = document.querySelector('[onclick="App.inboxTestConnection()"]');
    if (btn) { btn.disabled = true; btn.innerHTML = '<span class="spinner-border spinner-border-sm me-1"></span>Test…'; }
    try {
      const res = await apiFetch("/api/inbox/test", {method:"POST"}).then(r => r.json());
      if (res.ok) {
        toast(`Połączono! Foldery: ${(res.folders||[]).join(", ")}`, "success");
      } else {
        toast("Błąd połączenia: " + (res.error||""), "danger");
      }
    } catch(e) {
      toast("Błąd: " + e.message, "danger");
    } finally {
      if (btn) { btn.disabled = false; btn.innerHTML = '<i class="bi bi-plug me-1"></i>Test połączenia'; }
    }
  }

  async function inboxOpen(id) {
    _inboxReviewId = id;
    let emailData = _inboxAll.find(e => e.id === id);
    if (!emailData) return;

    // Fill in header info immediately
    document.getElementById("irm-from").textContent = emailData.from_addr || "—";
    document.getElementById("irm-subject").textContent = emailData.subject || "—";
    document.getElementById("irm-date").textContent = emailData.received_at
      ? new Date(emailData.received_at).toLocaleString("pl-PL") : "—";
    document.getElementById("irm-body").textContent = emailData.body_text || "";
    document.getElementById("irm-supplier").value = "";
    document.getElementById("irm-error").style.display = "none";

    // Show "W bazie" badge if quotations already linked
    const qCount = emailData.quotation_count || 0;
    const badge  = document.getElementById("irm-db-badge");
    const badgeN = document.getElementById("irm-db-count");
    if (qCount > 0) {
      badgeN.textContent = qCount;
      badge.classList.remove("d-none");
    } else {
      badge.classList.add("d-none");
    }

    const tbody = document.getElementById("irm-tbody");
    const emptyEl = document.getElementById("irm-empty");
    emptyEl.style.display = "none";
    tbody.innerHTML = `<tr><td colspan="7" class="text-center py-3">
      <span class="spinner-border spinner-border-sm me-2"></span>Analizuję AI…</td></tr>`;
    _getInboxModal().show();

    // If status is 'new', run OCR analysis first
    if (emailData.status === "new" || emailData.status === "error" ||
        (Array.isArray(emailData.extracted_rows) && emailData.extracted_rows.length === 0 && emailData.status !== "empty")) {
      try {
        const res = await apiFetch(`/api/inbox/${id}/analyze`, {method:"POST"}).then(r => r.json());
        // Update local data with fresh rows
        emailData = {...emailData, extracted_rows: res.rows || [], status: res.rows?.length ? "pending" : "empty"};
        // Update in _inboxAll
        const idx = _inboxAll.findIndex(e => e.id === id);
        if (idx >= 0) _inboxAll[idx] = emailData;
      } catch(e) {
        document.getElementById("irm-error").style.display = "";
        document.getElementById("irm-error").textContent = "Błąd analizy AI: " + e.message;
      }
    }

    _inboxRenderRows(emailData);
  }

  function _inboxRenderRows(emailData) {
    const rows = Array.isArray(emailData.extracted_rows) ? emailData.extracted_rows : [];
    const tbody = document.getElementById("irm-tbody");
    const emptyEl = document.getElementById("irm-empty");
    const errEl = document.getElementById("irm-error");

    if (emailData.error && rows.length === 0) {
      errEl.style.display = "";
      errEl.textContent = "Błąd ekstrakcji: " + emailData.error;
    }

    const supplierGuess = rows.length > 0 ? (rows[0].supplier || "") : "";
    document.getElementById("irm-supplier").value = supplierGuess;

    if (rows.length === 0) {
      tbody.innerHTML = "";
      emptyEl.style.display = "";
      return;
    }
    emptyEl.style.display = "none";
    tbody.innerHTML = rows.map((r, i) => `
      <tr>
        <td><input type="checkbox" class="irm-row-check" checked data-idx="${i}"></td>
        <td><input type="text" class="form-control form-control-sm irm-product" data-idx="${i}" value="${escHtml(r.product_name||"")}"></td>
        <td><input type="text" class="form-control form-control-sm irm-supplier-row" data-idx="${i}" value="${escHtml(r.supplier||"")}"></td>
        <td><input type="number" class="form-control form-control-sm irm-price" data-idx="${i}" value="${r.price_original||""}" step="0.01"></td>
        <td>
          <select class="form-select form-select-sm irm-currency" data-idx="${i}">
            ${["PLN","EUR","USD","GBP","CHF"].map(c=>`<option${r.currency===c?" selected":""}>${c}</option>`).join("")}
          </select>
        </td>
        <td><input type="number" class="form-control form-control-sm irm-moq" data-idx="${i}" value="${r.moq||""}" step="0.001"></td>
        <td>
          <select class="form-select form-select-sm irm-cat" data-idx="${i}">
            <option value="substancja_czynna"${(r.category||"")==="substancja_czynna"?" selected":""}>Substancja</option>
            <option value="opakowanie"${(r.category||"")==="opakowanie"?" selected":""}>Opakowanie</option>
            <option value="kapsulka"${(r.category||"")==="kapsulka"?" selected":""}>Kapsułka</option>
          </select>
        </td>
      </tr>`).join("");
  }

  function inboxCheckAll(cb) {
    document.querySelectorAll(".irm-row-check").forEach(c => c.checked = cb.checked);
  }

  async function inboxConfirm() {
    const email = _inboxAll.find(e => e.id === _inboxReviewId);
    if (!email) return;

    const supplierOverride = document.getElementById("irm-supplier").value.trim();
    const globalPriceType = document.getElementById("irm-global-price-type").value;
    const globalIncoterm  = document.getElementById("irm-global-incoterm").value || null;
    const globalQuoteDate = document.getElementById("irm-global-quote-date").value || null;
    const globalValidUntil= document.getElementById("irm-global-valid-until").value || null;

    // Collect checked rows with edited values
    const rows = [];
    document.querySelectorAll(".irm-row-check:checked").forEach(cb => {
      const i = cb.dataset.idx;
      rows.push({
        product_name:   document.querySelector(`.irm-product[data-idx="${i}"]`).value.trim(),
        supplier:       document.querySelector(`.irm-supplier-row[data-idx="${i}"]`).value.trim() || supplierOverride,
        price_original: parseFloat(document.querySelector(`.irm-price[data-idx="${i}"]`).value) || 0,
        currency:       document.querySelector(`.irm-currency[data-idx="${i}"]`).value,
        moq:            parseFloat(document.querySelector(`.irm-moq[data-idx="${i}"]`).value) || null,
        category:       document.querySelector(`.irm-cat[data-idx="${i}"]`).value,
        incoterm:       globalIncoterm,
        quote_date:     globalQuoteDate,
        valid_until:    globalValidUntil,
        price_type:     globalPriceType,
        contact_email:  email.from_addr,
        quantity:       1,
      });
    });

    if (rows.length === 0) {
      toast("Nie wybrano żadnych pozycji", "warning");
      return;
    }

    // Duplicate check
    const dupes = _checkDuplicates(rows);
    if (dupes.length && !(await _confirmDuplicates(dupes))) return;

    try {
      const res = await apiFetch(`/api/inbox/${_inboxReviewId}/confirm`, {
        method: "POST",
        headers: {"Content-Type":"application/json"},
        body: JSON.stringify({rows, supplier_override: supplierOverride}),
      }).then(r => r.json());

      _getInboxModal().hide();
      toast(`Zapisano ${res.saved} wycen`, "success");
      await _loadInbox();
      // Refresh pricelists
      if (typeof loadSubstancesPricelist === "function") loadSubstancesPricelist();
    } catch(e) {
      toast("Błąd: " + e.message, "danger");
    }
  }

  async function inboxReject() {
    try {
      await apiFetch(`/api/inbox/${_inboxReviewId}/reject`, {method:"POST"});
      _getInboxModal().hide();
      toast("Odrzucono", "secondary");
      await _loadInbox();
    } catch(e) {
      toast("Błąd: " + e.message, "danger");
    }
  }

  async function inboxRejectDirect(id) {
    _inboxReviewId = id;
    await inboxReject();
  }

})();
