// Sosiale medier-postingsstasjon: kopier tekst til utklippstavla og åpne
// plattformens postingsside. Ekte API-posting krever app-godkjenning hos
// Facebook/LinkedIn – legges på senere hvis ønskelig.
(function () {
  function flash(elId, msg) { const el = document.getElementById(elId); if (!el) return; el.textContent = msg; setTimeout(() => (el.textContent = ""), 4000); }
  async function copy(text) {
    try { await navigator.clipboard.writeText(text); return true; }
    catch { try { const ta = document.createElement("textarea"); ta.value = text; document.body.appendChild(ta); ta.select(); document.execCommand("copy"); ta.remove(); return true; } catch { return false; } }
  }
  document.querySelectorAll("[data-social-copy]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const ta = document.getElementById(btn.dataset.socialCopy);
      if (!ta) return;
      const text = (ta.value || "").trim();
      const platform = btn.dataset.socialCopy === "fbText" ? "Facebook" : "LinkedIn";
      const msgId = btn.dataset.socialCopy === "fbText" ? "fbMsg" : "liMsg";
      if (!text) { flash(msgId, "Skriv noe først."); return; }
      const ok = await copy(text);
      flash(msgId, ok ? `✓ Kopiert – åpne ${platform} og lim inn.` : `Kunne ikke kopiere. Marker teksten og kopier manuelt.`);
    });
  });
})();
