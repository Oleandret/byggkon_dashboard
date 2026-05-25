// Markedsføring – redigerbar strategitekst.
(function () {
  const ta = document.getElementById("mktText");
  const eb = document.getElementById("mktEdit");
  const sb = document.getElementById("mktSave");
  if (!ta) return;
  let loaded = false;
  function err(m) { const el = document.getElementById("errorBanner"); el.textContent = m; el.hidden = false; setTimeout(() => (el.hidden = true), 8000); }

  eb.addEventListener("click", () => {
    const on = ta.disabled;
    ta.disabled = !on; eb.textContent = on ? "🔒 Lås" : "🔓 Lås opp"; sb.hidden = !on;
    if (on) ta.focus();
  });
  sb.addEventListener("click", async () => {
    sb.disabled = true;
    try {
      const res = await fetch("/api/marketing", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ marketing: ta.value }) });
      if (!res.ok) throw new Error("Lagring feilet");
      sb.textContent = "Lagret ✓"; setTimeout(() => (sb.textContent = "Lagre"), 2000);
      ta.disabled = true; eb.textContent = "🔓 Lås opp"; sb.hidden = true;
    } catch (e) { err("Kunne ikke lagre: " + e.message); } finally { sb.disabled = false; }
  });
  async function load() {
    if (loaded) return;
    try { const d = await (await fetch("/api/marketing")).json(); ta.value = d.marketing || ""; loaded = true; }
    catch { /* ignore */ }
  }
  const tab = document.querySelector('.tab[data-tab="markedsforing"]');
  if (tab) tab.addEventListener("click", load);
})();
