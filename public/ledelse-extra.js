// Ledelse-tillegg: underfaner, filslots (likviditet/rapport/resultat/budsjett) og
// faktureringsgrad-grafer (12 mnd, 3 mnd, 2 uker, 1 uke).
(function () {
  const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  const nok = (n) => new Intl.NumberFormat("nb-NO", { style: "currency", currency: "NOK", maximumFractionDigits: 0 }).format(n || 0);
  const num = (n, d = 0) => new Intl.NumberFormat("nb-NO", { maximumFractionDigits: d }).format(n || 0);
  const pct = (n) => `${Math.round((n || 0) * 100)} %`;
  function err(m) { const el = document.getElementById("errorBanner"); el.textContent = m; el.hidden = false; setTimeout(() => (el.hidden = true), 8000); }

  // ---- Underfaner ----
  document.querySelectorAll("#ledSubtabs .subtab").forEach((b) => {
    b.addEventListener("click", () => {
      document.querySelectorAll("#ledSubtabs .subtab").forEach((x) => x.classList.remove("active"));
      document.querySelectorAll(".led-sub").forEach((x) => x.classList.remove("active"));
      b.classList.add("active");
      const target = document.getElementById("ledsub-" + b.dataset.sub);
      if (target) target.classList.add("active");
      if (b.dataset.sub === "faktgrad") loadBilling();
    });
  });

  // ---- Filslots ----
  const slotIcon = (url) => /\.pdf(\?|$)/i.test(url || "") ? "📄" : /\.(xlsx?|csv)(\?|$)/i.test(url || "") ? "📊" : /\.(pptx?)(\?|$)/i.test(url || "") ? "📊" : "📎";
  function renderFiles(files) {
    document.querySelectorAll(".card[data-slot]").forEach((card) => {
      const slot = card.dataset.slot;
      const view = card.querySelector(".led-file-view");
      const f = files[slot];
      if (f && f.url) {
        view.innerHTML = `<div class="hb-card">
          <div class="hb-meta">
            <div class="hb-name">${slotIcon(f.url)} ${esc(f.filename || "Dokument")}</div>
            <div class="hb-rev">Revisjon: <b>${esc(f.revision || "—")}</b> · lastet opp ${esc(f.uploadedAt || "")}</div>
          </div>
          <a class="btn-primary" href="${esc(f.url)}" target="_blank" rel="noopener">Åpne / Last ned ↗</a>
        </div>`;
      } else {
        view.innerHTML = `<div class="empty">Ingen fil lastet opp ennå.</div>`;
      }
    });
  }
  let filesLoaded = false;
  async function loadFiles() {
    if (filesLoaded) return; filesLoaded = true;
    try { const d = await (await fetch("/api/ledelse/files")).json(); renderFiles(d.files || {}); }
    catch (e) { err("Kunne ikke hente filer: " + e.message); }
  }
  document.querySelectorAll(".card[data-slot]").forEach((card) => {
    const slot = card.dataset.slot;
    const btn = card.querySelector(".led-up");
    btn.addEventListener("click", async () => {
      const fileEl = card.querySelector(".led-file");
      const revEl = card.querySelector(".led-rev");
      const msg = card.querySelector(".led-msg");
      const f = fileEl.files[0];
      if (!f) { msg.textContent = "Velg en fil først."; return; }
      msg.textContent = "Laster opp …";
      try {
        const dataUrl = await new Promise((resolve, reject) => { const r = new FileReader(); r.onload = () => resolve(r.result); r.onerror = reject; r.readAsDataURL(f); });
        const res = await fetch("/api/ledelse/file", { method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ slot, dataUrl, filename: f.name, revision: revEl.value }) });
        const d = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(d.error || "Opplasting feilet");
        const all = await (await fetch("/api/ledelse/files")).json();
        renderFiles(all.files || {});
        msg.textContent = "✓ Lastet opp.";
        fileEl.value = "";
      } catch (e) { msg.textContent = "Feil: " + e.message; }
    });
  });

  // ---- Faktureringsgrad-grafer ----
  let billLoaded = false;
  let trendChart, threeChart;
  function css(v) { return getComputedStyle(document.documentElement).getPropertyValue(v).trim(); }
  function palette(i, n) {
    const hue = (i * 360 / Math.max(n, 1)) % 360;
    return `hsl(${Math.round(hue)} 55% 45%)`;
  }
  async function loadBilling() {
    if (billLoaded) return; billLoaded = true;
    const status = document.getElementById("ledBillStatus");
    try {
      const res = await fetch("/api/ledelse/billing");
      if (!res.ok) { const e = await res.json().catch(() => ({})); throw new Error(e.error || `Feil ${res.status}`); }
      const d = await res.json();
      status.hidden = true;
      // KPI siste 2 uker + siste uke
      const k = d.total || { last14: {}, last7: {} };
      const t6 = d.trend6 || [];
      const avg6 = t6.length ? t6.reduce((s, x) => s + x.rate, 0) / t6.length : 0;
      document.getElementById("ledBillKpi").innerHTML = [
        `<div class="kpi-card accent"><div class="kpi-label">Faktureringsgrad — siste 2 uker</div><div class="kpi-value">${pct(k.last14.rate)}</div><div class="kpi-sub">${num(k.last14.billable)} av ${num(k.last14.hours)} t</div></div>`,
        `<div class="kpi-card"><div class="kpi-label">Faktureringsgrad — siste uke</div><div class="kpi-value">${pct(k.last7.rate)}</div><div class="kpi-sub">${num(k.last7.billable)} av ${num(k.last7.hours)} t</div></div>`,
        `<div class="kpi-card"><div class="kpi-label">Snitt — siste 6 måneder</div><div class="kpi-value">${pct(avg6)}</div><div class="kpi-sub">hele firmaet</div></div>`,
      ].join("");
      // 6-måneders totaltrend
      const sixCtx = document.getElementById("ledBill6m");
      if (sixCtx) {
        if (window._sixChart) window._sixChart.destroy();
        window._sixChart = new Chart(sixCtx, {
          type: "bar",
          data: {
            labels: t6.map((x) => x.label),
            datasets: [{
              label: "Faktureringsgrad",
              data: t6.map((x) => Math.round(x.rate * 100)),
              backgroundColor: t6.map((x) => x.rate >= 0.70 ? "#1d6a3b" : x.rate >= 0.60 ? "#d18d3c" : "#b42318"),
              borderRadius: 6,
            }],
          },
          options: {
            responsive: true, maintainAspectRatio: false,
            plugins: {
              legend: { display: false },
              tooltip: { callbacks: { label: (c) => `${c.raw} % (${num(t6[c.dataIndex].billable)} av ${num(t6[c.dataIndex].hours)} t)` } },
              annotation: undefined,
            },
            scales: {
              x: { ticks: { color: css("--muted") }, grid: { display: false } },
              y: { suggestedMin: 0, suggestedMax: 100, ticks: { color: css("--muted"), callback: (v) => v + " %" }, grid: { color: css("--grid") } },
            },
          },
        });
      }
      const n = d.employees.length;
      const trendDatasets = d.employees.map((e, i) => ({
        label: e.name, data: e.trend12.map((v) => v === null ? null : Math.round(v * 100)),
        borderColor: palette(i, n), backgroundColor: palette(i, n), tension: 0.25, spanGaps: true, pointRadius: 2,
      }));
      const trendCtx = document.getElementById("ledBillTrend");
      if (trendChart) { trendChart.destroy(); }
      trendChart = new Chart(trendCtx, {
        type: "line",
        data: { labels: d.months, datasets: trendDatasets },
        options: {
          responsive: true, maintainAspectRatio: false,
          plugins: { legend: { labels: { color: css("--muted"), font: { size: 11 } } }, tooltip: { callbacks: { label: (c) => `${c.dataset.label}: ${c.raw} %` } } },
          scales: { x: { ticks: { color: css("--muted") }, grid: { display: false } }, y: { suggestedMin: 0, suggestedMax: 100, ticks: { color: css("--muted"), callback: (v) => v + " %" }, grid: { color: css("--grid") } } },
        },
      });
      // 3 mnd per ansatt – horisontalbar
      const three = d.employees.slice().sort((a, b) => b.last3Rate - a.last3Rate);
      const threeCtx = document.getElementById("ledBill3m");
      if (threeChart) threeChart.destroy();
      threeChart = new Chart(threeCtx, {
        type: "bar",
        data: { labels: three.map((e) => e.name), datasets: [{ data: three.map((e) => Math.round(e.last3Rate * 100)), backgroundColor: three.map((_, i) => palette(i, three.length)), borderRadius: 4 }] },
        options: {
          indexAxis: "y", responsive: true, maintainAspectRatio: false,
          plugins: { legend: { display: false }, tooltip: { callbacks: { label: (c) => `${c.raw} % (${num(three[c.dataIndex].last3Billable)} av ${num(three[c.dataIndex].last3Hours)} t)` } } },
          scales: { x: { suggestedMin: 0, suggestedMax: 100, ticks: { color: css("--muted"), callback: (v) => v + " %" }, grid: { color: css("--grid") } }, y: { ticks: { color: css("--muted") }, grid: { display: false } } },
        },
      });
    } catch (e) { status.hidden = false; status.textContent = "Kunne ikke hente faktureringsgrad: " + e.message; billLoaded = false; }
  }

  /* ============ AUTO-DATA: LIKVIDITET / RESULTAT / BUDSJETT ============ */
  let autoData = null;
  const nokfmt = (n) => (Math.round(n || 0)).toLocaleString("nb-NO") + " kr";
  const escAuto = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

  async function loadAuto() {
    const targets = { likviditet: document.getElementById("ledAutoLikv"), resultat: document.getElementById("ledAutoRes"), budsjett: document.getElementById("ledAutoBud") };
    Object.values(targets).forEach((el) => { if (el) el.innerHTML = `<div class="subnote">Henter data fra Tripletex …</div>`; });
    try {
      const res = await fetch("/api/ledelse/auto");
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || ("Feil " + res.status));
      autoData = await res.json();
      renderLikv(); renderRes(); renderBud();
    } catch (e) {
      Object.values(targets).forEach((el) => { if (el) el.innerHTML = `<div class="empty">Kunne ikke hente: ${escAuto(e.message)}</div>`; });
    }
  }

  function adjustmentRows(slot) { return (autoData?.adjustments?.[slot] || []); }
  function sumAdjForMonth(slot, monthKey) {
    return adjustmentRows(slot).filter((a) => a.month === monthKey)
      .reduce((s, a) => s + (a.type === "out" ? -a.amount : a.amount), 0);
  }
  function adjustmentEditor(slot) {
    const items = adjustmentRows(slot);
    return `<div class="adj-box">
      <div class="adj-head">
        <h3 style="margin:0;font-size:14px">Justeringer (${escAuto(slot)})</h3>
        <button class="btn-ghost adj-add" data-slot="${slot}">+ Ny justering</button>
        <button class="btn-primary adj-save" data-slot="${slot}">Lagre</button>
      </div>
      <table class="adj-tbl">
        <thead><tr><th>Måned</th><th>Beskrivelse</th><th>Type</th><th class="num">Beløp</th><th>Notat</th><th></th></tr></thead>
        <tbody>${items.length ? items.map((a, i) => `
          <tr data-slot="${slot}" data-i="${i}">
            <td><input class="kon-f" type="month" data-f="month" value="${escAuto(a.month)}" /></td>
            <td><input class="kon-f" data-f="label" value="${escAuto(a.label)}" placeholder="Beskrivelse" /></td>
            <td><select class="kon-f" data-f="type">
              <option value="in" ${a.type !== "out" ? "selected" : ""}>+ Tilfør</option>
              <option value="out" ${a.type === "out" ? "selected" : ""}>− Trekk fra</option>
            </select></td>
            <td><input class="kon-f num" type="number" min="0" step="1000" data-f="amount" value="${a.amount || 0}" /></td>
            <td><input class="kon-f" data-f="note" value="${escAuto(a.note || "")}" placeholder="Notat" /></td>
            <td><button class="btn-ghost adj-del" data-slot="${slot}" data-i="${i}">🗑</button></td>
          </tr>`).join("") : `<tr><td colspan="6" class="empty">Ingen justeringer ennå. Klikk «+ Ny justering» for å legge til en.</td></tr>`}</tbody>
      </table>
    </div>`;
  }

  function renderLikv() {
    const box = document.getElementById("ledAutoLikv"); if (!box || !autoData) return;
    const rows = autoData.likviditet || [];
    // Reset accumulated based on justeringer-in tillagt
    let acc = 0;
    box.innerHTML = `<table class="auto-tbl">
      <thead><tr>
        <th>Måned</th><th class="num">Innbetalinger</th><th class="num">Utbetalinger</th>
        <th class="num">Justeringer</th><th class="num">Netto</th><th class="num">Akkumulert</th>
      </tr></thead>
      <tbody>${rows.map((r) => {
        const adj = sumAdjForMonth("likviditet", r.key);
        const net = r.cashIn - r.cashOut + adj;
        acc += net;
        return `<tr>
          <td><b>${escAuto(r.label)}</b></td>
          <td class="num">${nokfmt(r.cashIn)}</td>
          <td class="num">${nokfmt(r.cashOut)}</td>
          <td class="num ${adj >= 0 ? "" : "neg"}">${adj === 0 ? "—" : (adj > 0 ? "+" : "") + nokfmt(adj)}</td>
          <td class="num ${net >= 0 ? "" : "neg"}"><b>${nokfmt(net)}</b></td>
          <td class="num ${acc >= 0 ? "" : "neg"}">${nokfmt(acc)}</td>
        </tr>`;
      }).join("")}</tbody>
    </table>${adjustmentEditor("likviditet")}`;
  }

  function renderRes() {
    const box = document.getElementById("ledAutoRes"); if (!box || !autoData) return;
    const rows = autoData.resultat || [];
    box.innerHTML = `<table class="auto-tbl">
      <thead><tr>
        <th>Måned</th><th class="num">Inntekter</th><th class="num">Driftskost</th>
        <th class="num">Resultat (auto)</th><th class="num">Justeringer</th><th class="num">Resultat justert</th>
      </tr></thead>
      <tbody>${rows.map((r) => {
        const adj = sumAdjForMonth("resultat", r.key);
        const total = r.result + adj;
        return `<tr>
          <td><b>${escAuto(r.label)}</b></td>
          <td class="num">${nokfmt(r.revenue)}</td>
          <td class="num">${nokfmt(r.opex)}</td>
          <td class="num ${r.result >= 0 ? "" : "neg"}">${nokfmt(r.result)}</td>
          <td class="num ${adj >= 0 ? "" : "neg"}">${adj === 0 ? "—" : (adj > 0 ? "+" : "") + nokfmt(adj)}</td>
          <td class="num ${total >= 0 ? "" : "neg"}"><b>${nokfmt(total)}</b></td>
        </tr>`;
      }).join("")}</tbody>
    </table>${adjustmentEditor("resultat")}`;
  }

  function renderBud() {
    const box = document.getElementById("ledAutoBud"); if (!box || !autoData) return;
    const rows = autoData.budsjett || [];
    box.innerHTML = `<p class="subnote" style="margin-top:0">Basis = snitt siste 6 måneder. Bruk justeringer for å bake inn endringer.</p>
    <table class="auto-tbl">
      <thead><tr>
        <th>Måned</th><th class="num">Inntekter (basis)</th><th class="num">Kostnader (basis)</th>
        <th class="num">Resultat (basis)</th><th class="num">Justeringer</th><th class="num">Resultat justert</th>
      </tr></thead>
      <tbody>${rows.map((r) => {
        const adj = sumAdjForMonth("budsjett", r.key);
        const total = r.resultPlan + adj;
        return `<tr>
          <td><b>${escAuto(r.label)}</b></td>
          <td class="num">${nokfmt(r.revenuePlan)}</td>
          <td class="num">${nokfmt(r.opexPlan)}</td>
          <td class="num ${r.resultPlan >= 0 ? "" : "neg"}">${nokfmt(r.resultPlan)}</td>
          <td class="num ${adj >= 0 ? "" : "neg"}">${adj === 0 ? "—" : (adj > 0 ? "+" : "") + nokfmt(adj)}</td>
          <td class="num ${total >= 0 ? "" : "neg"}"><b>${nokfmt(total)}</b></td>
        </tr>`;
      }).join("")}</tbody>
    </table>${adjustmentEditor("budsjett")}`;
  }

  async function saveAdj(slot) {
    if (!autoData) return;
    const items = autoData.adjustments[slot] || [];
    try {
      const res = await fetch("/api/ledelse/adjustments", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ slot, items }),
      });
      if (!res.ok) throw new Error("Lagring feilet");
      // Re-render etter lagring
      if (slot === "likviditet") renderLikv();
      else if (slot === "resultat") renderRes();
      else renderBud();
    } catch (e) { alert("Kunne ikke lagre: " + e.message); }
  }

  document.addEventListener("click", (e) => {
    if (e.target.classList && e.target.classList.contains("led-auto-reload")) { loadAuto(); return; }
    if (e.target.classList && e.target.classList.contains("adj-add")) {
      const slot = e.target.dataset.slot;
      if (!autoData) return;
      autoData.adjustments[slot] = autoData.adjustments[slot] || [];
      const monthKey = new Date().toISOString().slice(0, 7);
      autoData.adjustments[slot].push({ id: "a_" + Math.random().toString(36).slice(2, 9), month: monthKey, label: "", type: "in", amount: 0, note: "" });
      if (slot === "likviditet") renderLikv(); else if (slot === "resultat") renderRes(); else renderBud();
      return;
    }
    if (e.target.classList && e.target.classList.contains("adj-del")) {
      const slot = e.target.dataset.slot, i = Number(e.target.dataset.i);
      autoData.adjustments[slot].splice(i, 1);
      if (slot === "likviditet") renderLikv(); else if (slot === "resultat") renderRes(); else renderBud();
      return;
    }
    if (e.target.classList && e.target.classList.contains("adj-save")) {
      return saveAdj(e.target.dataset.slot);
    }
  });
  document.addEventListener("input", (e) => {
    const tr = e.target.closest(".adj-tbl tbody tr");
    if (!tr || !e.target.dataset.f) return;
    const slot = tr.dataset.slot, i = Number(tr.dataset.i);
    const a = autoData?.adjustments?.[slot]?.[i]; if (!a) return;
    const f = e.target.dataset.f;
    a[f] = (f === "amount") ? (Number(e.target.value) || 0) : e.target.value;
    // Re-render bare tabellen (ikke editor) for å vise oppdaterte summer
    if (slot === "likviditet") renderLikv(); else if (slot === "resultat") renderRes(); else renderBud();
  });

  // Last filene + auto-data når Ledelse-fanen åpnes
  let autoLoaded = false;
  const tab = document.querySelector('.tab[data-tab="ledelse"]');
  if (tab) tab.addEventListener("click", () => {
    loadFiles();
    if (!autoLoaded) { autoLoaded = true; loadAuto(); }
  });
})();
