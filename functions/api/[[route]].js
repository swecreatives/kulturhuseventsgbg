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
const CACHE_TTL_MS = 60 * 60 * 1000; // 1 timme
const FETCH_TIMEOUT_MS = 15000;
const SLOW_SOURCE_TIMEOUT_MS = 5000;
const SLOW_SOURCES = /kungsbacka\.se/;
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
  kungalvSearch: "https://www.kungalv.se/Search/Result/",
  partille: "https://www.partille.se/evenemang/",
  partilleApi: "https://www.partille.se/_api/eventlistpage/events",
  kungsbacka: "https://bibliotek.kungsbacka.se/evenemang",
};

// ---------- Modul-global cache (per isolate) ----------
let CACHE = { ts: 0, items: [] };
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
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(+n))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCharCode(parseInt(n, 16)))
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
  const JS_RENDERED = /goteborg\.se|partille\.se|kungalv\.se/.test(url);
  const useJina = JS_RENDERED && !!ENV.JINA_API_KEY;
  const target = useJina && ENV.JINA_API_KEY
    ? "https://r.jina.ai/" + url
    : url;
  const headers = { ...HEADERS };
  if (useJina && ENV.JINA_API_KEY) headers["Authorization"] = "Bearer " + ENV.JINA_API_KEY;
  const timeoutMs = SLOW_SOURCES.test(url) ? SLOW_SOURCE_TIMEOUT_MS : FETCH_TIMEOUT_MS;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
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
  for (const [id, re] of CATEGORY_RULES) if (re.test(item.title)) return id;
  for (const [id, re] of CATEGORY_RULES) if (re.test(t)) return id;
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
// Obs: htmlToMd slår samman etikett och värde till en rad,
// t.ex. "Datum Måndag 5 oktober" och "Tid 09:30–11:30".
// ============================================================
function parseGbg(html) {
  const anchors = extractAnchors(html);
  const md = htmlToMd(html);
  const lines = md.split(/\r?\n/).map((l) => l.trim());
  const items = [];
  let i = 0;
  while (i < lines.length) {
    if (/^##\s/.test(lines[i] || "")) {
      let title = lines[i].replace(/^##\s+/, "").replace(/\[([^\]]*)\]\([^)]*\)/g, "$1").trim();
      let venue = "";
      const known = ["Kulturhuset Bergsjön","Kulturhuset Kåken","Kulturhuset Blå Stället","Frölunda Kulturhus","Kulturrummet Gårdsten","Kulturhuset Backa","Kulturhuset Angered","Kulturrummet Bergsjön"];
      for (const k of known) {
        if (title.includes(k)) { venue = k; title = title.replace(k, "").trim(); break; }
      }
      if (/Frölunda\s*$/.test(title)) { venue = "Frölunda Kulturhus"; title = title.replace(/Frölunda\s*$/, "").trim(); }
      if (/Blå\s+Stället/.test(title) && !venue) { venue = "Kulturhuset Blå Stället"; title = title.replace(/Blå\s+Stället/, "").trim(); }
      let j = i + 1, date = "", start = "", end = "", time = "", recurring = false, full = false;
      const dateM = (l) => { const m = l.match(/^Datum\s+(.+)$/); return m ? m[1].trim() : null; };
      const timeM = (l) => { const m = l.match(/^Tid\s+(.+)$/); return m ? m[1].trim() : null; };
      const startM = (l) => { const m = l.match(/^Börjar\s+(.+)$/); return m ? m[1].trim() : null; };
      const endM = (l) => { const m = l.match(/^Slutar\s+(.+)$/); return m ? m[1].trim() : null; };
      while (j < lines.length && !/^##\s/.test(lines[j] || "")) {
        const l = lines[j];
        if (l === "Datum") { j++; if (lines[j]) date = lines[j]; }
        else if (l === "Tid") { j++; if (lines[j]) time = lines[j]; }
        else if (l === "Börjar") { j++; if (lines[j]) start = lines[j]; }
        else if (l === "Slutar") { j++; if (lines[j]) end = lines[j]; }
        else if (l === "Status") { j++; if (lines[j] && /fullbokad|inställd/i.test(lines[j])) full = true; }
        else if (l === "Upprepas vid fler tillfällen") { recurring = true; }
        else if (dateM(l)) date = dateM(l);
        else if (timeM(l)) time = timeM(l);
        else if (startM(l)) start = startM(l);
        else if (endM(l)) end = endM(l);
        else if (/^Status\s+(Fullbokad|Inställd)/i.test(l)) full = true;
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
const MH_MONTHS = { "jan":0,"feb":1,"mar":2,"apr":3,"maj":4,"jun":5,"jul":6,"aug":7,"sep":8,"okt":9,"nov":10,"dec":11 };
const MH_MONTH_SV = SV_MONTHS;
// Musikens Hus: "#### 01" / "Okt/Tor" / scen / "## Titel" / beskrivning / pris
function parseMH(html) {
  const anchors = extractAnchors(html);
  const lines = htmlToMd(html).split(/\r?\n/).map((l) => l.trim().replace(/^[-–•]\s+/, ""));
  const items = [];
  const dateHeadRe = /^#{2,6}\s+(\d{1,2})$/;
  const monthDayRe = /^([a-zåäö]{3})\/([a-zåäö]{2,3})$/i;
  const cur = new Date();
  let i = 0;
  while (i < lines.length) {
    const dm = lines[i] && lines[i].match(dateHeadRe);
    if (dm) {
      let day = +dm[1], month = -1, scen = "", j = i + 1;
      while (j < lines.length && !lines[j]) j++;
      const md = lines[j] && lines[j].match(monthDayRe);
      if (md) {
        month = MH_MONTHS[md[1].toLowerCase()] !== undefined ? MH_MONTHS[md[1].toLowerCase()] : -1;
        j++;
        while (j < lines.length && !lines[j]) j++;
        if (lines[j] && !/^#{2,6}/.test(lines[j])) { scen = lines[j]; j++; }
        while (j < lines.length && !lines[j]) j++;
        if (lines[j] && /^#{2,6}\s+/.test(lines[j]) && month >= 0) {
          const title = lines[j].replace(/^#{2,6}\s+/, "").trim();
          j++;
          const desc = [];
          let price = "";
          while (j < lines.length && !/^L[aä]s mer/i.test(lines[j] || "") && !dateHeadRe.test(lines[j] || "")) {
            if (lines[j]) {
              if (/^(Fri entré|Boka biljett|\d+\s*kr)/i.test(lines[j])) { if (!price) price = lines[j]; }
              else if (desc.join(" ").length < 400) desc.push(lines[j]);
            }
            j++;
          }
          if (/^L[aä]s mer/i.test(lines[j] || "")) j++;
          while (j < lines.length && !lines[j]) j++;
          if (j < lines.length && /^(Fri entré|Boka biljett|\d+\s*kr)/i.test(lines[j])) { if (!price) price = lines[j]; j++; }
          const descAll = desc.join(" ");
          let timeStr = "";
          const kt = descAll.match(/(?:kl\.?\s*|klockan\s*|[Oo]ppet:\s*|Från\s+|Start\s+)(\d{1,2}[:.]\d{2})(?:\s*(?:[-–—]|till)\s*(\d{1,2}[:.]\d{2}))?/);
          if (kt) timeStr = kt[2] ? kt[1].replace(".", ":") + "–" + kt[2].replace(".", ":") : kt[1].replace(".", ":");
          let year = cur.getFullYear();
          if (month < cur.getMonth()) year++;
          const it = {
            title, venue: "Musikens Hus" + (scen ? ` (${scen})` : ""), source: "musikenshus.se",
            date: `${day} ${MH_MONTH_SV[month]}`, time: timeStr, start: "", end: "",
            full: false, recurring: false,
            desc: desc.join(" ").slice(0, 400),
            price,
            iso: `${year}-${String(month + 1).padStart(2, "0")}-${String(day).padStart(2, "0")}`,
          };
          it.isoEnd = it.iso;
          it.category = categorize(it);
          it.link = findLink(anchors, it.title, "musikenshus.se");
          items.push(it);
          i = j; continue;
        }
      }
    }
    i++;
  }
  return items;
}

// ============================================================
// Tolkare: House of Possibilitas (dag datum / tid / titel)
// ============================================================
const HOP_MONTHS = ["jan","feb","mar","apr","maj","jun","jul","aug","sep","okt","nov","dec"];
const HOP_MONTH_SV = SV_MONTHS;
function hopDateToISO(dateStr) {
  const m = String(dateStr || "").match(/(\d{1,2})\s+([a-zåäö]{3})/i);
  if (!m) return null;
  const mi = HOP_MONTHS.indexOf(m[2].toLowerCase());
  if (mi === -1) return null;
  const now = new Date();
  let year = now.getFullYear();
  if (mi < now.getMonth()) year++;
  return `${year}-${String(mi + 1).padStart(2, "0")}-${String(+m[1]).padStart(2, "0")}`;
}
// House of Possibilitas: "fre 2 okt" / "10:00" / "### Titel" / beskrivning
function parseHoP(html) {
  const anchors = extractAnchors(html);
  const lines = htmlToMd(html).split(/\r?\n/).map((l) => l.trim().replace(/^[-–•]\s+/, ""));
  const items = [];
  const dateRe = /^(mån|tis|ons|tor|fre|lör|sön)\s+(\d{1,2})\s+([a-zåäö]{3})$/i;
  const timeRe = /^(\d{1,2}[:.]\d{2})$/;
  let i = 0;
  while (i < lines.length) {
    const dm = lines[i] && lines[i].match(dateRe);
    if (dm) {
      const dateStr = `${dm[2]} ${dm[3]}`;
      let timeStr = "", j = i + 1;
      while (j < lines.length && !lines[j]) j++;
      const tm = lines[j] && lines[j].match(timeRe);
      if (tm) { timeStr = tm[1].replace(".", ":"); j++; }
      while (j < lines.length && !lines[j]) j++;
      if (lines[j] && /^#{2,4}\s+/.test(lines[j])) {
        const title = lines[j].replace(/^#{2,4}\s+/, "").trim();
        j++;
        const desc = [];
        while (j < lines.length && !/^L[aä]s mer/i.test(lines[j] || "") && !dateRe.test(lines[j] || "")) {
          if (lines[j] && desc.join(" ").length < 400) desc.push(lines[j]);
          j++;
        }
        if (/^L[aä]s mer/i.test(lines[j] || "")) j++;
        const mi = HOP_MONTHS.indexOf(dm[3].toLowerCase());
        const it = {
          title, venue: "House of Possibilitas", source: "houseofpossibilitas.se",
          date: `${dm[2]} ${HOP_MONTH_SV[mi !== -1 ? mi : 0]}`, time: timeStr, start: "", end: "",
          full: false, recurring: false,
          desc: desc.join(" ").slice(0, 400),
          iso: hopDateToISO(dateStr),
        };
        it.isoEnd = it.iso;
        it.category = categorize(it);
        it.link = findLink(anchors, it.title, "houseofpossibilitas.se");
        items.push(it);
        i = j; continue;
      }
    }
    i++;
  }
  return items;
}

// ============================================================
// Tolkare: Kulturhuset Möllan (veckodagsrubriker + titel/tid/plats)
// Sidan listar återkommande aktiviteter per veckodag: titel på en
// rad, tidsintervall på nästa, ev. plats på raden efter.
// ============================================================
const MOLLAN_VENUE = "Kulturhuset Möllan (Mölndal)";
function parseMollan(html) {
  const anchors = extractAnchors(html);
  const lines = htmlToMd(html).split(/\r?\n/).map((l) => l.trim().replace(/^\*+\s*|^[-–•]\s+/, "")).filter((l) => l !== "---");
  const items = [];
  const dayHeadRe = /^#{2,4}\s+(Måndagar|Tisdagar|Onsdagar|Torsdagar|Fredagar|Lördagar|Söndagar|Dans på Möllan|Bio på Möllan)$/i;
  const timeRe = /^(\d{1,2}[.:]\d{2})\s*(?:[–—-]|&)\s*(\d{1,2}[.:]\d{2})$/;
  const placeRe = /^([A-ZÅÄÖ][^#\n\d]{2,40}[a-zåäö.])$/;
  const titleRe = /^([A-ZÅÄÖ*][^#\n]{2,60})$/;
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
          if (k >= 0) {
            title = lines[k].replace(/\*+/g, "").trim();
            if (dayHeadRe.test(lines[k]) || timeRe.test(lines[k])) title = "";
          }
          let place = "";
          const pm = (lines[i + 1] || "").match(placeRe);
          if (pm && !timeRe.test(lines[i + 1])) { place = pm[1].trim(); i++; }
          if (title && title.length > 2 && titleRe.test(title)) {
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
// Kungälv: evenemangskalendern är Angular-renderad, men sajten har
// ett sök-API (POST /Search/Result/) som returnerar evenemang som
// JSON med datum i Description. Tom sökfråga ger 0 träffar, så vi
// itererar bokstäver a-ö och deduplicerar på Url.
// ============================================================
const KUNGALV_VENUE = "Mimers Kulturhus (Kungälv)";
const KUNGALV_MONTHS = ["jan","feb","mar","apr","maj","jun","jul","aug","sep","okt","nov","dec"];
const KUNGALV_MONTH_SV = SV_MONTHS;
function decodeEntities(s) {
  return String(s || "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(+n))
    .replace(/&amp;/g, "&")
    .replace(/&aring;/g, "å").replace(/&auml;/g, "ä").replace(/&ouml;/g, "ö")
    .replace(/&Aring;/g, "Å").replace(/&Auml;/g, "Ä").replace(/&Ouml;/g, "Ö")
    .replace(/\s+/g, " ")
    .trim();
}
function kungalvDateToISO(dateStr) {
  const m = String(dateStr || "").match(/(\d{1,2})\s+([a-zåäö]{3})/i);
  if (!m) return null;
  const mi = KUNGALV_MONTHS.indexOf(m[2].toLowerCase());
  if (mi === -1) return null;
  const now = new Date();
  let year = now.getFullYear();
  if (mi < now.getMonth()) year++;
  return `${year}-${String(mi + 1).padStart(2, "0")}-${String(+m[1]).padStart(2, "0")}`;
}
async function fetchKungalvEvents() {
  const all = new Map();
  const queries = "abcdefghijklmnopqrstuvwxyzåäö".split("");
  const fetchPage = async (query, page) => {
    const params = new URLSearchParams({
      search: query, getTotals: "false", currentPage: String(page),
      searchObjectType: "8", restrictToType: "true", language: "sv", categoryFilter: "",
    });
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
    try {
      const res = await fetch(SOURCES.kungalvSearch, {
        method: "POST",
        headers: { ...HEADERS, "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8", "X-Requested-With": "XMLHttpRequest" },
        body: params.toString(),
        signal: ctrl.signal,
      });
      if (!res.ok) throw new Error("HTTP " + res.status);
      const j = await res.json();
      return j.PageResult || [];
    } finally { clearTimeout(timer); }
  };
  await Promise.all(queries.map(async (query) => {
    try {
      for (let page = 1; page <= 3; page++) {
        const list = await fetchPage(query, page);
        if (!list.length) break;
        for (const hit of list) all.set(hit.Url, hit);
      }
    } catch (e) { /* enskild fråga misslyckas -> nästa */ }
  }));
  const items = [];
  for (const hit of all.values()) {
    const title = decodeEntities(hit.Title);
    const desc = decodeEntities(hit.Description);
    const dateMatch = desc.match(/(\d{1,2}\s+[a-zåäö]{3}\s*(?:-\s*\d{1,2}\s+[a-zåäö]{3})?)/i);
    const dateStr = dateMatch ? dateMatch[1] : "";
    let iso = kungalvDateToISO(dateStr);
    let isoEnd = iso;
    const endM = dateStr && dateStr.match(/-\s*(\d{1,2})\s+([a-zåäö]{3})/i);
    if (endM) {
      const mi = KUNGALV_MONTHS.indexOf(endM[2].toLowerCase());
      if (mi !== -1) {
        const now = new Date();
        let year = now.getFullYear();
        if (iso && iso.slice(0, 4) === String(year) && mi < now.getMonth()) year++;
        else if (iso) year = +iso.slice(0, 4);
        isoEnd = `${year}-${String(mi + 1).padStart(2, "0")}-${String(+endM[1]).padStart(2, "0")}`;
      }
    }
    const it = {
      title, venue: KUNGALV_VENUE, source: "kungalv.se",
      date: dateStr, time: "", start: "", end: "",
      full: false, recurring: !!endM,
      desc: desc.replace(dateStr, "").trim().slice(0, 400),
      iso, isoEnd,
    };
    it.category = categorize(it);
    it.link = safeLink(hit.Url) || "https://www.kungalv.se/kultur--fritid/evenemang-kungalv/";
    items.push(it);
  }
  return items;
}

// ============================================================
// Partille: evenemangskalendern laddas med Vue från ett öppet
// JSON-API (/_api/eventlistpage/events) med paginering via
// take/skip. Endast evenemang i framtiden hämtas (from=dagens dato)
// och endast de med plats på Kulturum ( Location-fältet).
// ============================================================
const PARTILLE_VENUE = "Partille Kulturum";
async function fetchPartilleEvents() {
  const today = new Date();
  const todayStr = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}-${String(today.getDate()).padStart(2, "0")}`;
  const pageSize = 100;
  const all = [];
  let skip = 0;
  while (skip < 500) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
    let page;
    try {
      const res = await fetch(`${SOURCES.partilleApi}?take=${pageSize}&skip=${skip}&from=${todayStr}`, {
        headers: { ...HEADERS, Accept: "application/json" },
        signal: ctrl.signal,
      });
      if (!res.ok) throw new Error("HTTP " + res.status);
      page = await res.json();
    } finally { clearTimeout(timer); }
    const hits = page.EventPageHits || [];
    if (!hits.length) break;
    all.push(...hits);
    if (all.length >= (page.TotalHits || 0)) break;
    skip += pageSize;
  }
  const items = all
    .filter((e) => /kulturum/i.test(e.Location || ""))
    .map((e) => {
    const from = e.EventFromDate ? new Date(e.EventFromDate) : null;
    const to = e.EventToDate ? new Date(e.EventToDate) : null;
    const iso = from && !isNaN(from) ? from.toISOString().slice(0, 10) : null;
    const isoEnd = to && !isNaN(to) ? to.toISOString().slice(0, 10) : iso;
    const timeStr = from && !isNaN(from) ? String(from.getUTCHours()).padStart(2, "0") + ":" + String(from.getUTCMinutes()).padStart(2, "0") : "";
    const it = {
      title: decodeEntities(e.Title), venue: PARTILLE_VENUE, source: "partille.se",
      date: iso || "", time: timeStr, start: "", end: "",
      full: false, recurring: !!e.HasMultipleDates,
      desc: e.Category ? "Kategori: " + e.Category : "",
      iso, isoEnd,
    };
    it.category = categorize(it);
    it.link = safeLink((e.Url || "").replace(/^\/\//, "https://")) || SOURCES.partille;
    return it;
  });
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
    fetchKungalvEvents(),
    fetchPartilleEvents(),
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
// Obs: Cache API (caches.default) provades men orsakar 500-error
// vid upprepade anrop i Pages Functions och är därför borttaget.
// ============================================================
async function getEvents(force) {
  if (!force && CACHE.items.length && Date.now() - CACHE.ts < CACHE_TTL_MS) {
    return { ...CACHE, cached: true };
  }
  const fresh = await fetchAllEvents();
  if (fresh.items.length > 0) {
    CACHE = { ts: Date.now(), ...fresh };
    return { ...fresh, cached: false };
  }
  if (CACHE.items.length) return { ...CACHE, cached: true, stale: true };
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
      headers: { ...CORS, "cache-control": force ? "no-store" : "public, max-age=1800" },
    });
  }

  if (path === "/api/debug") {
    const report = {};
    const htmlSources = [
      ["goteborg.se", SOURCES.gbg, parseGbg],
      ["musikenshus.se", SOURCES.mh, parseMH],
      ["houseofpossibilitas.se", SOURCES.hop, parseHoP],
      ["kulturhusetmollan.se", SOURCES.mollan, parseMollan],
      ["bibliotek.kungsbacka.se", SOURCES.kungsbacka, parseKungsbacka],
    ];
    const apiSources = [
      ["kungalv.se", fetchKungalvEvents],
      ["partille.se", fetchPartilleEvents],
    ];
    await Promise.all([
      ...htmlSources.map(async ([name, urlSrc, fn]) => {
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
      }),
      ...apiSources.map(async ([name, fetchFn]) => {
        const info = {};
        try {
          const items = await fetchFn();
          info.http = "OK";
          info.parsedItems = items.length;
          if (items[0]) info.sample = items[0].title;
        } catch (e) {
          info.http = "FEL: " + String(e).slice(0, 200);
        }
        report[name] = info;
      }),
    ]);
    return new Response(JSON.stringify(report, null, 2), { headers: CORS });
  }

  return new Response(JSON.stringify({ error: "Okänd endpoint. Använd /api/events eller /api/debug." }), {
    status: 404,
    headers: CORS,
  });
}
