// Kontaktpersoner – redigerbar liste (lås opp / lås).
(function () {
  const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  const grid = document.getElementById("konGrid");
  const editBtn = document.getElementById("konEdit");
  const addBtn = document.getElementById("konAdd");
  const saveBtn = document.getElementById("konSave");
  let contacts = [], editing = false, dirty = false, loaded = false;

  function err(msg) { const el = document.getElementById("errorBanner"); el.textContent = msg; el.hidden = false; setTimeout(() => (el.hidden = true), 8000); }

  function render() {
    grid.innerHTML = contacts.map((c, i) => {
      if (editing) {
        return `<div class="scaffold-card kon-edit" data-i="${i}">
          <input class="kon-f" data-f="name" value="${esc(c.name)}" placeholder="Navn" />
          <input class="kon-f" data-f="role" value="${esc(c.role)}" placeholder="Rolle" />
          <input class="kon-f" data-f="org" value="${esc(c.org)}" placeholder="Selskap" />
          <input class="kon-f" data-f="phone" value="${esc(c.phone)}" placeholder="Telefon" />
          <input class="kon-f" data-f="email" value="${esc(c.email)}" placeholder="E-post" />
          <input class="kon-f" data-f="note" value="${esc(c.note)}" placeholder="Notat" />
          <button class="btn-ghost kon-del">🗑 Fjern</button>
        </div>`;
      }
      return `<div class="scaffold-card">
        <div class="sc-title">${esc(c.name)}</div>
        ${c.role ? `<div class="sc-sub">${esc(c.role)}</div>` : ""}
        <div class="sc-note">
          ${c.org ? `<div>🏢 ${esc(c.org)}</div>` : ""}
          ${c.phone ? `<div>📞 ${esc(c.phone)}</div>` : ""}
          ${c.email ? `<div>✉️ <a href="mailto:${esc(c.email)}">${esc(c.email)}</a></div>` : ""}
          ${c.note ? `<div style="margin-top:6px">${esc(c.note)}</div>` : ""}
        </div>
      </div>`;
    }).join("") || `<div class="empty">Ingen kontakter ennå.</div>`;
  }

  grid.addEventListener("input", (e) => {
    const card = e.target.closest(".kon-edit"); if (!card || !e.target.dataset.f) return;
    contacts[Number(card.dataset.i)][e.target.dataset.f] = e.target.value; dirty = true;
  });
  grid.addEventListener("click", (e) => {
    if (!e.target.classList.contains("kon-del")) return;
    const i = Number(e.target.closest(".kon-edit").dataset.i);
    contacts.splice(i, 1); dirty = true; render();
  });

  function setEditing(on) {
    editing = on;
    editBtn.textContent = on ? "🔒 Lås" : "🔓 Lås opp";
    addBtn.hidden = !on; saveBtn.hidden = !on;
    render();
  }
  editBtn.addEventListener("click", () => setEditing(!editing));
  addBtn.addEventListener("click", () => { contacts.push({ name: "", role: "", org: "", phone: "", email: "", note: "" }); dirty = true; render(); });

  saveBtn.addEventListener("click", async () => {
    saveBtn.disabled = true;
    try {
      const res = await fetch("/api/contacts", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ contacts }) });
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || "Lagring feilet");
      dirty = false; saveBtn.textContent = "Lagret ✓"; setTimeout(() => (saveBtn.textContent = "Lagre"), 2000);
    } catch (e2) { err("Kunne ikke lagre: " + e2.message); }
    finally { saveBtn.disabled = false; }
  });

  async function loadContacts() {
    if (loaded) return;
    try {
      const res = await fetch("/api/contacts");
      if (res.status === 401) { location.href = "/login"; return; }
      const d = await res.json();
      contacts = (d.contacts || []).map((c) => ({ ...c }));
      loaded = true; render();
    } catch (e2) { err("Kunne ikke hente kontakter: " + e2.message); }
  }

  // ---- Tripletex-kontakter (kunder), alfabetisk ----
  let ttList = [], ttLoaded = false;
  const ttSearch = document.getElementById("ttSearch");
  function renderTt() {
    const q = (ttSearch.value || "").toLowerCase().trim();
    const rows = ttList.filter((c) => !q || c.name.toLowerCase().includes(q));
    const t = document.getElementById("ttContacts");
    if (!rows.length) { t.innerHTML = `<tbody><tr><td class="empty">Ingen treff.</td></tr></tbody>`; return; }
    t.innerHTML = `<thead><tr><th>Kunde</th><th>E-post</th><th>Telefon</th></tr></thead><tbody>${
      rows.map((c) => `<tr><td>${esc(c.name)}</td><td>${c.email ? `<a href="mailto:${esc(c.email)}">${esc(c.email)}</a>` : "—"}</td><td>${esc(c.phone || "—")}</td></tr>`).join("")
    }</tbody>`;
  }
  if (ttSearch) ttSearch.addEventListener("input", renderTt);
  async function loadTt() {
    if (ttLoaded) return;
    const status = document.getElementById("ttStatus");
    try {
      const res = await fetch("/api/tripletex-contacts");
      if (res.status === 401) { location.href = "/login"; return; }
      if (!res.ok) throw new Error("Feil " + res.status);
      const d = await res.json();
      ttList = d.contacts || []; ttLoaded = true; status.hidden = true; renderTt();
    } catch (e2) { status.hidden = false; status.textContent = "Kunne ikke hente Tripletex-kontakter: " + e2.message; }
  }

  window.addEventListener("beforeunload", (e) => { if (editing && dirty) { e.preventDefault(); e.returnValue = ""; } });
  const tab = document.querySelector('.tab[data-tab="kontakter"]');
  if (tab) tab.addEventListener("click", () => { loadContacts(); loadTt(); });
})();
