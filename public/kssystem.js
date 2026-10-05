/* KS-systemet som fane. KS kjører som egen app og speiles under /ks, slik at
   den deler opphav og sesjon med dashbordet. */
(function () {
  const knapp = document.getElementById("tabKsSystem");
  const ramme = document.getElementById("ksFrame");
  if (!knapp || !ramme) return;

  // Rammen skal fylle alt under topbaren. Høyden måles i stedet for å gjettes,
  // fordi topbaren brytes over to linjer på smale skjermer.
  const settHoyde = () => {
    const topbar = document.querySelector(".topbar");
    // 0 betyr at layouten ikke er klar ennå; da er et anslag bedre enn full høyde.
    document.documentElement.style.setProperty("--topbar-h", `${topbar?.offsetHeight || 68}px`);
  };
  settHoyde();
  window.addEventListener("resize", settHoyde);

  let lastet = false;
  knapp.addEventListener("click", () => {
    if (lastet) return;
    lastet = true;
    ramme.src = "/ks/";
  });

  fetch("/api/ks/status")
    .then((r) => (r.ok ? r.json() : null))
    .then((d) => { if (d && d.klar) knapp.hidden = false; })
    .catch(() => {});
})();
