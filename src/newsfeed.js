// Henter siste nytt (RSS) fra norske aviser, server-side. Cachet i 15 min.
import { getConfig } from "./settings.js";

let cache = null, cacheTime = 0;
const TTL = 15 * 60 * 1000;

function clean(s) {
  return String(s || "")
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/<[^>]+>/g, "")
    .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"').replace(/&#039;|&apos;/g, "'").replace(/&nbsp;/g, " ")
    .trim();
}

function parseItems(xml, source) {
  const blocks = xml.match(/<item\b[\s\S]*?<\/item>/gi) || xml.match(/<entry\b[\s\S]*?<\/entry>/gi) || [];
  const out = [];
  for (const b of blocks.slice(0, 12)) {
    const title = clean((b.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [])[1]);
    let link = clean((b.match(/<link[^>]*>([\s\S]*?)<\/link>/i) || [])[1]);
    if (!link) link = (b.match(/<link[^>]*href="([^"]+)"/i) || [])[1] || "";
    const dateStr = clean((b.match(/<pubDate>([\s\S]*?)<\/pubDate>/i) || [])[1])
      || clean((b.match(/<updated>([\s\S]*?)<\/updated>/i) || [])[1])
      || clean((b.match(/<dc:date>([\s\S]*?)<\/dc:date>/i) || [])[1]);
    const ts = dateStr ? Date.parse(dateStr) : 0;
    if (title) out.push({ source, title, link, ts: isNaN(ts) ? 0 : ts });
  }
  return out;
}

async function fetchFeed(feed) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 7000);
  try {
    const res = await fetch(feed.url, {
      signal: ctrl.signal,
      headers: { "User-Agent": "ByggKonDashboard/1.0", Accept: "application/rss+xml, application/xml, text/xml, */*" },
    });
    if (!res.ok) return [];
    const xml = await res.text();
    return parseItems(xml, feed.name);
  } catch {
    return [];
  } finally {
    clearTimeout(t);
  }
}

export async function getNewsFeed() {
  const now = Date.now();
  if (cache && now - cacheTime < TTL) return cache;
  const feeds = getConfig().newsFeeds || [];
  const results = await Promise.all(feeds.map(fetchFeed));
  let items = results.flat().sort((a, b) => b.ts - a.ts).slice(0, 30);
  cache = items;
  cacheTime = now;
  return items;
}
