/* Discover: albums related to one album you like, each with a few sentences saying why it's there.
 *
 * Load after wiki.js with <script src="discover.js"></script>, then:
 *   Discover.find(seed, { owned }) -> Promise<{ seed, recs, at }>
 *     seed  = { name, artist, year, src }          the album at the centre
 *     owned = (name, artist) => bool               albums you already have are skipped
 *     recs  = [{ kind, name, artist, year, src, url, dz, why, critic }]
 *             kind: "sound" (sounds like it), "fans" (its listeners also play), "link" (a documented connection)
 *   Discover.render(el, state, { onPick })         draws the page; onPick(rec) when an album in the row is clicked
 *
 * Where it looks, all free and readable straight from the browser:
 *   Deezer        similar artists and each artist's most-loved album (also covers and links)
 *   ListenBrainz  artists people play in the same listening sessions (open listening data, MusicBrainz ids)
 *   MusicBrainz   the artist's id, so ListenBrainz and Wikidata can be asked about the right one
 *   Wikidata      sourced influences, shared band members, shared producers
 *   Wikipedia     each album's genres, and the critics it cites (Pitchfork, Rolling Stone, the Village
 *                 Voice's Pazz & Jop, AllMusic, ...). A sentence that ties two artists together counts as
 *                 critic-backed only when its footnote is one of those publications.
 */
(function(){
"use strict";

// a line in the ?debug panel, when the page is opened with ?debug
const log = (...m) => { try{ window.dbg && window.dbg(...m); }catch{} };
const norm = s => (s || "").normalize("NFKD").replace(/[̀-ͯ]/g, "").toLowerCase()
  .replace(/&/g, " and ").replace(/^the\s+/, "").replace(/[^a-z0-9]+/g, " ").trim();
const keyOf = (name, artist) => norm(name) + "|" + norm(artist);
const yearOf = d => { const y = parseInt(String(d || "").slice(0, 4), 10); return y > 1000 ? y : null; };
const sleep = ms => new Promise(r => setTimeout(r, ms));
const cap = (p, ms, fallback) => Promise.race([p, sleep(ms).then(() => fallback)]).catch(() => fallback);
const LIVE = /\b(live|greatest hits|best of|hits|collection|anthology|essential|essentials|remix(es)?|karaoke|tribute|instrumentals?|unplugged|sessions|demos?|b-sides|rarities|playlist|edition|remaster(ed)?)\b/i;

/* ---------- remembered answers ----------
   Every answer is kept in this browser for a while, so exploring around the same music asks the
   other sites only for what isn't known yet. fn returning undefined means "don't remember" (it failed). */
const MEMO = "dz.cache.";
const hash = s => { let h = 5381; for (let i = 0; i < s.length; i++) h = (h * 33 ^ s.charCodeAt(i)) >>> 0; return h.toString(36); };
function save(k, e){
  const v = JSON.stringify(e);
  if (v.length > 40000) return; // too big to be worth keeping
  try{ localStorage.setItem(k, v); }
  catch{ // storage full: forget the remembered answers (never anything else) and try once more
    try{ Object.keys(localStorage).filter(x => x.startsWith(MEMO)).forEach(x => localStorage.removeItem(x)); localStorage.setItem(k, v); }catch{}
  }
}
const inflight = new Map();
function remember(kind, key, days, fn){
  const k = MEMO + kind + "." + (key.length > 80 ? hash(key) : key);
  try{ const e = JSON.parse(localStorage.getItem(k)); if (e && Date.now() - e.t < days * 864e5) return Promise.resolve(e.v); }catch{}
  if (!inflight.has(k)) inflight.set(k, Promise.resolve().then(fn).then(v => { if (v !== undefined) save(k, { t: Date.now(), v }); return v ?? null; }, () => null).finally(() => inflight.delete(k)));
  return inflight.get(k);
}

/* ---------- Deezer (read as a script, since it doesn't let other sites fetch it) ---------- */
let dzActive = 0; const dzWait = [];
function deezer(path){
  return new Promise((resolve) => {
    const run = async () => {
      dzActive++;
      try{
        for (let i = 0; i < 3; i++){
          const j = await jsonp("https://api.deezer.com" + path + (path.includes("?") ? "&" : "?") + "output=jsonp");
          if (j && j.error && j.error.code === 4){ await sleep(1200); continue; } // too many requests for a moment
          resolve(j && !j.error ? j : null); return;
        }
        resolve(null);
      }catch{ resolve(null); }
      finally{ await sleep(120); dzActive--; if (dzWait.length) dzWait.shift()(); }
    };
    dzActive < 4 ? run() : dzWait.push(run);
  });
}
function jsonp(url){
  return new Promise((res, rej) => {
    const cb = "_dz" + Math.random().toString(36).slice(2), s = document.createElement("script");
    const t = setTimeout(() => { window[cb] = () => {}; s.remove(); rej(new Error("timeout")); }, 8000);
    window[cb] = j => { clearTimeout(t); window[cb] = () => {}; s.remove(); res(j); };
    s.onerror = () => { clearTimeout(t); s.remove(); rej(new Error("failed")); };
    s.src = url + "&callback=" + cb;
    document.head.appendChild(s);
  });
}
function dzArtist(name){
  return remember("dzartist", norm(name), 180, async () => {
    const j = await deezer("/search/artist?limit=5&q=" + encodeURIComponent(name));
    if (!j) return undefined;
    const a = (j.data || []).find(a => norm(a.name) === norm(name));
    return a ? { id: a.id, name: a.name } : null;
  });
}
const dzRelated = id => remember("dzrelated", String(id), 30, async () => {
  const j = await deezer(`/artist/${id}/related?limit=25`);
  return j ? (j.data || []).map(a => ({ id: a.id, name: a.name })) : undefined;
});
async function dzSeedAlbum(name, artist){
  const j = await deezer("/search/album?limit=10&q=" + encodeURIComponent(`artist:"${artist}" album:"${name}"`));
  const n = norm(name), a = norm(artist);
  // the album itself, never "Disc 2" or another edition when the plain one is there
  const mine = (j?.data || []).filter(x => norm(x.artist?.name) === a);
  return mine.find(x => norm(x.title) === n) || mine.find(x => norm(x.title).startsWith(n) && !/\b(disc|cd|bonus|deluxe|live|demo|remix)/i.test(x.title)) || null;
}
// an artist's most-loved album on Deezer: studio albums (or EPs) only, skipping ones you already have
// an artist's studio albums and EPs, most-loved first (only what's needed is kept)
const dzAlbums = id => remember("dzalbums", String(id), 30, async () => {
  const j = await deezer(`/artist/${id}/albums?limit=100`);
  if (!j) return undefined;
  return (j.data || []).filter(a => a.title && (a.record_type === "album" || a.record_type === "ep") && !LIVE.test(a.title))
    .sort((x, y) => (y.fans || 0) - (x.fans || 0)).slice(0, 15)
    .map(a => ({ id: a.id, title: a.title, record_type: a.record_type, fans: a.fans || 0, release_date: a.release_date, cover_big: a.cover_big, cover_xl: a.cover_xl, link: a.link }));
});
async function bestAlbum(artistId, artistName, owned){
  const all = await dzAlbums(artistId);
  const seen = new Set();
  const list = (all || []).filter(a => {
    if (!a.title || !(a.record_type === "album" || a.record_type === "ep") || LIVE.test(a.title)) return false;
    const k = norm(a.title.replace(/\s*[\(\[].*$/, ""));
    if (seen.has(k) || owned(a.title, artistName)) return false;
    seen.add(k); return true;
  });
  if (!list.length) return null;
  const albumsFirst = list.filter(a => a.record_type === "album");
  const pool = albumsFirst.length ? albumsFirst : list;
  return pool.slice().sort((x, y) => (y.fans || 0) - (x.fans || 0))[0];
}
const dzRec = (a, artist) => ({ name: a.title, artist, year: yearOf(a.release_date), dz: a.id,
  src: a.cover_big || a.cover_medium || "", big: a.cover_xl || a.cover_big || "", url: a.link || ("https://www.deezer.com/album/" + a.id) });

/* ---------- MusicBrainz, ListenBrainz ---------- */
function mbArtist(name){
  return remember("mbartist", norm(name), 365, async () => {
    const r = await fetch("https://musicbrainz.org/ws/2/artist?fmt=json&limit=5&query=" + encodeURIComponent(`artist:"${name}"`));
    if (!r.ok) return undefined;
    const want = norm(name);
    return ((await r.json()).artists || []).find(a => norm(a.name) === want && (a.score || 0) >= 90)?.id || null;
  });
}
const listenBrainz = mbid => remember("lb", mbid, 30, () => listenBrainzLive(mbid)).then(v => v || []);
async function listenBrainzLive(mbid){
  try{
    const r = await fetch("https://labs.api.listenbrainz.org/similar-artists/json?artist_mbids=" + mbid +
      "&algorithm=session_based_days_7500_session_300_contribution_5_threshold_10_limit_100_filter_True_skip_30");
    if (!r.ok) return undefined;
    const j = await r.json();
    const rows = Array.isArray(j) ? j.flatMap(x => Array.isArray(x?.data) ? x.data : [x]) : [];
    return rows.filter(x => x && x.name && x.artist_mbid && x.artist_mbid !== mbid).sort((a, b) => (b.score || 0) - (a.score || 0))
      .slice(0, 25).map(x => ({ name: x.name, artist_mbid: x.artist_mbid, score: x.score }));
  }catch{ return undefined; }
}

/* ---------- Wikidata ---------- */
function sparql(q){
  return remember("wd", q.replace(/\s+/g, " "), 60, async () => {
    const r = await fetch("https://query.wikidata.org/sparql?format=json&query=" + encodeURIComponent(q), { headers: { Accept: "application/sparql-results+json" } });
    if (!r.ok) return undefined;
    return ((await r.json()).results?.bindings || []).map(b => Object.fromEntries(Object.entries(b).map(([k, v]) => [k, v.value])));
  }).then(v => v || []);
}
// influences only count when Wikidata records where the claim comes from
const artistLinks = mbid => sparql(`
SELECT DISTINCT ?kind ?otherLabel ?viaLabel ?article WHERE {
  ?a wdt:P434 "${mbid}" .
  OPTIONAL { ?article schema:about ?a ; schema:isPartOf <https://en.wikipedia.org/> . }
  {
    ?a p:P737 ?st . ?st ps:P737 ?other . ?st prov:wasDerivedFrom ?ref . BIND("influencedBy" AS ?kind)
  } UNION {
    ?other p:P737 ?st . ?st ps:P737 ?a . ?st prov:wasDerivedFrom ?ref . BIND("influenced" AS ?kind)
  } UNION {
    { ?via wdt:P463 ?a } UNION { ?a wdt:P527 ?via }
    ?via wdt:P31 wd:Q5 .
    { ?via wdt:P463 ?other } UNION { ?other wdt:P527 ?via }
    FILTER(?other != ?a) BIND("member" AS ?kind)
  } UNION {
    ?a wdt:P463 ?other . BIND("memberOf" AS ?kind)
  }
  ?other wdt:P434 ?om .
  SERVICE wikibase:label { bd:serviceParam wikibase:language "en". }
} LIMIT 80`);
const producerLinks = qid => sparql(`
SELECT DISTINCT ?viaLabel ?albLabel ?perfLabel ?date WHERE {
  wd:${qid} wdt:P162 ?via ; wdt:P175 ?seedPerf .
  ?alb wdt:P162 ?via ; wdt:P31 wd:Q482994 ; wdt:P175 ?perf .
  FILTER(?alb != wd:${qid} && ?perf != ?seedPerf)
  OPTIONAL { ?alb wdt:P577 ?date }
  SERVICE wikibase:label { bd:serviceParam wikibase:language "en". }
} LIMIT 40`);

/* ---------- Wikipedia: the critics an article cites ---------- */
const CRITICS = [
  [/pitchfork/i, "Pitchfork"], [/rolling\s*stone/i, "Rolling Stone"], [/pazz|village\s*voice|villagevoice/i, "The Village Voice"],
  [/christgau/i, "Robert Christgau"], [/allmusic/i, "AllMusic"], [/\bnme\b|nme\.com/i, "NME"], [/spin\.com|(magazine|work|website|publisher)\s*=\s*\[*spin\b/i, "Spin"],
  [/theguardian|the guardian|guardian\.co/i, "The Guardian"], [/stereogum/i, "Stereogum"], [/the\s*quietus|thequietus/i, "The Quietus"],
  [/consequence/i, "Consequence"], [/\buncut\b/i, "Uncut"], [/\bmojo\b/i, "Mojo"], [/(magazine|work|website|publisher)\s*=\s*\[*q( magazine)?\b/i, "Q"],
  [/\bthe wire\b|thewire\.co/i, "The Wire"], [/\bnpr\b|npr\.org/i, "NPR"], [/nytimes|new york times/i, "The New York Times"],
  [/av\s*club|avclub/i, "The A.V. Club"], [/slant/i, "Slant"], [/billboard/i, "Billboard"], [/popmatters/i, "PopMatters"],
  [/drowned\s*in\s*sound|drownedinsound/i, "Drowned in Sound"], [/paste(magazine|\s*magazine)/i, "Paste"], [/tiny\s*mix\s*tapes|tinymixtapes/i, "Tiny Mix Tapes"]
];
const outletOf = ref => (CRITICS.find(([re]) => re.test(ref)) || [])[1] || null;
const textCache = new Map();
function articleText(title){
  if (!title) return Promise.resolve("");
  if (!textCache.has(title)) textCache.set(title, (async () => {
    try{
      const qs = new URLSearchParams({ action: "query", format: "json", formatversion: "2", origin: "*", redirects: "1", prop: "revisions", rvprop: "content", rvslots: "main", titles: title });
      const r = await fetch("https://en.wikipedia.org/w/api.php?" + qs);
      if (!r.ok) return null;
      return (((await r.json()).query?.pages || [])[0]?.revisions || [])[0]?.slots?.main?.content || "";
    }catch{ return null; }
  })());
  return textCache.get(title);
}
// only the sentences whose footnotes cite a critic are ever used, so only those are kept
const criticSentences = title => !title ? Promise.resolve([]) : remember("crit", title, 60, async () => {
  const t = await articleText(title);
  return t === null ? undefined : sentences(t).filter(s => s.outlets.length);
}).then(v => v || []);
// every sentence of an article, with the publications its footnotes cite
function sentences(wikitext){
  if (!wikitext) return [];
  const clean = (window.Wiki && Wiki._test && Wiki._test.cleanValue) || (s => s);
  let t = wikitext.replace(/<!--[\s\S]*?-->/g, "");
  const named = {};
  t.replace(/<ref\s+name\s*=\s*"?([^">\/]+?)"?\s*>([\s\S]*?)<\/ref>/gi, (_, n, c) => { named[n.trim()] = c; return ""; });
  const refs = [];
  t = t.replace(/<ref\s+name\s*=\s*"?([^">\/]+?)"?\s*\/>/gi, (_, n) => (refs.push(named[n.trim()] || ""), "\u0001" + (refs.length - 1) + "\u0002"))
       .replace(/<ref[^>\/]*>([\s\S]*?)<\/ref>/gi, (_, c) => (refs.push(c), "\u0001" + (refs.length - 1) + "\u0002"))
       .replace(/\{\{\s*(sfn|harvnb)[^{}]*\}\}/gi, m => (refs.push(m), "\u0001" + (refs.length - 1) + "\u0002"));
  const out = [];
  for (const para of t.split(/\n+/)){
    if (!para.trim() || /^\s*[\{\|!=*#:]/.test(para)) continue; // templates, tables, headings, lists
    for (const s of para.split(/(?<=[.!?]["”’']?(?:\u0001\d+\u0002)*)\s+(?=["“A-Z0-9\[])/)){
      const ids = [...s.matchAll(/\u0001(\d+)\u0002/g)].map(m => +m[1]);
      const text = clean(s.replace(/\u0001\d+\u0002/g, "")).replace(/\s+/g, " ").trim();
      if (text.length < 25) continue;
      const outlets = [...new Set(ids.map(i => outletOf(refs[i] || "")).filter(Boolean))];
      const links = [...s.matchAll(/\[\[([^\]|#]+)/g)].map(m => m[1].trim()).filter(l => !/^(file|image|category):/i.test(l));
      out.push({ text, outlets, links });
    }
  }
  return out;
}
function mentions(text, name){
  const n = norm(name);
  if (n.length < 3) return false;
  if (n.length < 5 && !new RegExp("\\b" + name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "\\b").test(text)) return false; // short names: exact case
  return (" " + norm(text) + " ").includes(" " + n + " ");
}
// a critic-backed sentence in these sentences that names any of the given names
const criticLine = (sents, names) => sents.find(s => s.outlets.length && names.some(n => n && mentions(s.text, n))) || null;
const ACCOLADE = /pazz|best albums|greatest albums|albums of (the|all)|top \d+|ranked|named it|year-end|list of/i;
const accolade = sents => sents.find(s => s.outlets.length && ACCOLADE.test(s.text) && s.text.length < 260) || null;
const trim = (s, n = 230) => s.length > n ? s.slice(0, n).replace(/\s\S*$/, "") + "…" : s;

/* ---------- putting it together ---------- */
const list = xs => xs.length < 2 ? xs.join("") : xs.slice(0, -1).join(", ") + " and " + xs[xs.length - 1];
const lc = g => /^[A-Z][a-z]/.test(g) && !/^(K|J|C)-pop|^Britpop/i.test(g) ? g[0].toLowerCase() + g.slice(1) : g;

async function find(seed, opts = {}){
  const owned = opts.owned || (() => false);
  const A = seed.artist, T = seed.name;
  const wikiAlbum = a => window.Wiki ? cap(Wiki.lookup({ name: a.name, artists: [{ name: a.artist }] }), 9000, null) : Promise.resolve(null);

  // 1. the album itself and its artist, everywhere at once
  const [dzA, mbid, seedWiki] = await Promise.all([cap(dzArtist(A), 9000, null), cap(mbArtist(A), 9000, null), wikiAlbum(seed)]);
  const [related, lb, links, prods, seedText] = await Promise.all([
    dzA ? cap(dzRelated(dzA.id), 9000, []).then(v => v || []) : [],
    mbid ? cap(listenBrainz(mbid), 9000, []) : [],
    mbid ? cap(artistLinks(mbid), 12000, []) : [],
    seedWiki?.wikidata ? cap(producerLinks(seedWiki.wikidata), 12000, []) : [],
    seedWiki ? cap(criticSentences(seedWiki.title), 9000, []) : []
  ]);
  log(`Discover ${T}: Deezer ${dzA ? "found the artist" : "no artist"}, ${related.length} similar; ListenBrainz ${lb.length}; ` +
    `MusicBrainz ${mbid ? "found" : "no artist"}; Wikidata ${links.length} links, ${prods.length} producer albums; Wikipedia ${seedWiki ? seedWiki.title : "no article"}`);
  const artistArticle = links.find(l => l.article)?.article;
  const seedSents = seedText.concat(artistArticle ? await cap(criticSentences(decodeURIComponent(artistArticle.split("/wiki/")[1] || "").replace(/_/g, " ")), 9000, []) : []);

  // 2. candidate artists, with what each source says about them. A refresh (round 1, 2, ...) skips every
  //    artist already shown and reaches one step further: the artists Deezer puts next to the closest ones.
  const round = opts.round || 0, exclude = new Set([...(opts.exclude || [])].map(norm));
  const cands = new Map();
  const cand = name => { const k = norm(name); if (!k || k === norm(A) || exclude.has(k)) return null; if (!cands.has(k)) cands.set(k, { name, src: {} }); return cands.get(k); };
  related.forEach((a, i) => { const c = cand(a.name); if (c){ c.src.deezer = i + 1; c.dzId = a.id; } });
  lb.forEach((a, i) => { const c = cand(a.name); if (c) c.src.lb = i + 1; });
  for (const l of links){
    const c = cand(l.otherLabel);
    if (!c) continue;
    (c.src.links ||= []).push({ kind: l.kind, via: l.viaLabel });
  }
  if (round > 0){
    const hubs = related.slice((round - 1) * 4, (round - 1) * 4 + 6);
    const second = await Promise.all(hubs.map(h => cap(dzRelated(h.id), 9000, []).then(v => (v || []).map(a => ({ ...a, via: h.name })))));
    second.forEach(list => list.slice(0, 10).forEach((a, i) => {
      const c = cand(a.name);
      if (c && !c.src.deezer && !c.src.lb && !c.src.links && !c.src.via){ c.src.via = a.via; c.src.second = i + 1; c.dzId = a.id; }
    }));
  }

  // 3. each artist's best album (Deezer), and its Wikipedia article
  const pick = [...cands.values()]
    .map(c => ({ c, score: (c.src.links ? 0 : 100) + Math.min(c.src.deezer || 99, c.src.lb || 99, c.src.second ? 30 + c.src.second : 99) }))
    .sort((a, b) => a.score - b.score).slice(0, 18).map(x => x.c);
  const resolved = await Promise.all(pick.map(async c => {
    const id = c.dzId || (await dzArtist(c.name))?.id;
    if (!id) return null;
    const al = await bestAlbum(id, c.name, owned);
    return al ? { c, rec: dzRec(al, c.name) } : null;
  }));
  // albums shaped by the same producer (straight from Wikidata, then found on Deezer)
  const prodRecs = await Promise.all(prods.filter(p => p.albLabel && p.perfLabel && !/^Q\d+$/.test(p.albLabel)).slice(0, 8).map(async p => {
    if (owned(p.albLabel, p.perfLabel) || cands.has(norm(p.perfLabel)) || exclude.has(norm(p.perfLabel)) || norm(p.perfLabel) === norm(A)) return null;
    const al = await dzSeedAlbum(p.albLabel, p.perfLabel);
    return al ? { c: { name: p.perfLabel, src: { producer: p.viaLabel } }, rec: { ...dzRec(al, p.perfLabel), year: yearOf(p.date) || yearOf(al.release_date) } } : null;
  }));
  const found = [...resolved, ...prodRecs].filter(Boolean);
  const seen = new Set();
  const uniq = found.filter(x => { const k = keyOf(x.rec.name, x.rec.artist); if (seen.has(k)) return false; seen.add(k); return true; });
  await Promise.all(uniq.map(async x => {
    x.wiki = await wikiAlbum(x.rec);
    x.sents = x.wiki ? await cap(criticSentences(x.wiki.title), 9000, []) : [];
  }));

  // 4. the reasons, from what was found: short, and not all worded the same way
  const seedGenres = (seedWiki?.genres || []).map(g => g.trim()).filter(Boolean);
  const out = [];
  for (const x of uniq){
    const { c, rec, wiki, sents } = x, B = c.name;
    const shared = seedGenres.filter(g => (wiki?.genres || []).some(h => norm(h) === norm(g)));
    // a critic tying the two together, in either album's article (or the artist's)
    const tie = criticLine(sents, [A, T]) || criticLine(seedSents, [B, rec.name]);
    const link = (c.src.links || [])[0];
    const kind = link || c.src.producer ? "link" : shared.length ? "sound" : "fans";
    const why = [reason(kind, { A, B, T, R: rec.name, g: list(shared.slice(0, 2).map(lc)), src: c.src, link })];
    if (tie) why.push(`${tie.outlets[0]}, via Wikipedia: “${trim(tie.text, 100)}”`);
    const strength = (tie ? -50 : 0) + (kind === "sound" ? -shared.length * 5 : 0) +
      Math.min(c.src.deezer || 40, c.src.lb || 40, c.src.second ? 20 + c.src.second : 40) - (c.src.deezer && c.src.lb ? 10 : 0);
    out.push({ kind, ...rec, why: why.join(" "), critic: tie ? tie.outlets[0] : null, strength });
  }
  const group = k => out.filter(r => r.kind === k).sort((a, b) => a.strength - b.strength).slice(0, k === "link" ? 6 : 8);
  const recs = [...group("sound"), ...group("fans"), ...group("link")].map(({ strength, ...r }) => r);
  log(`Discover ${T}${round ? " (refresh " + round + ")" : ""}: ${uniq.length} albums found, ${recs.length} shown`);
  return { seed: { ...seed, genres: seedGenres }, recs, at: Date.now() };
}

// One short sentence saying why, picked from a few wordings by the artist's name, so it stays the
// same for the same album but neighbouring albums don't all read alike.
const WORDS = {
  soundBoth: ["{g} like {T}, and Deezer and ListenBrainz both tie {B} to {A}.", "Same {g} pull as {T}; listeners on Deezer and ListenBrainz pair them.", "{g} in the {A} mould, linked to them on Deezer and ListenBrainz."],
  soundDeezer: ["Shares {T}'s {g}, and Deezer ranks {B} close to {A}.", "More {g}; Deezer files {B} right beside {A}.", "{g} like {T}. Deezer counts {B} among {A}'s nearest neighbours."],
  soundLb: ["{g} like {T}, and {A} fans on ListenBrainz play it often.", "Built on the same {g} as {T}; ListenBrainz listeners pair the two.", "Another {g} record that {A} listeners keep reaching for."],
  soundSecond: ["{g} like {T}, and a close neighbour of {via} on Deezer.", "Same {g} family; Deezer links {B} to {via}, a near relative of {A}."],
  sound: ["{g}, just like {T}.", "Wikipedia files it under {g}, same as {T}."],
  fansBoth: ["Deezer and ListenBrainz both place {B} near {A}.", "Listeners on Deezer and ListenBrainz alike pair {B} with {A}.", "A go-to next listen for {A} fans, by Deezer's and ListenBrainz's counts."],
  fansDeezer: ["Deezer lists {B} among the artists closest to {A}.", "On Deezer, {B} sits right next to {A}.", "Deezer's listeners keep linking {B} with {A}."],
  fansLb: ["ListenBrainz listeners who play {A} keep coming back to {B}.", "A frequent next listen for {A} fans, per ListenBrainz.", "{A} listeners on ListenBrainz often put on {B} in the same sitting."],
  fansSecond: ["One step out: Deezer pairs {B} with {via}, a close relative of {A}.", "Deezer links {B} to {via}, who sits right beside {A}."],
  influencedBy: ["{B} is a documented influence on {A} (Wikidata, cited).", "Where {A} came from: Wikidata lists {B} as an influence, with a source."],
  influenced: ["{A} is a documented influence on {B} (Wikidata, cited).", "Carries {A}'s torch: Wikidata lists {A} as an influence on {B}, with a source."],
  memberOf: ["{A} was a member of {B} (Wikidata).", "Shares people with {A}: {A} played in {B} (Wikidata)."],
  member: ["{via} played in both {A} and {B} (Wikidata).", "Same hands: {via} is in {A} and {B} (Wikidata)."],
  producer: ["{via} produced both {T} and {R} (Wikidata).", "Same producer as {T}: {via} (Wikidata)."]
};
function reason(kind, v){
  const s = v.src, by = s.deezer && s.lb ? "Both" : s.deezer ? "Deezer" : s.lb ? "Lb" : s.second ? "Second" : "";
  let key = kind === "link" ? (s.producer ? "producer" : v.link.kind) : kind + by;
  if (!WORDS[key]) key = kind === "sound" ? "sound" : "fansDeezer";
  const via = s.producer || s.via || v.link?.via || "";
  const opts = WORDS[key], n = [...norm(v.B)].reduce((a, ch) => a + ch.charCodeAt(0), 0);
  const text = opts[n % opts.length].replace(/\{(\w+)\}/g, (_, k) => ({ A: v.A, B: v.B, T: v.T, R: v.R, g: v.g, via })[k] ?? "");
  return text[0].toUpperCase() + text.slice(1);
}

/* ---------- the page ---------- */
// Spotify's 300px cover address -> its 640px version of the very same image
const sharper = src => /i\.scdn\.co\/image\/ab67616d00001e02/.test(src || "") ? src.replace("ab67616d00001e02", "ab67616d0000b273") : null;
const LABEL = { sound: "Sounds like it", fans: "Fans also play", link: "Connected" };
function render(el, state, { onPick, onMore } = {}){
  const frag = document.createDocumentFragment();
  if (!state || !state.seed){
    const p = document.createElement("p"); p.className = "dz-empty";
    p.textContent = "Right-click any album and choose Discover.";
    frag.appendChild(p); el.replaceChildren(frag); return;
  }
  const s = state.seed;
  const hero = document.createElement("section"); hero.className = "dz-hero";
  const art = document.createElement("div"); art.className = "dz-art";
  const img = new Image(); img.alt = ""; img.draggable = false;
  if (s.src) img.src = s.src; else img.style.visibility = "hidden";
  // a sharper cover takes over once it has fully loaded, in the same spot
  // the same cover as in your library, in Spotify's larger size once that has loaded
  const big = sharper(s.src);
  if (big){ const hi = new Image(); hi.onload = () => { img.src = big; }; hi.src = big; }
  art.appendChild(img); hero.appendChild(art);
  const cap = document.createElement("div"); cap.className = "dz-cap";
  cap.append(Object.assign(document.createElement("div"), { className: "dz-name", textContent: s.name }),
    Object.assign(document.createElement("div"), { className: "dz-sub", textContent: [s.artist, s.year].filter(Boolean).join(" · ") }));
  // a new batch of albums, none of them already shown for this album
  if (onMore && !state.loading && state.recs && state.recs.length){
    const more = document.createElement("button"); more.className = "dz-more"; more.type = "button";
    more.textContent = state.busy ? "Finding new albums…" : state.exhausted ? "No new albums found" : "↻ Refresh";
    more.disabled = !!state.busy;
    more.onclick = () => onMore();
    cap.appendChild(more);
  }
  hero.appendChild(cap); frag.appendChild(hero);

  if (state.loading || !state.recs){
    const p = document.createElement("p"); p.className = "dz-note";
    p.textContent = state.loading ? "Looking for music related to " + s.name + "…" : "";
    frag.appendChild(p);
  } else if (!state.recs.length){
    const p = document.createElement("p"); p.className = "dz-note";
    p.textContent = "Couldn't find anything related to " + s.name + " this time. Try again in a minute.";
    frag.appendChild(p);
  } else {
    const row = document.createElement("div"); row.className = "dz-row";
    state.recs.forEach((r, i) => {
      const t = document.createElement("article"); t.className = "dz-tile"; t.dataset.i = i;
      const c = document.createElement("div"); c.className = "dz-cover";
      const label = document.createElement("i"); label.textContent = r.name; c.appendChild(label);
      if (r.src){
        label.style.opacity = 0;
        const im = new Image(); im.alt = ""; im.loading = "lazy"; im.draggable = false; im.dataset.dz = i;
        im.onload = () => im.classList.add("in");
        im.onerror = () => { im.remove(); label.style.opacity = ""; };
        im.src = r.src; c.appendChild(im);
      }
      t.appendChild(c);
      t.append(Object.assign(document.createElement("div"), { className: "dz-kind", textContent: (LABEL[r.kind] || "") + (r.added && Date.now() - r.added < 30 * 864e5 ? " · New" : "") }),
        Object.assign(document.createElement("div"), { className: "dz-title", textContent: r.name }),
        Object.assign(document.createElement("div"), { className: "dz-sub", textContent: [r.artist, r.year].filter(Boolean).join(" · ") }),
        Object.assign(document.createElement("p"), { className: "dz-why", textContent: r.why }));
      t.onclick = () => onPick && onPick(r);
      row.appendChild(t);
    });
    frag.appendChild(row);
  }
  el.replaceChildren(frag);
}

// shared with lineage.js, which asks the same places
const Discover = { find, render, _src: { log, mbArtist, sparql, articleText, sentences, criticSentences, mentions, norm, cap, trim, list },
  _test: { sentences, mentions, criticLine, outletOf, accolade, norm } };
if (typeof window !== "undefined") window.Discover = Discover;
})();
