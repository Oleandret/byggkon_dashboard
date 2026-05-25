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
