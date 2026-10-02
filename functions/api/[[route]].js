// ============================================================
// Kulturhusprogram – Cloudflare PAGES FUNCTION
// Ligger i samma projekt som index.html och exponeras på samma
// domän (t.ex. https://din-sida.pages.dev/api/events).
//
// Installation:
//   1. Filen ska ligga som: functions/api/[[route]].js
//   2. Lägg till Jina-nyckeln i Pages-dashboarden:
//      Settings → Environment variables →
//        JINA_API_KEY = <din hemliga nyckel>
//   3. Deploya om Pages-projektet (push till repot räcker)
//
// Endpoints:
//   /api/events         – JSON med alla evenemang (cache 6 h)
//   /api/events?refresh=1 – tvinga fram färsk hämtning
//   /api/debug          – felsökningsinfo per källa
// ============================================================

// ---------- Konfiguration ----------
const CACHE_TTL_MS = 6 * 60 * 60 * 1000; // 6 timmar
const FETCH_TIMEOUT_MS = 15000;
const HEADERS = {
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36",
  "Accept": "text/html,application/xhtml+xml",
  "Accept-Language": "sv-SE,sv;q=0.9",
};

const SOURCES = {
  gbg: "https://goteborg.se/wps/portal/start/uppleva-och-gora/kultur/kulturhus/program-pa-kulturhusen",
  mh: "https://www.musikenshus.se/kalender/",
  hop: "https://houseofpossibilitas.se/evenemang/",
  mollan: "https://kulturhusetmollan.se/evenemang/",
  kungalv: "https://www.kungalv.se/kultur--fritid/evenemang-kungalv/",
  partille: "https://www.partille.se/uppleva--gora/evenemang/",
  kungsbacka: "https://bibliotek.kungsbacka.se/evenemang",
};

// ---------- Modul-global cache (per isolate) ----------
let CACHE = { ts: 0, data: [] };
let ENV = {};

function setEnv(env) {
  ENV = env || {};
  if (!ENV.JINA_API_KEY) ENV.JINA_API_KEY = "";
}

// ============================================================
// Verktyg: HTML -> markdown-lik text, länkextraktion
// ============================================================
function htmlToMd(html) {
  return String(html)
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|li|tr|h[1-6]|section|article)>/gi, "\n")
    .replace(/<h1[^>]*>/gi, "\n# ")
    .replace(/<h2[^>]*>/gi, "\n## ")
    .replace(/<h3[^>]*>/gi, "\n### ")
    .replace(/<h4[^>]*>/gi, "\n#### ")
    .replace(/<li[^>]*>/gi, "\n- ")
    .replace(/<td[^>]*>/gi, " | ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&aring;/g, "å").replace(/&Aring;/g, "Å")
    .replace(/&auml;/g, "ä").replace(/&Auml;/g, "Ä")
    .replace(/&ouml;/g, "ö").replace(/&Ouml;/g, "Ö")
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/[ \t]+/g, " ")
    .replace(/\n\s+/g, "\n")
    .trim();
}

function extractAnchors(html) {
  const map = new Map();
  const re = /<a[^>]+href="([^"#]+)"[^>]*>([\s\S]*?)<\/a>/gi;
  let m;
  while ((m = re.exec(html))) {
    const text = htmlToMd(m[2]).trim();
    if (text.length > 2 && text.length < 120 && !map.has(text)) map.set(text, m[1]);
  }
  return map;
}

function safeLink(u) {
  return /^https?:\/\//i.test(String(u || "")) ? u : null;
}

// ============================================================
// Hämtning: Jina för goteborg.se (JS-renderad), direkt annars
// ============================================================
async function fetchPage(url) {
  const useJina = /goteborg\.se/.test(url);
  const target = useJina && ENV.JINA_API_KEY
    ? "https://r.jina.ai/" + url
    : url;
  const headers = { ...HEADERS };
  if (useJina && ENV.JINA_API_KEY) headers["Authorization"] = "Bearer " + ENV.JINA_API_KEY;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(target, { headers, signal: ctrl.signal, redirect: "follow" });
    if (!res.ok) throw new Error("HTTP " + res.status);
    const text = await res.text();
    return text;
  } finally {
    clearTimeout(timer);
  }
}

async function parseSource(url, parseFn) {
  const html = await fetchPage(url);
  return parseFn(html);
}

// ============================================================
// Kategorisering
// ============================================================
const CATEGORY_RULES = [
  ["musik", /\b(musik|konsert|kö?r\b|sång|gitarr|piano|band|orkester|jazz|hip hop|opera|musikkafé|open mic|trumpet|trummor|fiol|violin|synt|rap|blues|dj\b|dubbing)/i],
  ["dans", /\b(dans|afro\/jazz|linedance|balett|zumba)/i],
  ["utstallning", /\b(utställning|videoinstallation|visning|konst|ateljé)/i],
  ["film", /\b(film|bio|dokumentär)/i],
  ["forelasning", /\b(föreläsning|föredrag|samtal|debatt|berättar|poesi)/i],
  ["workshop", /\b(workshop|kurs|utbildning|skriv|måla|modellera|lera|virka|handarbete|läxa)/i],
  ["teater", /\b(teater|föreställning|scen|cirkus)/i],
  ["barnfamilj", /\b(barn|familj|ung\b|lov\b|familje)/i],
  ["schack", /\b(schack|rollspel|brädspel|spelkväll)/i],
];
function categorize(item) {
  const t = (item.title + " " + (item.desc || "")).toLowerCase();
  for (const [id, re] of CATEGORY_RULES) if (re.test(item.title) || re.test(t)) return id;
  return "ovrigt";
}

function findLink(anchorMap, title, source) {
  if (anchorMap && anchorMap.size) {
    const norm = (s) => s.toLowerCase().replace(/\s+/g, " ").trim();
    let best = null;
    for (const [k, v] of anchorMap) {
      if (norm(k) === norm(title)) return safeLink(v);
      if (norm(k).includes(norm(title)) || norm(title).includes(norm(k))) best = best || v;
    }
    if (best) return safeLink(best);
  }
  if (source === "musikenshus.se") return "https://www.musikenshus.se/?s=" + encodeURIComponent(title);
  if (source === "houseofpossibilitas.se") return "https://houseofpossibilitas.se/?s=" + encodeURIComponent(title);
  if (source === "kulturhusetmollan.se") return "https://kulturhusetmollan.se/?s=" + encodeURIComponent(title);
  if (source === "kungalv.se") return "https://www.kungalv.se/sok?q=" + encodeURIComponent(title);
  if (source === "partille.se") return "https://www.partille.se/uppleva--gora/evenemang/";
  if (source === "bibliotek.kungsbacka.se") return "https://bibliotek.kungsbacka.se/evenemang";
  return "https://www.google.com/search?q=" + encodeURIComponent('"' + title + '" site:goteborg.se');
}

// ============================================================
// Datumverktyg (svenska format -> ISO)
// ============================================================
const SV_MONTHS = ["januari","februari","mars","april","maj","juni","juli","augusti","september","oktober","november","december"];
function svDateToISO(s) {
  if (!s) return null;
  const m = String(s).match(/(\d{1,2})\s+(\w+)/);
  if (!m) return null;
  const mi = SV_MONTHS.indexOf(m[2].toLowerCase());
  if (mi === -1) return null;
  const now = new Date();
  let year = now.getFullYear();
  if (mi < now.getMonth()) year++;
  return `${year}-${String(mi + 1).padStart(2, "0")}-${String(+m[1]).padStart(2, "0")}`;
}

// ============================================================
// Tolkare: goteborg.se (## TitelVenue / Datum / Tid / Status)
// ============================================================
function parseGbg(html) {
  const anchors = extractAnchors(html);
  const md = htmlToMd(html);
  const lines = md.split(/\r?\n/).map((l) => l.trim());
  const items = [];
  let i = 0;
  while (i < lines.length) {
    if (/^##\s/.test(lines[i] || "")) {
      let title = lines[i].replace(/^##\s+/, "").trim();
      let venue = "";
      const known = ["Kulturhuset Bergsjön","Kulturhuset Kåken","Kulturhuset Blå Stället","Frölunda Kulturhus","Kulturrummet Gårdsten","Kulturhuset Backa","Kulturhuset Angered","Kulturrummet Bergsjön"];
      for (const k of known) {
        if (title.includes(k)) { venue = k; title = title.replace(k, "").trim(); break; }
      }
      if (/Frölunda\s*$/.test(title)) { venue = "Frölunda Kulturhus"; title = title.replace(/Frölunda\s*$/, "").trim(); }
      if (/Blå\s+Stället/.test(title) && !venue) { venue = "Kulturhuset Blå Stället"; title = title.replace(/Blå\s+Stället/, "").trim(); }
      let j = i + 1, date = "", start = "", end = "", time = "", recurring = false, full = false;
      let mode = null;
      while (j < lines.length && !/^##\s/.test(lines[j] || "")) {
        const l = lines[j];
        if (l === "Datum") mode = "date";
        else if (l === "Tid") mode = "time";
        else if (l === "Status") mode = "status";
        else if (l === "Börjar") mode = "start";
        else if (l === "Slutar") mode = "end";
        else if (l === "Upprepas vid fler tillfällen") { recurring = true; mode = null; }
        else if (l === "Fullbokad") { full = true; mode = null; }
        else if (l && mode) {
          if (mode === "date") date = l;
          else if (mode === "time") time = l;
          else if (mode === "start") start = l;
          else if (mode === "end") end = l;
        }
        j++;
      }
      if (!venue && /Frölunda/i.test(title)) venue = "Frölunda Kulturhus";
      if (!venue && /Bergsjön/i.test(title)) venue = "Kulturhuset Bergsjön";
      if (!venue && /Kåken/i.test(title)) venue = "Kulturhuset Kåken";
      if (!venue && /Gårdsten/i.test(title)) venue = "Kulturrummet Gårdsten";
      if (title && (date || start)) {
        const it = {
          title, venue: venue || "Göteborgs kulturhus", source: "goteborg.se",
          date, time, start, end, full, recurring,
          desc: "",
        };
        it.iso = svDateToISO(it.date) || svDateToISO(it.start);
        it.isoEnd = svDateToISO(it.end) || it.iso;
        it.category = categorize(it);
        it.link = findLink(anchors, it.title, "goteborg.se");
        items.push(it);
      }
      i = j;
    } else i++;
  }
  return items;
}

// ============================================================
// Tolkare: Musikens Hus (WordPress-kalender)
// ============================================================
function parseMH(html) {
  const anchors = extractAnchors(html);
  const md = htmlToMd(html);
  const lines = md.split(/\r?\n/).map((l) => l.trim());
  const items = [];
  const dateRe = /^(\d{1,2})\s+(\w+)$/;
  const timeRe = /^(\d{1,2}[:.]\d{2})\s*[-–—]\s*(\d{1,2}[:.]\d{2})$/;
  let i = 0;
  while (i < lines.length) {
    const dm = (lines[i] || "").match(dateRe);
    if (dm && SV_MONTHS.includes(dm[2].toLowerCase())) {
      let j = i + 1;
      let time = "", title = "", desc = [];
      while (j < lines.length && !(lines[j] || "").match(dateRe) && j < i + 12) {
        const tm = (lines[j] || "").match(timeRe);
        if (tm && !time) time = tm[1].replace(".", ":") + "–" + tm[2].replace(".", ":");
        else if (!title && lines[j] && lines[j].length > 3 && !/^\d/.test(lines[j])) title = lines[j].replace(/^#+\s*/, "");
        else if (title && lines[j] && lines[j].length > 10) desc.push(lines[j]);
        j++;
      }
      if (title) {
        const it = {
          title, venue: "Musikens Hus", source: "musikenshus.se",
          date: `${dm[1]} ${dm[2]}`, time, start: "", end: "",
          full: false, recurring: false,
          desc: desc.join(" ").slice(0, 300),
          iso: svDateToISO(`${dm[1]} ${dm[2]}`),
        };
        it.isoEnd = it.iso;
        it.category = categorize(it);
        it.link = findLink(anchors, it.title, "musikenshus.se");
        items.push(it);
      }
      i = j;
    } else i++;
  }
  return items;
}

// ============================================================
// Tolkare: House of Possibilitas (dag datum / tid / titel)
// ============================================================
const HOP_MONTHS = SV_MONTHS;
function hopDateToISO(dateStr, fallback) {
  const m = String(dateStr || "").match(/(\d{1,2})\s+(\w+)/);
  if (!m) return fallback || null;
  const mi = HOP_MONTHS.indexOf(m[2].toLowerCase());
  if (mi === -1) return fallback || null;
  const now = new Date();
  let year = now.getFullYear();
  if (mi < now.getMonth()) year++;
  return `${year}-${String(mi + 1).padStart(2, "0")}-${String(+m[1]).padStart(2, "0")}`;
}
function parseHoP(html) {
  const anchors = extractAnchors(html);
  const md = htmlToMd(html);
  const lines = md.split(/\r?\n/).map((l) => l.trim());
  const items = [];
  const re = /^(Måndag|Tisdag|Onsdag|Torsdag|Fredag|Lördag|Söndag)\s+(\d{1,2})\s+([a-zåäö]+)$/i;
  let i = 0;
  while (i < lines.length) {
    const dm = (lines[i] || "").match(re);
    if (dm) {
      let j = i + 1, time = "", title = "", desc = [];
      while (j < lines.length && !re.test(lines[j] || "") && j < i + 15) {
        const tm = (lines[j] || "").match(/^(\d{1,2}[:.]\d{2})\s*[-–]\s*(\d{1,2}[:.]\d{2})$/);
        if (tm && !time) time = tm[1].replace(".", ":") + "–" + tm[2].replace(".", ":");
        else if (!title && lines[j] && lines[j].length > 3 && !/^\d/.test(lines[j]) && !/^(Måndag|Tisdag|Onsdag|Torsdag|Fredag|Lördag|Söndag)/i.test(lines[j])) title = lines[j].replace(/^#+\s*/, "");
        else if (title && lines[j] && lines[j].length > 10) desc.push(lines[j]);
        j++;
      }
      if (title) {
        const it = {
          title, venue: "House of Possibilitas", source: "houseofpossibilitas.se",
          date: `${dm[2]} ${dm[3]}`, time, start: "", end: "",
          full: false, recurring: false,
          desc: desc.join(" ").slice(0, 300),
          iso: hopDateToISO(`${dm[2]} ${dm[3]}`),
        };
        it.isoEnd = it.iso;
        it.category = categorize(it);
        it.link = findLink(anchors, it.title, "houseofpossibilitas.se");
        items.push(it);
      }
      i = j;
    } else i++;
  }
  return items;
}

// ============================================================
// Tolkare: Kulturhuset Möllan (veckodagsrubriker + titel/tid/plats)
// ============================================================
const MOLLAN_VENUE = "Kulturhuset Möllan (Mölndal)";
function parseMollan(html) {
  const anchors = extractAnchors(html);
  const lines = htmlToMd(html).split(/\r?\n/).map((l) => l.trim().replace(/^\*+\s*|^[-–•]\s+/, "")).filter((l) => l !== "---");
  const items = [];
  const dayHeadRe = /^#{2,4}\s+(Måndagar|Tisdagar|Onsdagar|Torsdagar|Fredagar|Lördagar|Söndagar|Dans på Möllan|Bio på Möllan)$/i;
  const timeRe = /^(\d{1,2}[.:]\d{2})\s*[–-]\s*(\d{1,2}[.:]\d{2})$/;
  const placeRe = /^([A-ZÅÄÖ][^#\n\d]{2,40}[a-zåäö.])$/;
  let curDay = "";
  let i = 0;
  while (i < lines.length) {
    const l = lines[i];
    if (dayHeadRe.test(l)) {
      curDay = l.replace(/^#{2,4}\s+/, "");
      i++;
      while (i < lines.length && !dayHeadRe.test(lines[i] || "") && lines[i] !== "* * *") {
        const tm = (lines[i] || "").match(timeRe);
        if (tm) {
          let title = "", k = i - 1;
          while (k >= 0 && !lines[k]) k--;
          if (k >= 0) title = lines[k].replace(/\*+/g, "").trim();
          let place = "";
          const pm = (lines[i + 1] || "").match(placeRe);
          if (pm) { place = pm[1].trim(); i++; }
          if (title && title.length > 2 && !dayHeadRe.test(title) && !timeRe.test(title)) {
            const it = {
              title, venue: MOLLAN_VENUE, source: "kulturhusetmollan.se",
              date: curDay, time: tm[1].replace(".", ":") + "–" + tm[2].replace(".", ":"),
              start: "", end: "", full: false, recurring: true,
              desc: place ? "Plats: " + place : "", iso: null, isoEnd: null,
            };
            it.category = categorize(it);
            it.link = findLink(anchors, it.title, it.source);
            items.push(it);
          }
        }
        i++;
      }
    } else i++;
  }
  return items;
}

// ============================================================
// Tolkare: Mimers Kulturhus, Kungälv (datumintervall följt av titel)
// ============================================================
const KUNGALV_VENUE = "Mimers Kulturhus (Kungälv)";
const KUNGALV_MONTHS = ["jan","feb","mar","apr","maj","jun","jul","aug","sep","okt","nov","dec"];
function parseKungalv(html) {
  const anchors = extractAnchors(html);
  const lines = htmlToMd(html).split(/\r?\n/).map((l) => l.trim().replace(/^\*+\s*|^[-–•]\s+/, ""));
  const items = [];
  const dateLineRe = /^(\d{1,2})\s+([a-zåäö]{3})\s*[-–]\s*(?:(\d{1,2})\s+)?([a-zåäö]{3})?/i;
  let i = 0;
  while (i < lines.length) {
    const raw = lines[i] || "";
    const dm = raw.match(dateLineRe);
    if (dm && raw.replace(/\*/g, "").trim().length < 90) {
      const mi1 = KUNGALV_MONTHS.indexOf(dm[2].toLowerCase());
      if (mi1 !== -1) {
        const clean = raw.replace(/\*/g, "").trim();
        const dateEnd = clean.indexOf(dm[4] || dm[3] || "") + (dm[4] || dm[3] || "").length;
        const dateStr = clean.slice(0, dateEnd).trim();
        const desc = clean.slice(dateEnd).trim();
        let j = i + 1;
        while (j < lines.length && !lines[j]) j++;
        const title = (lines[j] || "").trim();
        if (title && title.length > 2 && !dateLineRe.test(title)) {
          const cur = new Date();
          let year = cur.getFullYear();
          if (mi1 < cur.getMonth()) year++;
          const iso = `${year}-${String(mi1 + 1).padStart(2, "0")}-${String(+dm[1]).padStart(2, "0")}`;
          let isoEnd = iso;
          if (dm[4] || dm[3]) {
            const mi2 = dm[4] ? KUNGALV_MONTHS.indexOf(dm[4].toLowerCase()) : mi1;
            if (mi2 !== -1) {
              let y2 = year;
              if (mi2 < mi1) y2++;
              isoEnd = `${y2}-${String(mi2 + 1).padStart(2, "0")}-${String(+(dm[3] || dm[1])).padStart(2, "0")}`;
            }
          }
          const it = {
            title, venue: KUNGALV_VENUE, source: "kungalv.se",
            date: dateStr, time: "", start: "", end: "",
            full: false, recurring: false,
            desc: desc.slice(0, 400), iso, isoEnd,
          };
          it.category = categorize(it);
          it.link = findLink(anchors, it.title, it.source);
          items.push(it);
          i = j + 1; continue;
        }
      }
    }
    i++;
  }
  return items;
}

// ============================================================
// Tolkare: Partille Kulturum (### titel / datum tid / plats)
// ============================================================
const PARTILLE_VENUE = "Partille Kulturum";
const PARTILLE_MONTHS = SV_MONTHS;
function parsePartille(html) {
  const anchors = extractAnchors(html);
  const lines = htmlToMd(html).split(/\r?\n/).map((l) => l.trim().replace(/^\*+\s*|^[-–•]\s+/, ""));
  const items = [];
  const titleRe = /^#{2,4}\s+(.+)$/;
  const dateRe = /^(\d{1,2})\s+([a-zåäö]+)\s+(\d{1,2}[.:]\d{2})\s*[-–]\s*(\d{1,2}[.:]\d{2})$/i;
  let i = 0;
  while (i < lines.length) {
    const tm = lines[i] && lines[i].match(titleRe);
    if (tm && !/Evenemangskalender|Vanliga|Genvägar|Till startsidan/i.test(lines[i])) {
      const title = tm[1].trim();
      let j = i + 1;
      while (j < lines.length && !lines[j]) j++;
      const dm = lines[j] && lines[j].match(dateRe);
      if (dm) {
        const timeStr = dm[3].replace(".", ":") + "–" + dm[4].replace(".", ":");
        j++;
        let place = "";
        if (lines[j] && !/^Fler tillfällen|^###|^\d{1,2} sep/.test(lines[j]) && lines[j].length < 60 && !dateRe.test(lines[j])) { place = lines[j]; j++; }
        const recurring = /^Fler tillfällen/.test(lines[j] || "");
        const mi = PARTILLE_MONTHS.indexOf(dm[2].toLowerCase());
        const cur = new Date();
        let year = cur.getFullYear();
        if (mi !== -1 && mi < cur.getMonth()) year++;
        const iso = mi !== -1 ? `${year}-${String(mi + 1).padStart(2, "0")}-${String(+dm[1]).padStart(2, "0")}` : null;
        const it = {
          title, venue: PARTILLE_VENUE, source: "partille.se",
          date: `${dm[1]} ${dm[2]}`, time: timeStr, start: "", end: "",
          full: false, recurring,
          desc: place ? "Plats: " + place : "", iso, isoEnd: iso,
        };
        it.category = categorize(it);
        it.link = findLink(anchors, it.title, it.source);
        items.push(it);
        i = j; continue;
      }
    }
    i++;
  }
  return items;
}

// ============================================================
// Tolkare: Biblioteken i Kungsbacka (rubrik + beskrivning)
// ============================================================
const KUNGSBACKA_VENUE = "Biblioteken i Kungsbacka";
function parseKungsbacka(html) {
  const anchors = extractAnchors(html);
  const lines = htmlToMd(html).split(/\r?\n/).map((l) => l.trim().replace(/^\*+\s*|^[-–•]\s+/, ""));
  const items = [];
  const descStartRe = /^#{2,3}\s+(.+)$/;
  let i = 0;
  while (i < lines.length) {
    const tm = lines[i] && lines[i].match(descStartRe);
    if (tm && !/Evenemang|JavaScript|Logga in|kakor|Sök evenemang|Tidsintervall|Mer om/i.test(lines[i])) {
      const title = tm[1].trim();
      let j = i + 1;
      const desc = [];
      while (j < lines.length && !/^#{2,3}\s+/.test(lines[j] || "")) {
        if (lines[j] && lines[j].length > 20) desc.push(lines[j]);
        j++;
        if (desc.join(" ").length > 300) break;
      }
      if (title.length > 3 && desc.length) {
        const it = {
          title, venue: KUNGSBACKA_VENUE, source: "bibliotek.kungsbacka.se",
          date: "", time: "", start: "", end: "",
          full: false, recurring: false,
          desc: desc.join(" ").slice(0, 400), iso: null, isoEnd: null,
        };
        it.category = categorize(it);
        it.link = findLink(anchors, it.title, it.source);
        items.push(it);
        i = j; continue;
      }
    }
    i++;
  }
  return items;
}

// ============================================================
// Hämtning + tolkning av alla källor
// ============================================================
async function fetchAllEvents() {
  const results = await Promise.allSettled([
    parseSource(SOURCES.gbg, parseGbg),
    parseSource(SOURCES.mh, parseMH),
    parseSource(SOURCES.hop, parseHoP),
    parseSource(SOURCES.mollan, parseMollan),
    parseSource(SOURCES.kungalv, parseKungalv),
    parseSource(SOURCES.partille, parsePartille),
    parseSource(SOURCES.kungsbacka, parseKungsbacka),
  ]);
  const NAMES = ["goteborg.se", "musikenshus.se", "houseofpossibilitas.se", "kulturhusetmollan.se", "kungalv.se", "partille.se", "bibliotek.kungsbacka.se"];
  let items = [];
  const errors = [];
  const counts = {};
  results.forEach((r, idx) => {
    const n = r.status === "fulfilled" ? r.value.length : 0;
    counts[NAMES[idx]] = n;
    if (r.status === "fulfilled" && r.value.length) items = items.concat(r.value);
    else errors.push(NAMES[idx] + ": " + (r.status === "rejected" ? String(r.reason).slice(0, 100) : "inga evenemang hittades"));
  });
  items.sort((a, b) => (a.iso || "9999") < (b.iso || "9999") ? -1 : (a.iso || "9999") > (b.iso || "9999") ? 1 : 0);
  return { items, errors, counts, fetchedAt: new Date().toISOString() };
}

// ============================================================
// Cache (per isolate)
// ============================================================
async function getEvents(force) {
  if (!force && CACHE.data.length && Date.now() - CACHE.ts < CACHE_TTL_MS) {
    return { ...CACHE, cached: true };
  }
  const fresh = await fetchAllEvents();
  if (fresh.items.length > 0) {
    CACHE = { ts: Date.now(), ...fresh };
    return { ...fresh, cached: false };
  }
  if (CACHE.data.length) return { ...CACHE, cached: true, stale: true };
  return fresh;
}

// ============================================================
// Pages Function-router ([[route]] fångar allt under /api/)
// ============================================================
export async function onRequestGet(context) {
  const { request, env } = context;
  setEnv(env);
  const url = new URL(request.url);
  const path = url.pathname.replace(/\/+$/, "") || "/";

  const CORS = {
    "content-type": "application/json;charset=UTF-8",
  };

  if (path === "/api/events") {
    const force = url.searchParams.get("refresh") === "1";
    const data = await getEvents(force);
    return new Response(JSON.stringify(data), {
      headers: { ...CORS, "cache-control": "public, max-age=1800" },
    });
  }

  if (path === "/api/debug") {
    const report = {};
    const sources = [
      ["goteborg.se", SOURCES.gbg, parseGbg],
      ["musikenshus.se", SOURCES.mh, parseMH],
      ["houseofpossibilitas.se", SOURCES.hop, parseHoP],
      ["kulturhusetmollan.se", SOURCES.mollan, parseMollan],
      ["kungalv.se", SOURCES.kungalv, parseKungalv],
      ["partille.se", SOURCES.partille, parsePartille],
      ["bibliotek.kungsbacka.se", SOURCES.kungsbacka, parseKungsbacka],
    ];
    await Promise.all(sources.map(async ([name, urlSrc, fn]) => {
      const info = {};
      try {
        const res = await fetchPage(urlSrc);
        info.http = "OK";
        info.rawLength = res.length;
        info.isHtml = /<html/i.test(res);
        info.rawHead = res.slice(0, 200);
        const items = fn(res);
        info.parsedItems = items.length;
        const md = htmlToMd(res);
        info.mdHead = md.slice(0, 400);
      } catch (e) {
        info.http = "FEL: " + String(e).slice(0, 200);
      }
      report[name] = info;
    }));
    return new Response(JSON.stringify(report, null, 2), { headers: CORS });
  }

  return new Response(JSON.stringify({ error: "Okänd endpoint. Använd /api/events eller /api/debug." }), {
    status: 404,
    headers: CORS,
  });
}
