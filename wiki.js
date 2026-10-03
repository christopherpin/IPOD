/* Wikipedia lookup for albums.
 *
 * Load with <script src="wiki.js"></script>, then:
 *   Wiki.lookup(album)            -> Promise<info|null>   (album = a Spotify album object)
 *   Wiki.lookupAll(albums, onEach) -> Promise<Map(albumId -> info|null)>, onEach(album, info) as each lands
 *   Wiki.cached(album)            -> info | null | undefined (undefined = not looked up yet)
 *   Wiki.clear()                  -> forget every cached lookup
 *
 * info = {
 *   title, url, pageid, wikidata,       // the Wikipedia article
 *   summary,                            // plain-text intro paragraph(s)
 *   image,                              // article thumbnail URL, if any
 *   type,                               // "studio", "live", "compilation", "soundtrack", "EP", ...
 *   artist,                             // as written in the infobox
 *   released, recorded, studio, length,
 *   genres:[], labels:[], producers:[],
 *   fetchedAt
 * }
 * null means Wikipedia has no article we could confidently match.
 *
 * Talks to Wikipedia straight from the browser (CORS via origin=*), at most two requests at a time,
 * and caches every answer in localStorage under "wiki." so each album is only fetched once.
 */
(function(){
"use strict";

const API = "https://en.wikipedia.org/w/api.php";
const PREFIX = "wiki.v1.";
const HIT_TTL = 90 * 864e5, MISS_TTL = 14 * 864e5;
const CONCURRENCY = 2;

/* ---------- cache ---------- */
const store = {
  get(k){ try{ const v = localStorage.getItem(PREFIX + k); return v == null ? undefined : JSON.parse(v); }catch{ return undefined; } },
  set(k, v){ try{ localStorage.setItem(PREFIX + k, JSON.stringify(v)); }catch{} }
};
function cached(album){
  const e = store.get(key(album));
  if (!e) return undefined;
  if (Date.now() - e.t > (e.v ? HIT_TTL : MISS_TTL)) return undefined;
  return e.v;
}
function clear(){
  try{ Object.keys(localStorage).filter(k => k.startsWith(PREFIX)).forEach(k => localStorage.removeItem(k)); }catch{}
  inflight.clear();
}
const key = a => a.id || norm(a.name) + "|" + norm(firstArtist(a));

/* ---------- request queue ---------- */
let active = 0; const waiting = [];
function api(params){
  return new Promise((resolve, reject) => {
    const run = async () => {
      active++;
      try{
        const qs = new URLSearchParams({ format: "json", formatversion: "2", origin: "*", ...params });
        let r;
        for (let i = 0; i < 3; i++){
          r = await fetch(API + "?" + qs);
          if (r.status !== 429 && r.status < 500) break;
          await new Promise(s => setTimeout(s, 1000 * 2 ** i));
        }
        if (!r.ok) throw new Error("Wikipedia error " + r.status);
        resolve(await r.json());
      }catch(e){ reject(e); }
      finally{ active--; if (waiting.length) waiting.shift()(); }
    };
    active < CONCURRENCY ? run() : waiting.push(run);
  });
}

/* ---------- names ---------- */
const firstArtist = a => ((a.artists || [])[0] || {}).name || "";
function norm(s){
  return (s || "").normalize("NFKD").replace(/[̀-ͯ]/g, "").toLowerCase()
    .replace(/&/g, " and ").replace(/^the\s+/, "").replace(/[^a-z0-9]+/g, " ").trim();
}
// "OK Computer OKNOTOK 1997 2017" stays; "Abbey Road (Remastered 2019)" -> "Abbey Road"
const EDITION = /\b(remaster(ed)?|deluxe|expanded|anniversary|edition|version|reissue|bonus|mono|stereo|live at|super|collector'?s?|special|legacy|bonus tracks?|\d{4} mix|remix(ed)?)\b/i;
function cleanTitle(t){
  let s = t || "";
  for (let i = 0; i < 3; i++) s = s.replace(/\s*[\(\[][^\)\]]*[\)\]]\s*$/, m => EDITION.test(m) ? "" : m);
  s = s.replace(/\s+[-–—:]\s+[^-–—:]*$/, m => EDITION.test(m) ? "" : m);
  return s.trim() || (t || "").trim();
}
const sameArtist = (a, b) => { const x = norm(a), y = norm(b); return !!x && !!y && (x === y || x.includes(y) || y.includes(x)); };

/* ---------- infobox parsing ---------- */
function findInfobox(wikitext){
  const m = /\{\{\s*Infobox\s+album/i.exec(wikitext || "");
  if (!m) return null;
  let depth = 0, i = m.index;
  for (; i < wikitext.length - 1; i++){
    const two = wikitext.substr(i, 2);
    if (two === "{{"){ depth++; i++; }
    else if (two === "}}"){ depth--; i++; if (!depth) break; }
  }
  const body = wikitext.slice(m.index + 2, i - 1);
  const fields = {};
  for (const part of splitTop(body, "|").slice(1)){
    const eq = part.indexOf("=");
    if (eq < 0) continue;
    const k = part.slice(0, eq).trim().toLowerCase().replace(/\s+/g, "_");
    const v = part.slice(eq + 1).trim();
    if (v) fields[k] = v;
  }
  return fields;
}
// split on sep only where we are not inside {{ }} or [[ ]]
function splitTop(s, sep){
  const out = []; let depth = 0, cur = "";
  for (let i = 0; i < s.length; i++){
    const two = s.substr(i, 2);
    if (two === "{{" || two === "[["){ depth++; cur += two; i++; continue; }
    if (two === "}}" || two === "]]"){ depth--; cur += two; i++; continue; }
    if (!depth && s[i] === sep){ out.push(cur); cur = ""; continue; }
    cur += s[i];
  }
  out.push(cur);
  return out;
}
const MONTHS = ["January","February","March","April","May","June","July","August","September","October","November","December"];
function template(inner){
  const parts = splitTop(inner, "|").map(p => p.trim());
  const name = parts[0].toLowerCase().replace(/_/g, " ");
  const args = parts.slice(1).filter(p => !/^\w+\s*=/.test(p));
  const named = Object.fromEntries(parts.slice(1).filter(p => /^\w+\s*=/.test(p)).map(p => { const e = p.indexOf("="); return [p.slice(0, e).trim(), p.slice(e + 1).trim()]; }));
  if (/^(hlist|flatlist|plainlist|ubl|unbulleted list|bulleted list|flat list|plain list|nowrap|nobr|small|lang|lang-\w+)$/.test(name)){
    if (/^lang/.test(name)) return args[args.length - 1] || "";
    return args.join("\n");
  }
  if (/^(start date|release date|start date and age|film date|dts)$/.test(name)){
    const [y, mo, d] = args.map(Number);
    if (!y) return "";
    return [y, mo && MONTHS[mo - 1], d].filter(Boolean).length === 3 ? `${MONTHS[mo - 1]} ${d}, ${y}` : mo ? `${MONTHS[mo - 1]} ${y}` : String(y);
  }
  if (/^duration$/.test(name)){
    if (named.m || named.s || named.h) return [named.h, named.m || (named.h ? "0" : ""), (named.s || "0").padStart(2, "0")].filter(x => x !== undefined && x !== "").join(":");
    return args.join(":");
  }
  if (/^(albumchart|singlechart|cite|efn|refn|sfn|citation|r|ref|#tag|cn|citation needed|nbsp|snd|spaced ndash|endash|·|dot)$/.test(name) || /^cite/.test(name)) return name === "·" || name === "dot" ? "\n" : "";
  return "";
}
function cleanValue(v){
  let s = (v || "")
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<ref[^>]*\/>/gi, "")
    .replace(/<ref[^>]*>[\s\S]*?<\/ref>/gi, "")
    .replace(/<br\s*\/?>/gi, "\n");
  // expand templates from the innermost out
  for (let n = 0; n < 20 && /\{\{/.test(s); n++) s = s.replace(/\{\{([^{}]*)\}\}/g, (_, inner) => template(inner));
  s = s.replace(/\[\[(?:[^\]|]*\|)?([^\]]*)\]\]/g, "$1")   // [[target|text]] -> text
       .replace(/\[https?:\/\/\S+\s+([^\]]*)\]/g, "$1")    // [url text] -> text
       .replace(/'{2,}/g, "")
       .replace(/<[^>]+>/g, "")
       .replace(/&nbsp;/g, " ").replace(/&amp;/g, "&");
  return s.replace(/[ \t]+/g, " ").trim();
}
function list(v, splitCommas){
  const s = cleanValue(v);
  const parts = s.split(/\n|\s*[•·]\s*/).map(x => x.replace(/^\s*\*\s*/, "").trim());
  const out = [];
  for (const p of parts) for (const q of (splitCommas ? p.split(/\s*[,;]\s*/) : [p])){
    const t = q.replace(/^and\s+/i, "").replace(/\s*\([^)]*\)\s*$/, m => /^\s*\((uk|us|eu|europe|north america|japan|reissue)/i.test(m) ? m : "").trim();
    if (t && !out.some(o => o.toLowerCase() === t.toLowerCase())) out.push(t);
  }
  return out;
}
const first = s => cleanValue(s).split("\n").map(x => x.replace(/^\s*\*\s*/, "").trim()).filter(Boolean)[0] || "";
const one = s => cleanValue(s).split("\n").map(x => x.replace(/^\s*\*\s*/, "").trim()).filter(Boolean).join("; ");

function toInfo(page, box){
  const f = box || {};
  const summary = (page.extract || "").trim();
  return {
    title: page.title,
    url: "https://en.wikipedia.org/wiki/" + encodeURIComponent(page.title.replace(/ /g, "_")),
    pageid: page.pageid,
    wikidata: (page.pageprops || {}).wikibase_item || null,
    summary: summary.length > 2000 ? summary.slice(0, 2000).replace(/\s\S*$/, "") + "…" : summary,
    image: (page.thumbnail || {}).source || null,
    type: first(f.type) || null,
    artist: first(f.artist) || null,
    released: first(f.released || f.release_date) || null,
    recorded: one(f.recorded) || null,
    studio: one(f.studio) || null,
    length: first(f.length) || null,
    genres: list(f.genre, true),
    labels: list(f.label, false),
    producers: list(f.producer, false),
    fetchedAt: new Date().toISOString()
  };
}

/* ---------- matching ---------- */
const PAGE_PROPS = { prop: "extracts|pageprops|pageimages|revisions", exintro: "1", explaintext: "1", exlimit: "max",
  ppprop: "wikibase_item|disambiguation", piprop: "thumbnail", pithumbsize: "500", pilimit: "max", rvprop: "content", rvslots: "main", rvsection: "0", redirects: "1" };

function judge(page, artist){
  if (!page || page.missing || (page.pageprops && "disambiguation" in page.pageprops)) return null;
  const text = ((page.revisions || [])[0] || {}).slots?.main?.content || "";
  const box = findInfobox(text);
  if (!box) return null;
  const boxArtist = cleanValue(box.artist || "");
  // "Various artists" soundtracks etc. pass if Spotify agrees
  if (artist && boxArtist && !sameArtist(boxArtist, artist) && !boxArtist.split(/\n|,| and | & /).some(x => sameArtist(x, artist))) return null;
  return toInfo(page, box);
}
// revisions content can only be fetched for one page per request, so check candidates one at a time
async function tryTitle(title, artist){
  const j = await api({ action: "query", titles: title, ...PAGE_PROPS });
  return judge((j.query?.pages || [])[0], artist);
}
async function find(album){
  const artist = firstArtist(album);
  const titles = [...new Set([album.name.trim(), cleanTitle(album.name)])];   // exact name first, so "1989 (Taylor's Version)" beats "1989"
  // 1. Wikipedia's usual article names: ask which exist in one request, then read those in order
  const cands = [...new Set(titles.flatMap(t => [`${t} (${artist} album)`, `${t} (album)`, t]))];
  const ex = await api({ action: "query", titles: cands.join("|"), redirects: "1", prop: "pageprops", ppprop: "disambiguation" });
  const q = ex.query || {};
  const hop = (list, t) => ((list || []).find(x => x.from === t) || {}).to || t;
  const ok = new Set((q.pages || []).filter(p => !p.missing && !p.invalid && !(p.pageprops && "disambiguation" in p.pageprops)).map(p => p.title));
  const tried = new Set();
  for (const c of cands){
    const t = hop(q.redirects, hop(q.normalized, c));
    if (!ok.has(t) || tried.has(t)) continue;
    tried.add(t);
    const hit = await tryTitle(t, artist);
    if (hit) return hit;
  }
  // 2. full-text search, then check the top few hits
  const j = await api({ action: "query", list: "search", srsearch: `"${titles[titles.length - 1]}" ${artist} album`, srlimit: "5", srnamespace: "0", srprop: "" });
  for (const r of (j.query?.search || [])){
    if (tried.has(r.title)) continue;
    if (!norm(r.title).includes(norm(titles[titles.length - 1]).split(" ").slice(0, 3).join(" "))) continue;
    const hit = await tryTitle(r.title, artist);
    if (hit) return hit;
  }
  return null;
}

/* ---------- public ---------- */
const inflight = new Map();
function lookup(album){
  if (!album || !album.name) return Promise.resolve(null);
  const c = cached(album);
  if (c !== undefined) return Promise.resolve(c);
  const k = key(album);
  if (!inflight.has(k)){
    inflight.set(k, find(album)
      .then(v => { store.set(k, { t: Date.now(), v }); return v; })
      .catch(() => null)                    // network trouble: don't cache, try again next visit
      .finally(() => inflight.delete(k)));
  }
  return inflight.get(k);
}
async function lookupAll(albums, onEach){
  const out = new Map();
  await Promise.all((albums || []).filter(Boolean).map(a => lookup(a).then(v => { out.set(key(a), v); if (onEach) onEach(a, v); })));
  return out;
}

const Wiki = { lookup, lookupAll, cached, clear, _test: { findInfobox, cleanValue, cleanTitle, toInfo, list, norm, sameArtist } };
if (typeof window !== "undefined") window.Wiki = Wiki;
if (typeof module !== "undefined") module.exports = Wiki;
})();
