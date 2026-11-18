// Official warnings, refreshed every 20 minutes by a Cron Trigger (same logic as data/fetch.py and data/build.py).
// Met Office, Meteoalarm, Environment Agency floods and UKHSA health alerts, limited to this site's countries.
import { DEPOTS } from "./depots.js";

export const REGION = {
  asg: ["UK", "IT", "NL", "BE", "LU", "CH", "ME", "SA"],
  uk: ["UK"],
  europe: ["IT", "NL", "BE", "LU", "CH"],
  me: ["ME", "SA"],
};
const FEEDS = { IT: ["italy"], CH: ["switzerland"], NL: ["netherlands"], BE: ["belgium"], LU: ["luxembourg", "belgium"] };
const SRC = (c) => (c === "UK" ? "Met Office" : "Meteoalarm");
const UA = { "User-Agent": "AndrewsSykesWeatherDashboard/1.0" };
const MON = { Jan: 1, Feb: 2, Mar: 3, Apr: 4, May: 5, Jun: 6, Jul: 7, Aug: 8, Sep: 9, Oct: 10, Nov: 11, Dec: 12 };
const pad = (n) => String(n).padStart(2, "0");

// London local time as "YYYY-MM-DDTHH:MM" (same format as the daily build)
const FMT = new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/London", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
export function london(d = new Date()) {
  const p = Object.fromEntries(FMT.formatToParts(d).map((x) => [x.type, x.value]));
  return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}`;
}
const minutes = (loc) => Date.parse(loc + ":00Z") / 60000; // compare London-local strings
function pretty(loc) { // "23:59 Thu 19 Nov"
  const [d, t] = loc.split("T");
  const dt = new Date(d + "T12:00:00Z");
  return `${t} ${dt.toLocaleDateString("en-GB", { weekday: "short", timeZone: "UTC" })} ${+d.slice(8)} ${dt.toLocaleDateString("en-GB", { month: "short", timeZone: "UTC" })}`;
}
async function get(url, json = false) {
  const r = await fetch(url, { headers: UA, cf: { cacheTtl: 0 } });
  if (!r.ok) throw new Error(`${r.status} ${url.slice(0, 80)}`);
  return json ? r.json() : r.text();
}
const tag = (s, k) => { const a = s.indexOf(`<${k}>`); if (a < 0) return ""; const b = s.indexOf(`</${k}>`, a); return b < 0 ? "" : s.slice(a + k.length + 2, b).trim(); };
function* blocks(s, k) { let i = 0; for (;;) { const a = s.indexOf(`<${k}>`, i); if (a < 0) return; const b = s.indexOf(`</${k}>`, a); if (b < 0) return; yield s.slice(a, b); i = b; } }

async function metoffice(nowLoc) {
  const x = await get("https://www.metoffice.gov.uk/public/data/PWSCache/WarningsRSS/Region/UK");
  const out = [];
  for (const item of blocks(x, "item")) {
    const g = (k) => tag(item, k).replace(/<!\[CDATA\[|\]\]>/g, "").trim();
    const title = g("title"), desc = g("description");
    const m = title.match(/(Yellow|Amber|Red) warning of (.+?) affecting (.+)/i);
    if (!m) continue;
    const v = desc.match(/valid from (\d{4}) \w+ (\d+) (\w+) to (\d{4}) \w+ (\d+) (\w+)/);
    const when = (hhmm, day, mon) => {
      const y0 = +nowLoc.slice(0, 4);
      for (const y of [y0, y0 + 1, y0 - 1]) {
        if (!MON[mon]) return "";
        const loc = `${y}-${pad(MON[mon])}-${pad(day)}T${hhmm.slice(0, 2)}:${hhmm.slice(2)}`;
        if (Math.abs(minutes(loc) - minutes(nowLoc)) < 200 * 1440) return loc;
      }
      return "";
    };
    const start = v ? when(v[1], v[2], v[3]) : "", end = v ? when(v[4], v[5], v[6]) : "";
    const areas = desc.includes(":") ? desc.split(":").slice(1).join(":").split(" valid from")[0].trim() : "";
    out.push({ country: "UK", source: "Met Office", level: m[1].toLowerCase(), type: m[2].toLowerCase().replace(/ and /g, ", "),
      region: m[3].replace(/&amp;/g, "&").trim(), areas: areas.replace(/&amp;/g, "&"), start, end });
  }
  return out;
}

async function meteoalarm(countries) {
  const res = [], cache = {};
  for (const c of countries) {
    if (!FEEDS[c]) continue;
    const regions = new Set(DEPOTS.filter((d) => d.country === c).flatMap((d) => (Array.isArray(d.mo) ? d.mo : [d.mo])));
    if (!regions.size) continue;
    for (const feed of FEEDS[c]) {
      cache[feed] = cache[feed] || (await get(`https://feeds.meteoalarm.org/feeds/meteoalarm-legacy-atom-${feed}`));
      for (const e of blocks(cache[feed], "entry")) {
        const area = tag(e, "cap:areaDesc");
        if (!regions.has(area)) continue;
        const ev = tag(e, "cap:event"), sev = tag(e, "cap:severity"), evl = ev.toLowerCase();
        const lvl = evl.includes("red") ? "red" : evl.includes("orange") || evl.includes("amber") ? "amber" : evl.includes("yellow") ? "yellow" : ({ Extreme: "red", Severe: "amber" }[sev] || "yellow");
        const typ = ev.replace(/\b(yellow|orange|amber|red|warning|alert|for|of)\b/gi, " ").replace(/\s+/g, " ").trim().toLowerCase() || "weather";
        const conv = (s) => (s ? london(new Date(s)) : "");
        res.push({ country: c, source: "Meteoalarm", level: lvl, type: typ, region: area, areas: area, start: conv(tag(e, "cap:onset")), end: conv(tag(e, "cap:expires")) });
      }
    }
  }
  const seen = new Set();
  return res.filter((w) => { const k = [w.country, w.level, w.type, w.region, w.start, w.end].join("|"); if (seen.has(k)) return false; seen.add(k); return true; });
}

async function floods(depots) {
  const res = {};
  await Promise.all(depots.filter((d) => d.country === "UK" && d.nation === "England").map(async (d) => {
    const j = await get(`https://environment.data.gov.uk/flood-monitoring/id/floods?lat=${d.lat}&long=${d.lon}&dist=15`, true);
    const items = (j.items || []).filter((i) => [1, 2, 3].includes(i.severityLevel));
    if (items.length) res[d.slug] = items.map((i) => ({ level: i.severityLevel, severity: i.severity || "", area: i.description || i.eaAreaName || "", changed: i.timeSeverityChanged || "" }));
  }));
  return res;
}

async function ukhsa() {
  const out = {};
  for (const kind of ["cold", "heat"]) {
    const j = await get(`https://ukhsa-dashboard.data.gov.uk/api/proxy/alerts/v1/${kind}`, true);
    out[kind] = Object.fromEntries(j.map((r) => [r.geography_name, r.status]));
  }
  return out;
}

// Turn feeds into the same warnings list and official flags the daily build makes.
function derive(cs, warnings, fl, uk, nowLoc) {
  const depots = DEPOTS.filter((d) => cs.includes(d.country));
  const today = nowLoc.slice(0, 10), alerts = [];
  const add = (d, date, rule, type, label, level, detail) =>
    alerts.push({ depot: d.slug, date, rule, type, label, level, sev: level, outlook: false, detail, official: true });
  const mos = (d) => (Array.isArray(d.mo) ? d.mo : [d.mo]);
  for (const w of warnings) {
    const end = w.end || nowLoc;
    w.expired = minutes(end) < minutes(nowLoc);
    w.depots = depots.filter((d) => d.country === w.country && mos(d).includes(w.region))
      .map((d) => ({ slug: d.slug, named: (w.areas || "").toLowerCase().includes((d.area || "").toLowerCase()) || mos(d).includes(w.region) }));
    if (w.expired || w.type.includes("fog")) continue;
    const start = w.start ? w.start.slice(0, 10) : today;
    const day = start > today ? start : today;
    for (const x of w.depots) if (x.named) {
      add(DEPOTS.find((d) => d.slug === x.slug), day, "warn_" + w.type.replace(/[^A-Za-z0-9]/g, "_"), "Official",
        `${w.level[0].toUpperCase()}${w.level.slice(1)} warning: ${w.type}`, ["amber", "red"].includes(w.level) ? "alert" : "watch",
        `${SRC(w.country)}, ${w.region}, until ${pretty(end)} (London time)`);
    }
  }
  for (const [slug, items] of Object.entries(fl || {})) {
    const d = depots.find((x) => x.slug === slug); if (!d) continue;
    const worst = Math.min(...items.map((i) => i.level));
    const names = [...new Set(items.map((i) => i.area))].sort().join("; ").slice(0, 180);
    add(d, today, `flood_${worst}`, "Flood", { 1: "Severe flood warning", 2: "Flood warning", 3: "Flood alert" }[worst], worst <= 2 ? "alert" : "watch", `Environment Agency, within 15 km: ${names}`);
  }
  for (const kind of ["cold", "heat"]) for (const d of depots) {
    const status = ((uk || {})[kind] || {})[d.ons_region || ""] || "Green";
    if (["Yellow", "Amber", "Red"].includes(status))
      add(d, today, `ukhsa_${kind}`, "Health", `${status} ${kind}-health alert`, ["Amber", "Red"].includes(status) ? "alert" : "watch", `UKHSA, ${d.ons_region}`);
  }
  alerts.sort((a, b) => a.date.localeCompare(b.date) || (a.level !== "alert") - (b.level !== "alert") || a.type.localeCompare(b.type) || a.depot.localeCompare(b.depot));
  return alerts;
}

const store = (env) => env.LIMITER.get(env.LIMITER.idFromName(`live|${env.SITE}`));
export async function readLive(env) {
  if (!env.LIMITER) return null;
  return (await store(env).fetch("https://limiter/live-get")).json();
}

export async function refresh(env) {
  const cs = REGION[env.SITE] || [];
  const nowLoc = london();
  const prev = (await readLive(env)) || {};
  const errors = [];
  const safe = async (name, fn, fallback) => { try { return await fn(); } catch (e) { errors.push(`${name}: ${e.message}`); return fallback; } };
  let warnings = [];
  if (cs.includes("UK")) warnings = warnings.concat(await safe("Met Office", () => metoffice(nowLoc), null) || prev.warnings?.filter((w) => w.country === "UK") || []);
  if (cs.some((c) => FEEDS[c])) warnings = warnings.concat(await safe("Meteoalarm", () => meteoalarm(cs), null) || prev.warnings?.filter((w) => w.country !== "UK") || []);
  const fl = cs.includes("UK") ? await safe("Environment Agency", () => floods(DEPOTS.filter((d) => cs.includes(d.country))), prev.floods || {}) : {};
  const uk = cs.includes("UK") ? await safe("UKHSA", ukhsa, prev.ukhsa || {}) : {};
  const alerts = derive(cs, warnings, fl, uk, nowLoc);
  const data = { fetched: nowLoc, site: env.SITE, warnings, floods: fl, ukhsa: uk, alerts, errors };
  await store(env).fetch("https://limiter/live-put", { method: "POST", body: JSON.stringify(data) });
  return data;
}
