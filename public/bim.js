// BIM-viewer på dashbordet. Bruker xeokit-sdk (ESM fra CDN) for visning av
// IFC-, glTF- og xkt-modeller. IFC parses i nettleseren med web-ifc (WASM)
// — ingenting sendes til OpenAI/Claude, kun lagring av filen på vår server.
//
// Viewer-instansen og loadere initialiseres lazy første gang fanen åpnes,
// så vi unngår å laste tunge biblioteker før de trengs.

const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

let viewer = null;
let xktLoader = null;
let gltfLoader = null;
let ifcLoader = null;
let currentModel = null;
let modelList = [];

const statusEl = () => document.getElementById("bimStatus");
const overlayEl = () => document.getElementById("bimOverlay");
function setStatus(msg, isError = false) {
  const el = statusEl();
  if (!el) return;
  el.innerHTML = msg ? `<span style="color:${isError ? 'var(--bad)' : 'var(--ink)'}">${esc(msg)}</span>` : "";
}
function showOverlay(show) {
  const o = overlayEl();
  if (o) o.hidden = !show;
}

async function ensureViewer() {
  if (viewer) return viewer;
  setStatus("Laster xeokit-sdk …");
  try {
    const xeokit = await import("https://cdn.jsdelivr.net/npm/@xeokit/xeokit-sdk@2.6.86/dist/xeokit-sdk.es.min.js");
    const Viewer = xeokit.Viewer;
    const XKTLoaderPlugin = xeokit.XKTLoaderPlugin;
    const GLTFLoaderPlugin = xeokit.GLTFLoaderPlugin;
    const WebIFCLoaderPlugin = xeokit.WebIFCLoaderPlugin;
    const TreeViewPlugin = xeokit.TreeViewPlugin;

    viewer = new Viewer({
      canvasId: "bimCanvas",
      transparent: true,
      saoEnabled: true,
    });
    viewer.scene.camera.eye = [10.45, 17.38, -98.31];
    viewer.scene.camera.look = [43.09, 0, -26.7];
    viewer.scene.camera.up = [0.06, 0.96, 0.16];
    viewer.cameraFlight.fitFOV = 35;

    xktLoader = new XKTLoaderPlugin(viewer);
    gltfLoader = new GLTFLoaderPlugin(viewer);

    try {
      // web-ifc CDN — laster WASM-modul ved bruk
      ifcLoader = new WebIFCLoaderPlugin(viewer, {
        wasmPath: "https://cdn.jsdelivr.net/npm/web-ifc@0.0.51/",
      });
    } catch (e) {
      // IFC-loader kan feile på eldre browsere; vi viser feilen ved første IFC-opplasting i stedet
      console.warn("WebIFCLoader init feilet:", e);
    }

    // Lag tre-struktur når en modell lastes
    try {
      const tree = new TreeViewPlugin(viewer, {
        containerElement: document.getElementById("bimTree"),
        autoExpandDepth: 1,
      });
      viewer.scene.on("modelLoaded", (modelId) => {
        try { tree.addModel(modelId); } catch {}
      });
    } catch {}

    // Klikk på objekt -> vis IFC-info
    viewer.scene.input.on("mouseclicked", (coords) => {
      const pickResult = viewer.scene.pick({ canvasPos: coords });
      const info = document.getElementById("bimInfo");
      if (!pickResult || !pickResult.entity) { info.innerHTML = ""; return; }
      const e = pickResult.entity;
      const meta = viewer.metaScene.metaObjects[e.id] || {};
      info.innerHTML = `
        <div class="bim-info-title">${esc(meta.name || e.id || "Element")}</div>
        ${meta.type ? `<div class="bim-info-row"><span>Type</span><b>${esc(meta.type)}</b></div>` : ""}
        ${meta.parent ? `<div class="bim-info-row"><span>Forelder</span><b>${esc((viewer.metaScene.metaObjects[meta.parent] || {}).name || meta.parent)}</b></div>` : ""}
        <div class="bim-info-row"><span>ID</span><code>${esc(e.id || "")}</code></div>
      `;
    });

    setStatus("");
    return viewer;
  } catch (e) {
    setStatus("Kunne ikke laste xeokit-sdk: " + e.message, true);
    throw e;
  }
}

async function loadModelFromUrl(url, name) {
  await ensureViewer();
  // Fjern eksisterende modell
  if (currentModel) {
    try { currentModel.destroy(); } catch {}
    currentModel = null;
  }
  const lower = url.toLowerCase();
  setStatus(`Laster modell: ${name} …`);
  showOverlay(false);
  try {
    if (lower.endsWith(".xkt")) {
      currentModel = xktLoader.load({ id: name, src: url, edges: true });
    } else if (lower.endsWith(".gltf") || lower.endsWith(".glb")) {
      currentModel = gltfLoader.load({ id: name, src: url, edges: true });
    } else if (lower.endsWith(".ifc")) {
      if (!ifcLoader) throw new Error("WebIFCLoader er ikke tilgjengelig i denne nettleseren.");
      currentModel = ifcLoader.load({ id: name, src: url, edges: true });
    } else {
      throw new Error("Ukjent format: " + url);
    }
    currentModel.on("loaded", () => {
      setStatus(`Modell lastet: ${name}`);
      document.getElementById("bimTitle").textContent = name;
      // Tilpass kamera
      viewer.cameraFlight.jumpTo({ aabb: viewer.scene.getAABB() });
    });
    currentModel.on("error", (err) => {
      setStatus("Kunne ikke laste modell: " + err, true);
      showOverlay(true);
    });
  } catch (e) {
    setStatus("Feil ved lasting: " + e.message, true);
    showOverlay(true);
  }
}

/* ============ MODELL-LISTE ============ */
async function refreshList() {
  try {
    const res = await fetch("/api/bim/models");
    if (!res.ok) throw new Error("Feil " + res.status);
    const d = await res.json();
    modelList = d.models || [];
    const sel = document.getElementById("bimSelect");
    if (!sel) return;
    sel.innerHTML = `<option value="">— velg modell —</option>` + modelList.map((m) => `
      <option value="${esc(m.url)}" data-name="${esc(m.name)}">${esc(m.name)} (${esc(m.sizeText)})</option>
    `).join("");
  } catch (e) {
    setStatus("Kunne ikke hente liste: " + e.message, true);
  }
}

async function uploadModel(file) {
  if (!file) return;
  if (file.size > 200 * 1024 * 1024) { setStatus("Filen er for stor (maks 200 MB).", true); return; }
  setStatus(`Laster opp ${file.name} (${(file.size / 1024 / 1024).toFixed(1)} MB) …`);
  const reader = new FileReader();
  reader.onload = async () => {
    try {
      const res = await fetch("/api/bim/upload", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ filename: file.name, dataUrl: reader.result }),
      });
      if (!res.ok) {
        const e = await res.json().catch(() => ({}));
        throw new Error(e.error || ("Feil " + res.status));
      }
      const d = await res.json();
      setStatus("Opplastet ✓ — laster modell …");
      await refreshList();
      // Velg den nye modellen automatisk
      const sel = document.getElementById("bimSelect");
      sel.value = d.url;
      loadModelFromUrl(d.url, file.name);
    } catch (e) { setStatus("Opplasting feilet: " + e.message, true); }
  };
  reader.onerror = () => setStatus("Kunne ikke lese filen.", true);
  reader.readAsDataURL(file);
}

async function deleteModel(url) {
  if (!url) return;
  if (!confirm("Slette denne modellen permanent fra serveren?")) return;
  try {
    const res = await fetch("/api/bim/delete", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url }),
    });
    if (!res.ok) throw new Error("Feil " + res.status);
    await refreshList();
    if (currentModel) { try { currentModel.destroy(); } catch {} currentModel = null; }
    document.getElementById("bimTitle").textContent = "Ingen modell lastet";
    showOverlay(true);
    setStatus("Modell slettet.");
  } catch (e) { setStatus("Kunne ikke slette: " + e.message, true); }
}

/* ============ EVENTS ============ */
let initOnce = false;
async function initBim() {
  if (initOnce) return;
  initOnce = true;
  await refreshList();
}

document.addEventListener("click", async (e) => {
  if (e.target.id === "bimUpload") { document.getElementById("bimFile").click(); return; }
  if (e.target.id === "bimReload") return refreshList();
  if (e.target.id === "bimDelete") {
    const sel = document.getElementById("bimSelect");
    return deleteModel(sel?.value);
  }
  if (e.target.id === "bimFit") {
    try { viewer && viewer.cameraFlight.flyTo({ aabb: viewer.scene.getAABB() }); } catch {}
    return;
  }
  if (e.target.id === "bimWire") {
    try {
      if (!viewer) return;
      const ents = Object.values(viewer.scene.objects);
      const allWire = ents.length > 0 && ents.every((x) => !x.edges || x._wireOn);
      ents.forEach((x) => { if (x.edges !== undefined) { x.edges = true; x.opacity = allWire ? 1 : 0.25; x._wireOn = !allWire; } });
    } catch {}
    return;
  }
  if (e.target.id === "bimReset") {
    if (currentModel) { try { currentModel.destroy(); } catch {} currentModel = null; }
    document.getElementById("bimTitle").textContent = "Ingen modell lastet";
    showOverlay(true);
    const sel = document.getElementById("bimSelect");
    if (sel) sel.value = "";
    setStatus("");
    return;
  }
});

document.addEventListener("change", (e) => {
  if (e.target.id === "bimFile") {
    const f = e.target.files?.[0];
    if (f) uploadModel(f);
    e.target.value = "";
    return;
  }
  if (e.target.id === "bimSelect") {
    const url = e.target.value;
    if (!url) {
      if (currentModel) { try { currentModel.destroy(); } catch {} currentModel = null; }
      document.getElementById("bimTitle").textContent = "Ingen modell lastet";
      showOverlay(true);
      return;
    }
    const opt = e.target.options[e.target.selectedIndex];
    loadModelFromUrl(url, opt?.dataset?.name || url.split("/").pop());
  }
});

// Sub-tab-bytte i Verktøy-panelet
document.addEventListener("click", (e) => {
  const btn = e.target.closest("#bimSubtabs .subtab");
  if (!btn || !btn.dataset.bsub) return;
  document.querySelectorAll("#bimSubtabs .subtab").forEach((b) => b.classList.toggle("active", b === btn));
  document.querySelectorAll("#panel-bim .bim-sub").forEach((v) => { v.hidden = true; v.classList.remove("active"); });
  const map = { viewer: "bsub-viewer", freecad: "bsub-freecad", qgis: "bsub-qgis", blender: "bsub-blender", ifcjs: "bsub-ifcjs", openfoam: "bsub-openfoam", proprietar: "bsub-proprietar" };
  const target = document.getElementById(map[btn.dataset.bsub]);
  if (target) { target.hidden = false; target.classList.add("active"); }
  if (btn.dataset.bsub === "viewer") initBim();
});

const tab = document.querySelector('.tab[data-tab="bim"]');
if (tab) tab.addEventListener("click", initBim);
