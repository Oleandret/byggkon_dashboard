// Markedsføring: løpende kontaktliste fra Tripletex (+Loki når koblet), nedlastbar som CSV.
(function () {
  const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  const tbl = document.getElementById("mcTable");
  if (!tbl) return;
  let contacts = [], loaded = false;

  function render() {
    if (!contacts.length) { tbl.innerHTML = `<tbody><tr><td class="empty">Ingen kontakter funnet.</td></tr></tbody>`; return; }
    const head = `<thead><tr><th>Navn</th><th>E-post</th><th>Faktura-e-post</th><th>Telefon</th><th>Kilde</th></tr></thead>`;
    const body = contacts.map((c) => `<tr><td>${esc(c.navn)}</td><td>${esc(c.epost) || "—"}</td><td>${esc(c.fakturaEpost) || "—"}</td><td>${esc(c.telefon) || "—"}</td><td>${esc(c.kilde)}</td></tr>`).join("");
    tbl.innerHTML = head + `<tbody>${body}</tbody>`;
  }

  function toCsv() {
    const cols = ["navn", "epost", "fakturaEpost", "telefon", "kilde"];
    const headers = ["Navn", "E-post", "Faktura-e-post", "Telefon", "Kilde"];
    const escCsv = (v) => `"${String(v ?? "").replace(/"/g, '""')}"`;
    const lines = [headers.map(escCsv).join(";")];
    contacts.forEach((c) => lines.push(cols.map((k) => escCsv(c[k])).join(";")));
    return "﻿" + lines.join("\r\n"); // BOM for Excel/æøå
  }
  document.getElementById("mcDownload").addEventListener("click", () => {
    const blob = new Blob([toCsv()], { type: "text/csv;charset=utf-8" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `byggkon-kontakter-${new Date().toISOString().slice(0, 10)}.csv`;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  });

  async function load() {
    if (loaded) return; loaded = true;
    const status = document.getElementById("mcStatus");
    try {
      const res = await fetch("/api/marketing-contacts");
      if (res.status === 401) { location.href = "/login"; return; }
      if (!res.ok) { const e = await res.json().catch(() => ({})); throw new Error(e.error || `Feil ${res.status}`); }
      const d = await res.json();
      contacts = d.contacts || [];
      if (status) status.hidden = true;
      const note = document.getElementById("mcNote");
      if (note) note.textContent = `${contacts.length} kontakter fra Tripletex. ${d.lokiConfigured ? "Loki er koblet – flere kilder kan kobles på." : "Loki er ikke koblet ennå (legg til i Innstillinger → MCP for flere kilder)."}`;
      render();
    } catch (e2) { if (status) { status.hidden = false; status.textContent = "Kunne ikke hente kontakter: " + e2.message; } loaded = false; }
  }
  const tab = document.querySelector('.tab[data-tab="markedsforing"]');
  if (tab) tab.addEventListener("click", load);
})();
