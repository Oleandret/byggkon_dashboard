// Værdata for Forus fra MET Norway (Yr) – gratis, ingen nøkkel.
// Krever en identifiserende User-Agent (MET sine vilkår).
let cache = null, cacheTime = 0;
const TTL = 30 * 60 * 1000; // 30 min

const SYM = {
  clearsky: "☀️", fair: "🌤️", partlycloudy: "⛅", cloudy: "☁️",
  rainshowers: "🌦️", rainshowersandthunder: "⛈️", rain: "🌧️", heavyrain: "🌧️",
  lightrain: "🌦️", lightrainshowers: "🌦️", heavyrainshowers: "🌧️",
  snow: "🌨️", snowshowers: "🌨️", sleet: "🌨️", fog: "🌫️", thunder: "⛈️",
};
function emoji(code) {
  if (!code) return "•";
  return SYM[code.split("_")[0]] || "☁️";
}

export async function getWeather() {
  const now = Date.now();
  if (cache && now - cacheTime < TTL) return cache;
  const lat = process.env.WEATHER_LAT || "58.886";
  const lon = process.env.WEATHER_LON || "5.715"; // Forus
  const res = await fetch(
    `https://api.met.no/weatherapi/locationforecast/2.0/compact?lat=${lat}&lon=${lon}`,
    { headers: { "User-Agent": "ByggKonDashboard/1.0 (oat@byggkon.no)" } }
  );
  if (!res.ok) throw new Error("met.no " + res.status);
  const j = await res.json();
  const ts = j.properties.timeseries;
  const cur = ts[0];
  const current = {
    temp: Math.round(cur.data.instant.details.air_temperature),
    symbol: emoji(cur.data.next_1_hours?.summary?.symbol_code || cur.data.next_6_hours?.summary?.symbol_code),
  };
  const byday = {};
  for (const t of ts) {
    const d = t.time.slice(0, 10);
    (byday[d] = byday[d] || []).push({
      h: t.time.slice(11, 13),
      temp: t.data.instant.details.air_temperature,
      sym: t.data.next_6_hours?.summary?.symbol_code,
    });
  }
  const WD = ["søn", "man", "tir", "ons", "tor", "fre", "lør"];
  const days = Object.keys(byday).sort().slice(0, 5).map((d, i) => {
    const arr = byday[d];
    const temps = arr.map((a) => a.temp);
    const mid = arr.find((a) => a.h === "12") || arr[Math.floor(arr.length / 2)];
    const dt = new Date(d + "T12:00:00");
    return {
      label: i === 0 ? "I dag" : WD[dt.getDay()],
      min: Math.round(Math.min(...temps)),
      max: Math.round(Math.max(...temps)),
      symbol: emoji(mid.sym),
    };
  });
  cache = { place: "Forus", current, days };
  cacheTime = now;
  return cache;
}
