// Sosiale medier-postingsstasjon: kopier tekst til utklippstavla, last ned bilde
// for vedlegg, og åpne plattformene klar til innliming. Ekte direktepublisering
// krever OAuth-oppsett hos Meta + LinkedIn.
(function () {
  const FB_URL = "https://www.facebook.com/byggkon";
  const LI_URL = "https://www.linkedin.com/company/bygg-kon/admin/page-posts/published/";
  const msgEl = document.getElementById("socMsg");
  const ta = document.getElementById("socText");
  if (!ta) return;
  function flash(t) { if (msgEl) { msgEl.textContent = t; setTimeout(() => (msgEl.textContent = ""), 5000); } }
  async function copy(text) {
    try { await navigator.clipboard.writeText(text); return true; }
    catch {
      try { const x = document.createElement("textarea"); x.value = text; document.body.appendChild(x); x.select(); document.execCommand("copy"); x.remove(); return true; }
      catch { return false; }
    }
  }

  // Bildevedlegg: vis preview + tilby nedlasting (drag/last opp i Facebook/LinkedIn etterpå).
  const fileEl = document.getElementById("socImage");
  const prev = document.getElementById("socImagePreview");
  const dlBtn = document.getElementById("socImageDownload");
  let imgUrl = null, imgName = "byggkon-innlegg.png";
  if (fileEl) fileEl.addEventListener("change", () => {
    const f = fileEl.files[0]; if (!f) { prev.hidden = true; dlBtn.hidden = true; imgUrl = null; return; }
    if (imgUrl) URL.revokeObjectURL(imgUrl);
    imgUrl = URL.createObjectURL(f); imgName = f.name || imgName;
    prev.src = imgUrl; prev.hidden = false; dlBtn.hidden = false;
  });
  if (dlBtn) dlBtn.addEventListener("click", () => {
    if (!imgUrl) return;
    const a = document.createElement("a"); a.href = imgUrl; a.download = imgName; document.body.appendChild(a); a.click(); a.remove();
  });

  async function post(toFb, toLi) {
    const text = (ta.value || "").trim();
    if (!text && !imgUrl) { flash("Skriv noe eller velg et bilde først."); return; }
    let copied = true;
    if (text) copied = await copy(text);
    if (imgUrl && dlBtn) dlBtn.focus(); // minne om bildet
    if (toFb) window.open(FB_URL, "_blank", "noopener");
    if (toLi) window.open(LI_URL, "_blank", "noopener");
    const where = toFb && toLi ? "Facebook og LinkedIn" : toFb ? "Facebook" : "LinkedIn";
    flash((copied ? "✓ Tekst kopiert. " : "Kunne ikke kopiere – marker og kopier manuelt. ") +
      `${where} åpnet.` + (imgUrl ? " Husk å laste opp bildet (klikk «Last ned bilde» og dra inn).": ""));
  }
  document.getElementById("socPostBoth").addEventListener("click", () => post(true, true));
  document.getElementById("socPostFb").addEventListener("click", () => post(true, false));
  document.getElementById("socPostLi").addEventListener("click", () => post(false, true));
})();
