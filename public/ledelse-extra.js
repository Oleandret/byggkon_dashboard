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
      document.getElementById("ledBillKpi").innerHTML = [
        `<div class="kpi-card accent"><div class="kpi-label">Faktureringsgrad — siste 2 uker</div><div class="kpi-value">${pct(k.last14.rate)}</div><div class="kpi-sub">${num(k.last14.billable)} av ${num(k.last14.hours)} t</div></div>`,
        `<div class="kpi-card"><div class="kpi-label">Faktureringsgrad — siste uke</div><div class="kpi-value">${pct(k.last7.rate)}</div><div class="kpi-sub">${num(k.last7.billable)} av ${num(k.last7.hours)} t</div></div>`,
      ].join("");
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

  // Last filene når Ledelse-fanen åpnes
  const tab = document.querySelector('.tab[data-tab="ledelse"]');
  if (tab) tab.addEventListener("click", loadFiles);
})();
