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
      renderRes(); renderBud();
      // Likviditet kommer fra eget endepunkt med Excel-stil tabell
      loadLikv();
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

  /* ---- Excel-stil Likviditetsprognose ---- */
  let likvData = null;
  let likvDirty = false;

  async function loadLikv() {
    const box = document.getElementById("ledAutoLikv");
    if (!box) return;
    box.innerHTML = `<div class="subnote">Henter likviditetsdata fra Tripletex …</div>`;
    try {
      const res = await fetch("/api/ledelse/likviditet");
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || ("Feil " + res.status));
      likvData = await res.json();
      likvDirty = false;
      renderLikv();
    } catch (e) {
      box.innerHTML = `<div class="empty">Kunne ikke hente: ${escAuto(e.message)}</div>`;
    }
  }
  async function saveLikv(payload) {
    try {
      const res = await fetch("/api/ledelse/likviditet", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
      if (!res.ok) throw new Error("Lagring feilet");
    } catch (e) { console.warn("Likv save:", e); }
  }
  function getAdj(rowKey, monthKey) {
    return Number(likvData?.adjustments?.[rowKey]?.[monthKey] || 0);
  }
  function setAdj(rowKey, monthKey, val) {
    if (!likvData.adjustments[rowKey]) likvData.adjustments[rowKey] = {};
    const n = Number(val) || 0;
    if (n === 0) delete likvData.adjustments[rowKey][monthKey];
    else likvData.adjustments[rowKey][monthKey] = Math.round(n);
    likvDirty = true;
  }
  function effective(row, mi) {
    const monthKey = likvData.months[mi].key;
    return (row.auto[mi] || 0) + getAdj(row.key, monthKey);
  }

  function renderLikv() {
    const box = document.getElementById("ledAutoLikv");
    if (!box || !likvData) return;
    const months = likvData.months;
    // KPI / setup øverst
    const setupHtml = `
      <div class="likv-setup">
        <label>Disponibel saldo (start)<input type="number" id="likvStart" value="${likvData.startBalance || 0}" step="10000" /></label>
        <label>Kassekredittgrense<input type="number" id="likvKK" value="${likvData.kassekreditt || 0}" step="100000" /></label>
        <label>KK-saldo (start)<input type="number" id="likvKKSaldo" value="${likvData.kassekredittSaldo || 0}" step="100000" /></label>
        <label>Rente (årlig)<input type="number" id="likvRente" value="${likvData.rente || 0}" step="0.0001" /></label>
        <button class="btn-primary" id="likvSaveSetup">Lagre oppsett</button>
        <button class="btn-primary" id="likvSaveAdj" ${likvDirty ? "" : "disabled"}>Lagre justeringer</button>
      </div>`;

    // Tabellrendering
    const monthHeader = months.map((m) => `<th class="num">${escAuto(m.label)}</th>`).join("");
    let html = `${setupHtml}<div class="likv-scroll"><table class="likv-tbl">
      <thead><tr><th class="lt-row">Post</th>${monthHeader}<th class="num">SUM</th></tr></thead>
      <tbody>`;

    // Akkumulatorer for sumlinje per seksjon
    const sectionSums = {};
    likvData.sections.forEach((sec) => {
      sectionSums[sec.key] = months.map(() => 0);
      html += `<tr class="lt-group"><td colspan="${months.length + 2}">${escAuto(sec.title)}</td></tr>`;
      sec.rows.forEach((row) => {
        const cells = months.map((m, i) => {
          const auto = row.auto[i] || 0;
          const adj = getAdj(row.key, m.key);
          const eff = auto + adj;
          sectionSums[sec.key][i] += eff;
          return `<td class="num lt-cell">
            <div class="lt-auto" title="Auto fra Tripletex">${auto ? nokshort(auto) : "—"}</div>
            <input type="number" class="lt-adj" data-row="${escAuto(row.key)}" data-month="${escAuto(m.key)}" value="${adj || 0}" step="1000" placeholder="0" />
          </td>`;
        }).join("");
        const rowSum = months.reduce((s, _, i) => s + (row.auto[i] || 0) + getAdj(row.key, months[i].key), 0);
        html += `<tr class="lt-row-itm">
          <td class="lt-row"><b>${escAuto(row.label)}</b><span class="subnote"> ${escAuto(row.source || "")}</span></td>
          ${cells}
          <td class="num"><b>${nokshort(rowSum)}</b></td>
        </tr>`;
      });
      // Sumrad for seksjonen
      const sectionTotalCells = sectionSums[sec.key].map((v) => `<td class="num lt-sum-cell">${nokshort(v)}</td>`).join("");
      const sectionTotal = sectionSums[sec.key].reduce((s, v) => s + v, 0);
      html += `<tr class="lt-sum">
        <td>Sum ${escAuto(sec.title.toLowerCase())}</td>
        ${sectionTotalCells}
        <td class="num">${nokshort(sectionTotal)}</td>
      </tr>`;
    });

    // Beregn likviditet linje for linje
    const sumIn = sectionSums.innbetalinger;
    const sumUt = sectionSums.utbetalinger;
    const sumFast = sectionSums.fasteKostnader;
    let ib = likvData.startBalance || 0;
    const netto = months.map((_, i) => (sumIn[i] || 0) - (sumUt[i] || 0) - (sumFast[i] || 0));
    const ubArr = []; let ubAcc = ib;
    netto.forEach((n) => { ubAcc += n; ubArr.push(ubAcc); });

    html += `<tr class="lt-totals lt-totals-h"><td colspan="${months.length + 2}">Likviditet</td></tr>`;
    // Disponibelt IB
    html += `<tr class="lt-totals"><td>Disponibelt IB</td>${months.map((_, i) => {
      const ibThis = i === 0 ? (likvData.startBalance || 0) : ubArr[i - 1];
      return `<td class="num">${nokshort(ibThis)}</td>`;
    }).join("")}<td></td></tr>`;
    html += `<tr class="lt-totals"><td>Netto kontantstrøm</td>${netto.map((n) => `<td class="num ${n >= 0 ? "" : "neg"}">${nokshort(n)}</td>`).join("")}<td class="num">${nokshort(netto.reduce((s, n) => s + n, 0))}</td></tr>`;
    html += `<tr class="lt-totals lt-ub"><td>UB bank (inkl. KK)</td>${ubArr.map((v) => `<td class="num ${v >= 0 ? "" : "neg"}"><b>${nokshort(v)}</b></td>`).join("")}<td></td></tr>`;
    const kk = likvData.kassekreditt || 0;
    html += `<tr class="lt-totals"><td>UB bank (eksl. KK)</td>${ubArr.map((v) => `<td class="num ${v - kk >= 0 ? "" : "neg"}">${nokshort(v - kk)}</td>`).join("")}<td></td></tr>`;

    html += `</tbody></table></div>`;
    box.innerHTML = html;

    // Event hooks
    box.querySelectorAll(".lt-adj").forEach((inp) => {
      inp.addEventListener("input", () => {
        setAdj(inp.dataset.row, inp.dataset.month, Number(inp.value) || 0);
        document.getElementById("likvSaveAdj").disabled = false;
      });
      inp.addEventListener("change", renderLikv);
    });
    document.getElementById("likvSaveSetup")?.addEventListener("click", async () => {
      const payload = {
        startBalance: Number(document.getElementById("likvStart").value) || 0,
        kassekreditt: Number(document.getElementById("likvKK").value) || 0,
        kassekredittSaldo: Number(document.getElementById("likvKKSaldo").value) || 0,
        rente: Number(document.getElementById("likvRente").value) || 0,
      };
      Object.assign(likvData, payload);
      await saveLikv(payload);
      renderLikv();
    });
    document.getElementById("likvSaveAdj")?.addEventListener("click", async () => {
      await saveLikv({ adjustments: likvData.adjustments });
      likvDirty = false;
      renderLikv();
    });
  }

  /* ============ ØKONOMIRAPPORT (PowerPoint-stil) ============ */
  let rapportCharts = {};
  let rapportLoaded = false;
  async function loadRapport() {
    if (rapportLoaded) return; rapportLoaded = true;
    try {
      const [econRes, likvRes] = await Promise.all([fetch("/api/economy"), fetch("/api/ledelse/likviditet")]);
      const econ = await econRes.json();
      const likv = likvRes.ok ? await likvRes.json() : null;
      renderRapport(econ, likv);
    } catch (e) {
      console.warn("Rapport-feil:", e);
      rapportLoaded = false;
    }
  }
  function destroyCharts() {
    Object.values(rapportCharts).forEach((c) => { try { c.destroy(); } catch {} });
    rapportCharts = {};
  }
  function renderRapport(econ, likv) {
    destroyCharts();
    const fmtNok = (n) => Math.round(n || 0).toLocaleString("nb-NO");
    const pctNum = (x) => Math.round((x || 0) * 100) + " %";
    // Tittel
    const now = new Date();
    document.getElementById("rapportPeriod").textContent = `Status per ${now.toLocaleDateString("nb-NO", { day: "numeric", month: "long", year: "numeric" })}`;

    /* ---- Slide 2: Resultat 2026 og LTM ---- */
    const trend = econ.trend || [];
    document.getElementById("rapportResultKpis").innerHTML = `
      <div class="rapport-kpi"><div class="rk-lbl">Omsetning hittil i år</div><div class="rk-val">${fmtNok(econ.resultYTD?.revenue)} kr</div></div>
      <div class="rapport-kpi"><div class="rk-lbl">Driftsresultat hittil</div><div class="rk-val">${fmtNok(econ.resultYTD?.operatingResult)} kr</div></div>
      <div class="rapport-kpi"><div class="rk-lbl">Omsetning LTM</div><div class="rk-val">${fmtNok(econ.resultLTM?.revenue)} kr</div></div>
      <div class="rapport-kpi"><div class="rk-lbl">EBT LTM</div><div class="rk-val ${econ.resultLTM?.ebt >= 0 ? "" : "neg"}">${fmtNok(econ.resultLTM?.ebt)} kr</div></div>
    `;
    rapportCharts.result = new Chart(document.getElementById("rapportResultChart"), {
      type: "bar",
      data: {
        labels: trend.map((t) => t.label),
        datasets: [
          { label: "Sum Inntekter", data: trend.map((t) => t.revenue), backgroundColor: "#2b6eb8", borderRadius: 4, order: 2 },
          { label: "EBT", data: trend.map((t) => t.ebt), backgroundColor: trend.map((t) => t.ebt >= 0 ? "#1d6a3b" : "#b42318"), borderRadius: 4, order: 1, type: "bar" },
        ],
      },
      options: {
        responsive: true, maintainAspectRatio: false,
        plugins: {
          legend: { labels: { color: css("--muted"), font: { size: 11 } } },
          tooltip: { callbacks: { label: (c) => `${c.dataset.label}: ${fmtNok(c.raw)} kr` } },
        },
        scales: {
          x: { ticks: { color: css("--muted") }, grid: { display: false } },
          y: { ticks: { color: css("--muted"), callback: (v) => Math.round(v / 1000) + "k" }, grid: { color: css("--grid") } },
        },
      },
    });
    const lastTrend = trend[trend.length - 1];
    if (lastTrend) {
      document.getElementById("rapportResultNote").textContent =
        `Siste måned (${lastTrend.label}): Inntekter ${fmtNok(lastTrend.revenue)} kr, EBT ${fmtNok(lastTrend.ebt)} kr.`;
    }

    /* ---- Slide 3: Balanse ---- */
    const b = econ.balance || {};
    document.getElementById("rapportBalanceKpis").innerHTML = `
      <div class="rapport-kpi"><div class="rk-lbl">Bank</div><div class="rk-val ${b.bank >= 0 ? "" : "neg"}">${fmtNok(b.bank)} kr</div></div>
      <div class="rapport-kpi"><div class="rk-lbl">Kundefordringer</div><div class="rk-val">${fmtNok(b.receivables)} kr</div></div>
      <div class="rapport-kpi"><div class="rk-lbl">Leverandørgjeld</div><div class="rk-val">${fmtNok(b.supplierDebt)} kr</div></div>
      <div class="rapport-kpi"><div class="rk-lbl">Egenkapital*</div><div class="rk-val">${fmtNok(b.equity)} kr</div></div>
    `;
    const totLiab = (b.liabilities || 0);
    const totAssets = (b.assets || 0);
    const ekRatio = totAssets > 0 ? (b.equity / totAssets) : 0;
    document.getElementById("rapportBalanceTable").innerHTML = `
      <table class="rapport-tbl">
        <thead><tr><th>Post</th><th class="num">Beløp (kr)</th></tr></thead>
        <tbody>
          <tr class="grp"><td>Eiendeler</td><td class="num"><b>${fmtNok(b.assets)}</b></td></tr>
          <tr><td>— hvorav bank</td><td class="num">${fmtNok(b.bank)}</td></tr>
          <tr><td>— hvorav kundefordringer</td><td class="num">${fmtNok(b.receivables)}</td></tr>
          <tr class="grp"><td>Gjeld og egenkapital</td><td class="num"><b>${fmtNok(totLiab + (b.equity || 0))}</b></td></tr>
          <tr><td>— Egenkapital*</td><td class="num">${fmtNok(b.equity)} (${pctNum(ekRatio)})</td></tr>
          <tr><td>— Leverandørgjeld</td><td class="num">${fmtNok(b.supplierDebt)}</td></tr>
          <tr><td>— Annen gjeld</td><td class="num">${fmtNok(totLiab - (b.supplierDebt || 0))}</td></tr>
        </tbody>
      </table>`;

    /* ---- Slide 4: Likviditet ---- */
    if (likv && likv.months) {
      const months = likv.months;
      // Beregn netto per måned fra auto + justeringer
      const sumPerSection = { innbetalinger: months.map(() => 0), utbetalinger: months.map(() => 0), fasteKostnader: months.map(() => 0) };
      likv.sections.forEach((sec) => {
        sec.rows.forEach((row) => {
          months.forEach((m, i) => {
            const adj = Number(likv.adjustments?.[row.key]?.[m.key] || 0);
            sumPerSection[sec.key][i] += (row.auto[i] || 0) + adj;
          });
        });
      });
      const netto = months.map((_, i) => sumPerSection.innbetalinger[i] - sumPerSection.utbetalinger[i] - sumPerSection.fasteKostnader[i]);
      const ubArr = []; let acc = likv.startBalance || 0;
      netto.forEach((n) => { acc += n; ubArr.push(acc); });
      rapportCharts.likv = new Chart(document.getElementById("rapportLikvChart"), {
        type: "line",
        data: {
          labels: months.map((m) => m.label),
          datasets: [
            { label: "UB bank (inkl. KK)", data: ubArr, borderColor: "#2b6eb8", backgroundColor: "rgba(43,110,184,.12)", fill: true, tension: 0.25 },
            { label: "Netto kontantstrøm/mnd", data: netto, type: "bar", backgroundColor: netto.map((n) => n >= 0 ? "#1d6a3b" : "#b42318"), borderRadius: 4 },
          ],
        },
        options: {
          responsive: true, maintainAspectRatio: false,
          plugins: { legend: { labels: { color: css("--muted"), font: { size: 11 } } }, tooltip: { callbacks: { label: (c) => `${c.dataset.label}: ${fmtNok(c.raw)} kr` } } },
          scales: { x: { ticks: { color: css("--muted") }, grid: { display: false } }, y: { ticks: { color: css("--muted"), callback: (v) => Math.round(v / 1000) + "k" }, grid: { color: css("--grid") } } },
        },
      });
    }

    /* ---- Slide 5: Kontantstrøm ---- */
    // Bruk månedsrevenue og månedsresultat fra trend som proxy for cashflow
    const cashflow = trend.map((t) => t.ebt);
    let cumCash = 0; const cumCashArr = cashflow.map((v) => { cumCash += v; return cumCash; });
    rapportCharts.cash = new Chart(document.getElementById("rapportCashChart"), {
      type: "bar",
      data: {
        labels: trend.map((t) => t.label),
        datasets: [
          { label: "EBT per måned", data: cashflow, backgroundColor: cashflow.map((n) => n >= 0 ? "#1d6a3b" : "#b42318"), borderRadius: 4, order: 2 },
          { label: "Akkumulert", data: cumCashArr, type: "line", borderColor: "#2b6eb8", backgroundColor: "rgba(43,110,184,.10)", fill: false, tension: 0.25, order: 1 },
        ],
      },
      options: {
        responsive: true, maintainAspectRatio: false,
        plugins: { legend: { labels: { color: css("--muted"), font: { size: 11 } } }, tooltip: { callbacks: { label: (c) => `${c.dataset.label}: ${fmtNok(c.raw)} kr` } } },
        scales: { x: { ticks: { color: css("--muted") }, grid: { display: false } }, y: { ticks: { color: css("--muted"), callback: (v) => Math.round(v / 1000) + "k" }, grid: { color: css("--grid") } } },
      },
    });

    /* ---- Slide 6: Timeregnskap ---- */
    const b3 = econ.billing3m || { employees: [], total: {} };
    document.getElementById("rapportHoursKpis").innerHTML = `
      <div class="rapport-kpi"><div class="rk-lbl">Faktureringsgrad — siste 3 mnd</div><div class="rk-val">${pctNum(b3.total?.billingRate)}</div></div>
      <div class="rapport-kpi"><div class="rk-lbl">Totale timer 3 mnd</div><div class="rk-val">${num(b3.total?.hours)} t</div></div>
      <div class="rapport-kpi"><div class="rk-lbl">Fakturerbare timer 3 mnd</div><div class="rk-val">${num(b3.total?.billable)} t</div></div>
    `;
    const emps = (b3.employees || []).slice();
    rapportCharts.util = new Chart(document.getElementById("rapportUtilChart"), {
      type: "bar",
      data: {
        labels: emps.map((e) => e.name),
        datasets: [{
          label: "Faktureringsgrad",
          data: emps.map((e) => Math.round(e.billingRate * 100)),
          backgroundColor: emps.map((e) => e.billingRate >= 0.70 ? "#1d6a3b" : e.billingRate >= 0.60 ? "#d18d3c" : "#b42318"),
          borderRadius: 4,
        }],
      },
      options: {
        indexAxis: "y", responsive: true, maintainAspectRatio: false,
        plugins: { legend: { display: false }, tooltip: { callbacks: { label: (c) => `${c.raw} % (${num(emps[c.dataIndex].billable)} av ${num(emps[c.dataIndex].hours)} t)` } } },
        scales: { x: { suggestedMin: 0, suggestedMax: 100, ticks: { color: css("--muted"), callback: (v) => v + " %" }, grid: { color: css("--grid") } }, y: { ticks: { color: css("--muted") }, grid: { display: false } } },
      },
    });
  }

  function nokshort(n) {
    n = Math.round(n || 0);
    if (Math.abs(n) >= 1000000) return (n / 1000000).toFixed(2).replace(/\.?0+$/, "") + "M";
    if (Math.abs(n) >= 10000) return Math.round(n / 1000) + "k";
    return n.toLocaleString("nb-NO");
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
      if (slot === "resultat") renderRes();
      else if (slot === "budsjett") renderBud();
    } catch (e) { alert("Kunne ikke lagre: " + e.message); }
  }

  document.addEventListener("click", (e) => {
    if (e.target.classList && e.target.classList.contains("led-auto-reload")) {
      const slot = e.target.dataset.slot;
      if (slot === "likviditet") loadLikv(); else loadAuto();
      return;
    }
    if (e.target.classList && e.target.classList.contains("adj-add")) {
      const slot = e.target.dataset.slot;
      if (!autoData || slot === "likviditet") return;
      autoData.adjustments[slot] = autoData.adjustments[slot] || [];
      const monthKey = new Date().toISOString().slice(0, 7);
      autoData.adjustments[slot].push({ id: "a_" + Math.random().toString(36).slice(2, 9), month: monthKey, label: "", type: "in", amount: 0, note: "" });
      if (slot === "resultat") renderRes(); else if (slot === "budsjett") renderBud();
      return;
    }
    if (e.target.classList && e.target.classList.contains("adj-del")) {
      const slot = e.target.dataset.slot, i = Number(e.target.dataset.i);
      if (!autoData?.adjustments?.[slot]) return;
      autoData.adjustments[slot].splice(i, 1);
      if (slot === "resultat") renderRes(); else if (slot === "budsjett") renderBud();
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
    if (slot === "resultat") renderRes(); else if (slot === "budsjett") renderBud();
  });

  // Last filene + auto-data når Ledelse-fanen åpnes
  let autoLoaded = false;
  const tab = document.querySelector('.tab[data-tab="ledelse"]');
  if (tab) tab.addEventListener("click", () => {
    loadFiles();
    if (!autoLoaded) { autoLoaded = true; loadAuto(); }
    // Rapporten lastes når undertabben åpnes
    setTimeout(() => { const rs = document.querySelector('#ledSubtabs .subtab[data-sub="rapport"]'); if (rs && rs.classList.contains("active")) loadRapport(); }, 50);
  });
  // Når man bytter undertab i Ledelse
  document.addEventListener("click", (e) => {
    const sub = e.target.closest('#ledSubtabs .subtab');
    if (sub && sub.dataset.sub === "rapport") loadRapport();
    if (e.target.id === "rapportReload") { rapportLoaded = false; loadRapport(); }
  });
})();
