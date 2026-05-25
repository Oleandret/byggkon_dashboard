// Enkel geokoding mot OpenStreetMap Nominatim (ingen API-nøkkel).
// Brukes til å plassere prosjekter på kartet i driftssentralen.
// NB: Nominatim ber om maks ~1 forespørsel/sek og en gyldig User-Agent.

const UA = "ByggKon-Dashboard/1.0 (post@byggkon.no)";

export async function geocodeOne(query) {
  const q = String(query || "").trim();
  if (!q) return null;
  const url = "https://nominatim.openstreetmap.org/search?format=json&limit=1&countrycodes=no&q=" + encodeURIComponent(q);
  try {
    const res = await fetch(url, { headers: { "User-Agent": UA, "Accept-Language": "nb,no,en" } });
    if (!res.ok) return null;
    const data = await res.json();
    if (Array.isArray(data) && data.length) {
      const lat = Number(data[0].lat), lon = Number(data[0].lon);
      if (Number.isFinite(lat) && Number.isFinite(lon)) return { lat, lon };
    }
    return null;
  } catch {
    return null;
  }
}

export function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }
