/* Family Tree: one album with the music that led to it below and the music it led to above.
 *
 * Load after discover.js with <script src="lineage.js"></script>, then:
 *   Lineage.find(seed) -> Promise<{ seed, before:[[gen1], [gen2]], after:[[gen1], [gen2]], lanes, at }>
 *     seed  = { name, artist, year, src }
 *     node  = { name, artist, year, src, why, lane, rg }
 *     lanes = genre names when the influences clearly split into separate genres, else []
 *   Lineage.render(el, state, { onPick })
 *
 * Only documented influences are used:
 *   Wikidata  "influenced by" statements that carry a reference (the reference is named in the note)
 *   Wikipedia sentences about influence in the album's or artist's article whose footnote is a critic
 *             (Pitchfork, Rolling Stone, the Village Voice, AllMusic, ...), via discover.js
 * Each artist is shown by one album: the best-known one (most Wikipedia languages) from before the
 * centre album for influences, from after it for those it influenced. Covers come from the Cover Art Archive.
 */
(function(){
"use strict";
const S = window.Discover._src;
const { norm, cap, trim, list } = S;
const LIVE = /\b(live|greatest hits|best of|hits|collection|anthology|essential|remix(es)?|tribute|unplugged|sessions|demos?|b-sides|rarities|box set|compilation)\b/i;
const INFLUENCE = /influenc|inspir|indebted|drew (on|from)|draws (on|from)|borrow|forebear|predecessor|pioneer|paved the way|precursor|lineage|homage|debt to|took cues|modell?ed/i;
const esc = s => s.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
const yearOf = d => { const y = parseInt(String(d || "").slice(0, 4), 10); return y > 1000 ? y : null; };
const host = u => { try{ return new URL(u).hostname.replace(/^www\./, ""); }catch{ return ""; } };

// "influenced by" in both directions, for one or more artists (by MusicBrainz id), with where each claim comes from
async function influences(mbids){
  if (!mbids.length) return [];
  const rows = await S.sparql(`
SELECT DISTINCT ?m ?dir ?om ?otherLabel ?statedLabel ?url ?genreLabel WHERE {
  VALUES ?m { ${mbids.map(m => `"${esc(m)}"`).join(" ")} }
  ?a wdt:P434 ?m .
  { ?a p:P737 ?st . ?st ps:P737 ?other . BIND("before" AS ?dir) }
  UNION { ?other p:P737 ?st . ?st ps:P737 ?a . BIND("after" AS ?dir) }
  ?st prov:wasDerivedFrom ?ref .
  OPTIONAL { ?ref pr:P248 ?stated . }
  OPTIONAL { ?ref pr:P854 ?url . }
  ?other wdt:P434 ?om .
  OPTIONAL { ?other wdt:P136 ?genre . }
  SERVICE wikibase:label { bd:serviceParam wikibase:language "en". }
} LIMIT 1500`);
  const by = new Map();
  for (const r of rows){
    if (!r.otherLabel || /^Q\d+$/.test(r.otherLabel)) continue;
    const k = r.m + "|" + r.dir + "|" + r.om;
    if (!by.has(k)) by.set(k, { from: r.m, dir: r.dir, mbid: r.om, name: r.otherLabel, genres: new Set(), sources: new Set() });
    const x = by.get(k);
    if (r.genreLabel && !/^Q\d+$/.test(r.genreLabel)) x.genres.add(r.genreLabel);
    const src = r.statedLabel && !/^Q\d+$/.test(r.statedLabel) ? r.statedLabel : host(r.url || "");
    if (src) x.sources.add(src);
  }
  return [...by.values()].map(x => ({ ...x, genres: [...x.genres], sources: [...x.sources] }));
}
// Wikipedia article titles -> musical artists
async function artistsByTitle(titles){
  if (!titles.length) return [];
  const rows = await S.sparql(`
SELECT DISTINCT ?title ?om ?otherLabel ?genreLabel WHERE {
  VALUES ?title { ${titles.slice(0, 60).map(t => `"${esc(t)}"@en`).join(" ")} }
  ?article schema:name ?title ; schema:isPartOf <https://en.wikipedia.org/> ; schema:about ?other .
  ?other wdt:P434 ?om .
  OPTIONAL { ?other wdt:P136 ?genre . }
  SERVICE wikibase:label { bd:serviceParam wikibase:language "en". }
} LIMIT 500`);
  const by = new Map();
  for (const r of rows){
    if (!by.has(r.om)) by.set(r.om, { title: r.title, mbid: r.om, name: r.otherLabel, genres: new Set() });
    if (r.genreLabel && !/^Q\d+$/.test(r.genreLabel)) by.get(r.om).genres.add(r.genreLabel);
  }
  return [...by.values()].map(x => ({ ...x, genres: [...x.genres] }));
}
// every album of these artists, with its first release date and how widely it's written about
async function albumsOf(mbids){
  if (!mbids.length) return new Map();
  const rows = await S.sparql(`
SELECT ?om ?alb ?albLabel ?date ?rg ?links WHERE {
  VALUES ?om { ${mbids.map(m => `"${esc(m)}"`).join(" ")} }
  ?artist wdt:P434 ?om .
  ?alb wdt:P175 ?artist ; wdt:P31 wd:Q482994 ; wikibase:sitelinks ?links .
  OPTIONAL { ?alb wdt:P577 ?date . }
  OPTIONAL { ?alb wdt:P436 ?rg . }
  SERVICE wikibase:label { bd:serviceParam wikibase:language "en". }
} LIMIT 4000`);
  const out = new Map();
  for (const r of rows){
    if (!r.albLabel || /^Q\d+$/.test(r.albLabel) || LIVE.test(r.albLabel)) continue;
    const list = out.get(r.om) || [];
    const y = yearOf(r.date), prev = list.find(a => a.alb === r.alb);
    if (prev){ if (y && (!prev.year || y < prev.year)) prev.year = y; if (!prev.rg && r.rg) prev.rg = r.rg; continue; }
    list.push({ alb: r.alb, name: r.albLabel, year: y, rg: r.rg || null, links: +r.links || 0 });
    out.set(r.om, list);
  }
  return out;
}
// the best-known album from the right side of the centre album's year
function choose(list, dir, year){
  if (!list || !list.length) return null;
  const dated = list.filter(a => a.year);
  const side = year ? dated.filter(a => dir === "before" ? a.year <= year : a.year >= year) : dated;
  const pool = side.length ? side : [];
  return pool.sort((a, b) => b.links - a.links || (a.year || 9999) - (b.year || 9999))[0] || null;
}
const sourceNote = x => x.sources && x.sources.length ? ` (source: ${list(x.sources.slice(0, 2))}, via Wikidata)` : " (cited on Wikidata)";

// lanes only when the influences plainly split into genres: two or more genres with two or more artists each
function laneOf(nodes){
  const count = new Map();
  for (const n of nodes) for (const g of n.genres || []) count.set(g, (count.get(g) || 0) + 1);
  const take = n => (n.genres || []).slice().sort((a, b) => (count.get(b) || 0) - (count.get(a) || 0))[0];
  const groups = new Map();
  for (const n of nodes){ const g = take(n); if (g){ if (!groups.has(g)) groups.set(g, []); groups.get(g).push(n); } }
  const big = [...groups.entries()].filter(([, v]) => v.length >= 2).sort((a, b) => b[1].length - a[1].length).slice(0, 3);
  if (big.length < 2) return [];
  const names = big.map(([g]) => g);
  for (const n of nodes){
    const own = names.find(g => (n.genres || []).includes(g));
    n.lane = own || "Other";
  }
  return nodes.some(n => n.lane === "Other") ? [...names, "Other"] : names;
}

async function find(seed){
  const A = seed.artist, year = seed.year || null;
  const mbid = await cap(S.mbArtist(A), 9000, null);
  if (!mbid){ S.log(`Family tree ${seed.name}: MusicBrainz didn't find ${A}`); return { seed, before: [[], []], after: [[], []], lanes: [], at: Date.now() }; }

  // 1. the artist's own influences, and the critic-cited sentences about influence in the album's and artist's articles
  const seedWiki = window.Wiki ? await cap(Wiki.lookup({ name: seed.name, artists: [{ name: A }] }), 9000, null) : null;
  const [g1, artistArticle] = await Promise.all([cap(influences([mbid]), 15000, []), cap(S.sparql(`
SELECT ?article WHERE { ?a wdt:P434 "${esc(mbid)}" . ?article schema:about ?a ; schema:isPartOf <https://en.wikipedia.org/> . } LIMIT 1`), 9000, [])]);
  const artTitle = decodeURIComponent((artistArticle[0]?.article || "").split("/wiki/")[1] || "").replace(/_/g, " ");
  const texts = await Promise.all([seedWiki?.title, artTitle].map(t => cap(S.criticSentences(t), 9000, [])));
  const critSents = texts.flat().filter(s => s.outlets.length && INFLUENCE.test(s.text) && s.links.length);
  const linked = await cap(artistsByTitle([...new Set(critSents.flatMap(s => s.links))]), 12000, []);

  S.log(`Family tree ${seed.name}: ${g1.length} sourced influences on Wikidata, ${critSents.length} critic sentences, ${linked.length} artists named in them`);
  // 2. first generation either side
  const nodes = new Map(); // dir|mbid -> node
  const add = (dir, gen, x, why, critic) => {
    if (x.mbid === mbid) return null;
    const k = dir + "|" + x.mbid;
    if (nodes.has(k)) return nodes.get(k);
    const n = { dir, gen, mbid: x.mbid, artist: x.name, genres: x.genres || [], why, critic: critic || null, via: x.from };
    nodes.set(k, n); return n;
  };
  const critFor = name => critSents.find(s => S.mentions(s.text, name));
  for (const x of g1){
    const c = critFor(x.name);
    const why = x.dir === "before" ? `An influence on ${A}${sourceNote(x)}.` : `${A} was an influence on ${x.name}${sourceNote(x)}.`;
    add(x.dir, 1, x, c ? why + ` Wikipedia, citing ${c.outlets[0]}: “${trim(c.text, 170)}”` : why, c?.outlets[0]);
  }
  // artists the critics name, placed before or after by when their albums came out
  const pendingCritic = linked.filter(x => x.mbid !== mbid && !nodes.has("before|" + x.mbid) && !nodes.has("after|" + x.mbid));

  // 3. second generation, from the first generation's own documented influences
  const g1Before = [...nodes.values()].filter(n => n.dir === "before").slice(0, 8);
  const g1After = [...nodes.values()].filter(n => n.dir === "after").slice(0, 8);
  const g2 = await cap(influences([...g1Before, ...g1After].map(n => n.mbid)), 20000, []);
  for (const x of g2){
    const parent = nodes.get(x.dir + "|" + x.from);
    if (!parent || parent.gen !== 1 || nodes.has("before|" + x.mbid) || nodes.has("after|" + x.mbid)) continue;
    const why = x.dir === "before" ? `An influence on ${parent.artist}${sourceNote(x)}.` : `${parent.artist} was an influence on ${x.name}${sourceNote(x)}.`;
    const n = add(x.dir, 2, x, why);
    if (n) n.parent = parent.mbid;
  }

  // 4. one album for each artist
  const all = [...nodes.values()];
  const albums = await cap(albumsOf([...new Set([...all.map(n => n.mbid), ...pendingCritic.map(x => x.mbid)])]), 20000, new Map());
  for (const x of pendingCritic){
    const list = albums.get(x.mbid);
    const before = choose(list, "before", year), after = choose(list, "after", year);
    const first = (list || []).filter(a => a.year).sort((a, b) => a.year - b.year)[0];
    if (!first || !year) continue;
    const dir = first.year < year ? "before" : first.year > year + 1 ? "after" : null;
    if (!dir || !(dir === "before" ? before : after)) continue;
    const c = critFor(x.name) || critSents.find(s => s.links.includes(x.title));
    if (!c) continue;
    add(dir, 1, x, `Wikipedia, citing ${c.outlets[0]}: “${trim(c.text, 200)}”`, c.outlets[0]);
  }
  const placed = [];
  for (const n of nodes.values()){
    const al = choose(albums.get(n.mbid), n.dir, n.gen === 2 ? null : year);
    if (!al) continue;
    // further back really is further back, and later is later
    if (year && al.year && (n.dir === "before" ? al.year > year : al.year < year)) continue;
    placed.push({ ...n, name: al.name, year: al.year, rg: al.rg, links: al.links,
      src: al.rg ? `https://coverartarchive.org/release-group/${al.rg}/front-250` : "" });
  }
  S.log(`Family tree ${seed.name}: albums for ${albums.size} artists, ${placed.length} placed`);
  // the best-documented first: critic-backed, then the most written-about albums
  const rank = (a, b) => (b.critic ? 1 : 0) - (a.critic ? 1 : 0) || b.links - a.links;
  const pickGen = (dir, gen, n) => placed.filter(x => x.dir === dir && x.gen === gen).sort(rank).slice(0, n);
  const b1 = pickGen("before", 1, 10), a1 = pickGen("after", 1, 8);
  const keep = new Set([...b1, ...a1].map(x => x.mbid));
  const b2 = placed.filter(x => x.dir === "before" && x.gen === 2 && keep.has(x.parent)).sort(rank).slice(0, 10);
  const a2 = placed.filter(x => x.dir === "after" && x.gen === 2 && keep.has(x.parent)).sort(rank).slice(0, 8);
  // genre branches below the album, if the influences clearly split
  const lanes = laneOf(b1);
  for (const x of b2){ const p = b1.find(y => y.mbid === x.parent); x.lane = p ? p.lane : lanes[0]; }
  const byYear = (desc) => (a, b) => desc ? (b.year || 0) - (a.year || 0) : (a.year || 0) - (b.year || 0);
  const clean = x => ({ name: x.name, artist: x.artist, year: x.year, src: x.src, rg: x.rg, why: x.why, lane: x.lane || null, critic: x.critic });
  return {
    seed,
    before: [b1.sort(byYear(true)).map(clean), b2.sort(byYear(true)).map(clean)],
    after: [a1.sort(byYear(false)).map(clean), a2.sort(byYear(false)).map(clean)],
    lanes, at: Date.now()
  };
}

/* ---------- the page ---------- */
function node(n, i, dir){
  const t = document.createElement("article"); t.className = "lg-node"; t.dataset.k = dir + i;
  const c = document.createElement("div"); c.className = "lg-cover";
  const label = document.createElement("i"); label.textContent = n.name; c.appendChild(label);
  if (n.src){
    label.style.opacity = 0;
    const im = new Image(); im.alt = ""; im.loading = "lazy"; im.draggable = false;
    im.onload = () => im.classList.add("in");
    im.onerror = () => { im.remove(); label.style.opacity = ""; };
    im.src = n.src; c.appendChild(im);
  }
  t.append(c,
    Object.assign(document.createElement("div"), { className: "lg-title", textContent: n.name }),
    Object.assign(document.createElement("div"), { className: "lg-sub", textContent: [n.artist, n.year].filter(Boolean).join(" · ") }),
    Object.assign(document.createElement("p"), { className: "lg-why", textContent: n.why }));
  return t;
}
function band(title, pairs, dir){
  const s = document.createElement("section"); s.className = "lg-band";
  if (title) s.appendChild(Object.assign(document.createElement("h3"), { className: "lg-gen", textContent: title }));
  const row = document.createElement("div"); row.className = "lg-nodes";
  for (const [n, i] of pairs) row.appendChild(node(n, i, dir));
  s.appendChild(row);
  return s;
}
const idx = (list, off) => list.map((n, i) => [n, off + i]);
function render(el, state, { onPick } = {}){
  const frag = document.createDocumentFragment();
  if (!state || !state.seed){
    frag.appendChild(Object.assign(document.createElement("p"), { className: "lg-empty", textContent: "Right-click any album and choose Send To Family Tree." }));
    el.replaceChildren(frag); return;
  }
  const s = state.seed, tree = document.createElement("div"), trunk = document.createElement("div");
  tree.className = "lg-tree"; trunk.className = "lg-trunk"; tree.appendChild(trunk);
  const after = state.after || [[], []], before = state.before || [[], []];
  const branched = !state.loading && state.lanes && state.lanes.length > 1;
  // later music above, newest at the top
  if (after[1].length) trunk.appendChild(band("Later still", idx(after[1], after[0].length).reverse(), "a"));
  if (after[0].length) trunk.appendChild(band("Came after", idx(after[0], 0).reverse(), "a"));

  const hero = document.createElement("section"); hero.className = "lg-seed";
  const art = document.createElement("div"); art.className = "lg-art";
  const img = new Image(); img.alt = ""; img.draggable = false;
  if (s.src) img.src = s.src; else img.style.visibility = "hidden";
  art.appendChild(img);
  const cap = document.createElement("div"); cap.className = "lg-cap";
  cap.append(Object.assign(document.createElement("div"), { className: "lg-name", textContent: s.name }),
    Object.assign(document.createElement("div"), { className: "lg-sub", textContent: [s.artist, s.year].filter(Boolean).join(" · ") }));
  hero.append(art, cap);
  trunk.appendChild(hero);

  const none = !after.flat().length && !before.flat().length;
  if (state.loading || none){
    trunk.appendChild(Object.assign(document.createElement("p"), { className: "lg-note",
      textContent: state.loading ? "Tracing the family tree of " + s.name + "…" : "Couldn't find documented influences for " + s.name + " this time." }));
  } else if (branched){
    // the influences split into genres: one line per genre, feeding into the album
    const lanes = document.createElement("div"); lanes.className = "lg-lanes";
    for (const g of state.lanes){
      const lane = document.createElement("div"); lane.className = "lg-lane";
      lane.appendChild(Object.assign(document.createElement("h3"), { className: "lg-lanehead", textContent: g }));
      before.forEach((list, gi) => {
        const mine = idx(list, gi ? before[0].length : 0).filter(([n]) => n.lane === g);
        if (mine.length) lane.appendChild(band(null, mine, "b"));
      });
      lanes.appendChild(lane);
    }
    tree.appendChild(lanes);
    tree.classList.add("branched");
  } else {
    if (before[0].length) trunk.appendChild(band("Came before", idx(before[0], 0), "b"));
    if (before[1].length) trunk.appendChild(band("Further back", idx(before[1], before[0].length), "b"));
  }
  tree.addEventListener("click", e => {
    const t = e.target.closest(".lg-node");
    if (t && onPick) onPick(itemAt(state, t.dataset.k));
  });
  frag.appendChild(tree);
  el.replaceChildren(frag);
  wires(tree);
}
// curved lines from the album down into each genre's line, drawn once everything is in place
function wires(tree){
  if (!tree) return;
  tree.querySelector(".lg-wires")?.remove();
  const lanes = tree.querySelectorAll(".lg-lanehead");
  if (lanes.length < 2 || !tree.isConnected || !tree.offsetWidth) return;
  const box = tree.getBoundingClientRect(), seed = tree.querySelector(".lg-seed").getBoundingClientRect();
  const ns = "http://www.w3.org/2000/svg", svg = document.createElementNS(ns, "svg");
  svg.setAttribute("class", "lg-wires"); svg.setAttribute("width", box.width); svg.setAttribute("height", box.height);
  const x0 = seed.left + seed.width / 2 - box.left, y0 = seed.bottom - box.top;
  for (const h of lanes){
    const r = h.getBoundingClientRect(), x1 = r.left + r.width / 2 - box.left, y1 = r.top - box.top - 4;
    const p = document.createElementNS(ns, "path"), m = (y0 + y1) / 2;
    p.setAttribute("d", `M${x0},${y0} C${x0},${m} ${x1},${m} ${x1},${y1}`);
    svg.appendChild(p);
  }
  tree.prepend(svg);
}
function itemAt(state, k){
  if (!state || !k) return null;
  const after = (state.after || []).flat(), before = (state.before || []).flat();
  return k[0] === "a" ? after[+k.slice(1)] : before[+k.slice(1)];
}

const Lineage = { find, render, wires, itemAt, _test: { laneOf, choose } };
window.Lineage = Lineage;
})();
