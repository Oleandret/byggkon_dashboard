// Vedvarende "siste kjente data"-snapshots.
// Gjør at sidene laster raskt (serverer siste snapshot innen TTL) og at de
// ikke faller over hvis Tripletex/MCP er nede – da vises siste kjente data
// med et "sist oppdatert"-stempel i stedet for en feilmelding.
import fs from "fs";
import path from "path";
import { SETTINGS_PATH } from "./settings.js";

const SNAP_PATH = path.join(path.dirname(SETTINGS_PATH), "snapshots.json");
let cache = null;

function loadAll() {
  if (cache) return cache;
  try { cache = JSON.parse(fs.readFileSync(SNAP_PATH, "utf8")) || {}; }
  catch { cache = {}; }
  return cache;
}
function persist() {
  try {
    fs.mkdirSync(path.dirname(SNAP_PATH), { recursive: true });
    fs.writeFileSync(SNAP_PATH, JSON.stringify(cache));
  } catch (e) { console.error("snapshot write:", e.message); }
}

export function getSnapshot(key) { return loadAll()[key] || null; }
export function saveSnapshot(key, data) { const a = loadAll(); a[key] = { savedAt: Date.now(), data }; persist(); }
// Marker alle snapshots som utløpt (manuell «Oppdater»). Beholder dataene som
// fallback, men tvinger ny bygging ved neste kall.
export function expireSnapshots() { const a = loadAll(); for (const k of Object.keys(a)) a[k].savedAt = 0; persist(); }

function withMeta(data, savedAt, stale, cached, error) {
  return { ...data, _snapshot: { savedAt: new Date(savedAt).toISOString(), stale: !!stale, cached: !!cached, error: error || null } };
}

// Serverer fra snapshot innen TTL (raskt – ingen ny bygging/MCP-kall). Ellers
// bygges ferske data; feiler det, faller vi tilbake til siste snapshot (stale).
export async function serveWithSnapshot(key, builder, ttlMs = 300000) {
  const snap = getSnapshot(key);
  const now = Date.now();
  if (snap && now - snap.savedAt < ttlMs) {
    return withMeta(snap.data, snap.savedAt, false, true);
  }
  try {
    const data = await builder();
    saveSnapshot(key, data);
    return withMeta(data, Date.now(), false, false);
  } catch (err) {
    if (snap) return withMeta(snap.data, snap.savedAt, true, true, err.message);
    throw err; // ingen snapshot å falle tilbake på ennå
  }
}

// Bakgrunnsjobb: kjør gitte builders periodisk og lagre snapshots.
// Gjør at "siste kjente data" alltid er friske når brukeren åpner dashbordet —
// brukeren ser data umiddelbart i stedet for å vente på MCP-kall.
let _warmTimer = null;
let _warming = false;
export function startBackgroundWarmer(builders, intervalMs = 10 * 60 * 1000) {
  // builders: { key: () => Promise<data>, ... }
  async function runOnce() {
    if (_warming) return;
    _warming = true;
    for (const [key, builder] of Object.entries(builders)) {
      try {
        const data = await builder();
        saveSnapshot(key, data);
        console.log("[warmer] ✓", key);
      } catch (e) {
        console.warn("[warmer] ✗", key, e.message);
      }
    }
    _warming = false;
  }
  if (_warmTimer) clearInterval(_warmTimer);
  // Første kjøring etter 30 sek (gi serveren tid til å starte), så hver intervalMs
  setTimeout(runOnce, 30 * 1000);
  _warmTimer = setInterval(runOnce, intervalMs);
  console.log("[warmer] startet — intervall " + Math.round(intervalMs / 60000) + " min, " + Object.keys(builders).length + " endepunkter");
}
