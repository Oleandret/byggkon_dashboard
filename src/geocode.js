// Enkel geokoding mot OpenStreetMap Nominatim (ingen API-nøkkel).
// Brukes til å plassere prosjekter på kartet i driftssentralen.
// NB: Nominatim ber om maks ~1 forespørsel/sek og en gyldig User-Agent.

const UA = "ByggKon-Dashboard/1.0 (post@byggkon.no)";

// Viewbox som dekker Vestlandet (Rogaland, Vestland, Møre) – brukes for å
// vekte treff mot vestlandskysten der Bygg-Kon stort sett jobber.
// Format: lon_venstre,lat_topp,lon_høyre,lat_bunn
const VESTLAND_VIEWBOX = "4.3,63.2,8.4,58.0";

async function nominatim(q, bounded) {
  const url = "https://nominatim.openstreetmap.org/search?format=json&limit=1&countrycodes=no"
    + "&viewbox=" + encodeURIComponent(VESTLAND_VIEWBOX)
    + (bounded ? "&bounded=1" : "")
    + "&q=" + encodeURIComponent(q);
  const res = await fetch(url, { headers: { "User-Agent": UA, "Accept-Language": "nb,no,en" } });
  if (!res.ok) return null;
  const data = await res.json();
  if (Array.isArray(data) && data.length) {
    const lat = Number(data[0].lat), lon = Number(data[0].lon);
    if (Number.isFinite(lat) && Number.isFinite(lon)) return { lat, lon };
  }
  return null;
}

export async function geocodeOne(query) {
  const q = String(query || "").trim();
  if (!q) return null;
  try {
    // Først: begrenset til Vestlandet (mest sannsynlig riktig). Faller tilbake til hele Norge.
    const hit = await nominatim(q, true);
    if (hit) return hit;
    await sleep(1100); // vær snill mot Nominatim
    return await nominatim(q, false);
  } catch {
    return null;
  }
}

export function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }
