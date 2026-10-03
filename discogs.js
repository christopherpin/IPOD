/* Discogs lookup for albums.
 *
 * Load with <script src="discogs.js"></script>, then:
 *   Discogs.lookup(album)             -> Promise<info|null>   (album = a Spotify album object)
 *   Discogs.lookupAll(albums, onEach) -> Promise<Map(albumId -> info|null)>, onEach(album, info) as each lands
 *   Discogs.cached(album)             -> info | null | undefined (undefined = not looked up yet)
 *   Discogs.master(id)                -> Promise<full master release: tracklist, videos, images, ...>
 *   Discogs.ready()                   -> true once a key and secret are set
 *   Discogs.setCredentials(key, secret) -> keep a key/secret in this browser only (used by discogs-test.html)
 *   Discogs.clear()                   -> forget every cached lookup
 *
 * info = {
 *   id, kind,                 // Discogs id; kind "master" (all versions of an album) or "release" (one pressing)
 *   masterId, url,            // link to the Discogs page
 *   title, artist,
 *   year,                     // for a master: the year the album first came out, even if Spotify has a reissue
 *   genres:[], styles:[],     // Discogs "styles" are the finer genres: "Shoegaze", "Hard Bop", ...
 *   labels:[], formats:[], country,
 *   image, thumb,
 *   fetchedAt
 * }
 * null means Discogs has nothing we could confidently match.
 *
 * Credentials: Discogs only answers searches from a registered app. We use an app "consumer key" and
 * "consumer secret", which can search the public catalogue and nothing else: they can't see or change
 * anyone's Discogs account. Never put a "personal access token" here; that one is a key to the account.
 *
 * Talks to Discogs straight from the browser, one request at a time and no more than ~55 a minute
 * (Discogs allows 60), and caches every answer in localStorage under "discogs." so each album is only
 * fetched once.
 */
(function(){
"use strict";

// Fill these in once the Discogs app exists (see discogs-test.html). Safe to publish: search-only.
const KEY = "";
const SECRET = "";

const API = "https://api.discogs.com";
const PREFIX = "discogs.v1.";
const CRED = "discogs.credentials";
const HIT_TTL = 90 * 864e5, MISS_TTL = 14 * 864e5;
const GAP = 1100;   // ms between requests

/* ---------- credentials ---------- */
function creds(){
  if (KEY && SECRET) return { key: KEY, secret: SECRET };
  try{ const c = JSON.parse(localStorage.getItem(CRED) || "null"); if (c && c.key && c.secret) return c; }catch{}
  return null;
}
const ready = () => !!creds();
function setCredentials(key, secret){
  try{
    if (key && secret) localStorage.setItem(CRED, JSON.stringify({ key: String(key).trim(), secret: String(secret).trim() }));
    else localStorage.removeItem(CRED);
  }catch{}
}

/* ---------- cache ---------- */
const store = {
  get(k){ try{ const v = localStorage.getItem(PREFIX + k); return v == null ? undefined : JSON.parse(v); }catch{ return undefined; } },
  set(k, v){ try{ localStorage.setItem(PREFIX + k, JSON.stringify(v)); }catch{} }
};
function fresh(e){ return e && Date.now() - e.t <= (e.v ? HIT_TTL : MISS_TTL) ? e : undefined; }
function cached(album){
  const e = fresh(store.get(key(album)));
  return e ? e.v : undefined;
}
function clear(){
  try{ Object.keys(localStorage).filter(k => k.startsWith(PREFIX)).forEach(k => localStorage.removeItem(k)); }catch{}
  inflight.clear();
}
const key = a => a.id || norm(a.name) + "|" + norm(firstArtist(a));

/* ---------- request queue: one at a time, spaced out ---------- */
let chain = Promise.resolve(), last = 0;
const wait = ms => new Promise(s => setTimeout(s, ms));
function api(path, params){
  const job = chain.then(async () => {
    const c = creds();
    if (!c) throw new Error("Discogs key and secret not set");
    // credentials as query parameters: an Authorization header would cost a CORS preflight per request
    const qs = new URLSearchParams({ ...params, key: c.key, secret: c.secret });
    let r;
    for (let i = 0; i < 4; i++){
      await wait(Math.max(0, last + GAP - Date.now()));
      last = Date.now();
      r = await fetch(API + path + "?" + qs);
      if (r.status !== 429 && r.status < 500) break;
      await wait(r.status === 429 ? 15000 * (i + 1) : 1000 * 2 ** i);   // Discogs' limit is a 60-second window
    }
    if (!r.ok) throw new Error("Discogs error " + r.status);
    return r.json();
  });
  chain = job.catch(() => {});
  return job;
}

/* ---------- names ---------- */
const firstArtist = a => ((a.artists || [])[0] || {}).name || "";
function norm(s){
  return (s || "").normalize("NFKD").replace(/[̀-ͯ]/g, "").toLowerCase()
    .replace(/&/g, " and ").replace(/^the\s+/, "").replace(/[^a-z0-9]+/g, " ").trim();
}
// "Abbey Road (Remastered 2019)" -> "Abbey Road"
const EDITION = /\b(remaster(ed)?|deluxe|expanded|anniversary|edition|version|reissue|bonus|mono|stereo|live at|super|collector'?s?|special|legacy|bonus tracks?|\d{4} mix|remix(ed)?)\b/i;
function cleanTitle(t){
  let s = t || "";
  for (let i = 0; i < 3; i++) s = s.replace(/\s*[\(\[][^\)\]]*[\)\]]\s*$/, m => EDITION.test(m) ? "" : m);
  s = s.replace(/\s+[-–—:]\s+[^-–—:]*$/, m => EDITION.test(m) ? "" : m);
  return s.trim() || (t || "").trim();
}
// Discogs writes duplicate artist names as "Nirvana (2)" and "The Beatles" as "Beatles, The"
const discogsName = s => (s || "").replace(/\s*\(\d+\)\s*$/, "").replace(/^(.*),\s*(the|a|an)$/i, "$2 $1").replace(/\*$/, "");
const sameArtist = (a, b) => { const x = norm(discogsName(a)), y = norm(discogsName(b)); return !!x && !!y && (x === y || x.includes(y) || y.includes(x)); };

/* ---------- matching ---------- */
// search results come back titled "Artist - Album"
function splitTitle(t){
  const i = (t || "").indexOf(" - ");
  return i < 0 ? { artist: "", title: t || "" } : { artist: t.slice(0, i), title: t.slice(i + 3) };
}
function matches(r, artist, titles){
  const s = splitTitle(r.title);
  if (artist && !/^various$/i.test(discogsName(s.artist)) && !s.artist.split(/\s*[,&\/]\s*|\s+(?:and|feat\.?|with)\s+/i).some(x => sameArtist(x, artist)) && !sameArtist(s.artist, artist)) return false;
  const t = norm(s.title);
  return titles.some(x => norm(x) === t) || titles.some(x => norm(cleanTitle(s.title)) === norm(x));
}
function toInfo(r){
  const s = splitTitle(r.title);
  const kind = r.type === "master" ? "master" : "release";
  return {
    id: r.id,
    kind,
    masterId: kind === "master" ? r.id : (r.master_id || null),
    url: "https://www.discogs.com" + (r.uri || `/${kind}/${r.id}`),
    title: s.title,
    artist: discogsName(s.artist),
    year: Number(r.year) || null,
    genres: r.genre || [],
    styles: r.style || [],
    labels: [...new Set(r.label || [])],
    formats: [...new Set(r.format || [])],
    country: r.country || null,
    image: r.cover_image && !/spacer\.gif/.test(r.cover_image) ? r.cover_image : null,
    thumb: r.thumb || null,
    fetchedAt: new Date().toISOString()
  };
}
async function find(album){
  const artist = firstArtist(album);
  const titles = [...new Set([album.name.trim(), cleanTitle(album.name)])];
  const pick = list => (list || []).find(r => matches(r, artist, titles));
  // 1. the master: one entry per album, covering every pressing, with the original year
  const base = cleanTitle(album.name);
  let hit = pick((await api("/database/search", { type: "master", artist, release_title: base, per_page: "10" })).results);
  if (hit) return toInfo(hit);
  // 2. a looser search, in case Discogs spells the artist or title differently
  hit = pick((await api("/database/search", { type: "master", q: `${artist} ${base}`, per_page: "10" })).results);
  if (hit) return toInfo(hit);
  // 3. no master: some albums only exist as single releases. Take the earliest matching one.
  const rel = ((await api("/database/search", { type: "release", artist, release_title: base, per_page: "25" })).results || [])
    .filter(r => matches(r, artist, titles))
    .sort((a, b) => (Number(a.year) || 9999) - (Number(b.year) || 9999));
  return rel[0] ? toInfo(rel[0]) : null;
}

/* ---------- public ---------- */
const inflight = new Map();
function lookup(album){
  if (!album || !album.name || !ready()) return Promise.resolve(null);
  const c = cached(album);
  if (c !== undefined) return Promise.resolve(c);
  const k = key(album);
  if (!inflight.has(k)){
    inflight.set(k, find(album)
      .then(v => { store.set(k, { t: Date.now(), v }); return v; })
      .catch(() => null)                    // network trouble or bad key: don't cache, try again next visit
      .finally(() => inflight.delete(k)));
  }
  return inflight.get(k);
}
async function lookupAll(albums, onEach){
  const out = new Map();
  await Promise.all((albums || []).filter(Boolean).map(a => lookup(a).then(v => { out.set(key(a), v); if (onEach) onEach(a, v); })));
  return out;
}
// full master release (tracklist, videos, all images, notes), fetched on demand and cached
async function master(id){
  if (!id) return null;
  const e = fresh(store.get("master." + id));
  if (e) return e.v;
  const v = await api("/masters/" + id, {});
  store.set("master." + id, { t: Date.now(), v });
  return v;
}

const Discogs = { lookup, lookupAll, cached, master, ready, setCredentials, clear,
  _test: { cleanTitle, norm, sameArtist, discogsName, splitTitle, matches, toInfo } };
if (typeof window !== "undefined") window.Discogs = Discogs;
if (typeof module !== "undefined") module.exports = Discogs;
})();
