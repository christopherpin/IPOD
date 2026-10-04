/* lineage: Gemini is asked three questions about one album (what it influenced, what influenced it,
   what came out alongside it), does the research on the web, and reports back. The page only lays out the answer. */
"use strict";
(() => {
// Gemini's free tier differs by model, and searching Google counts separately, so each is tried in turn
// (with search first, then without) until one answers; the one that worked is tried first next time
const MODELS = ["gemini-2.5-flash", "gemini-flash-latest", "gemini-2.5-flash-lite", "gemini-flash-lite-latest", "gemini-2.0-flash"];
const API = "https://generativelanguage.googleapis.com/v1beta/models/";
const log = (...a) => window.dbg && window.dbg("lineage: " + a.join(" "));
const fail = (msg, kind) => Object.assign(new Error(msg), { kind });

const SYSTEM = `You are a music historian helping someone explore where an album sits in music history.
Research with Google Search before answering when it is available. Rely on reputable sources: critics and publications (Pitchfork, Rolling Stone, AllMusic, The Guardian, NME, The Wire, Village Voice Pazz & Jop, Spin, Mojo, Uncut, The Quietus), interviews with the artists, and Wikipedia statements that cite such sources.
Only name real albums (LPs, EPs or compilations, never singles) that you are confident exist, with their original release year. Never invent a connection: every album must be backed by something you found or by well-established critical consensus.`;

const ASK = s => `The album is "${s.name}" by ${s.artist}${s.year ? ` (${s.year})` : ""}.

Answer three questions:
1. later: which albums were influenced by this album? (released after it)
2. earlier: which albums influenced this album? (released before it)
3. same: which albums came out around the same time (within about two years) and are similar to it?

If the album is too niche for album-level evidence, answer the three questions about ${s.artist}, the artist, instead, and set "scope" to "artist".
Give up to 8 albums per question, the strongest connection first. Leave a list short or empty rather than guess.
For each album, "why" is one short sentence (under 20 words) saying how it connects, naming the critic, publication or interview behind it when there is one. Vary the wording from album to album.

Reply with only this JSON, no other text:
{"scope": "album" or "artist", "note": "one short sentence about how the answer was found, or empty",
 "later": [{"album": "", "artist": "", "year": 0, "why": "", "source": "publication or person"}],
 "earlier": [same shape],
 "same": [same shape]}`;

// the JSON in Gemini's answer, cleaned up into the three lists the page shows
function parse(text, seed){
  const a = text.indexOf("{"), b = text.lastIndexOf("}");
  if (a < 0 || b < a) throw new Error("no answer");
  const j = JSON.parse(text.slice(a, b + 1));
  const me = (seed.name + "|" + seed.artist).toLowerCase();
  const list = v => (Array.isArray(v) ? v : []).filter(x => x && x.album && x.artist && (x.album + "|" + x.artist).toLowerCase() !== me).slice(0, 8)
    .map(x => ({ name: String(x.album).trim(), artist: String(x.artist).trim(), year: +x.year || null,
      why: String(x.why || "").trim(), source: String(x.source || "").trim() }));
  return { scope: j.scope === "artist" ? "artist" : "album", note: String(j.note || "").trim(),
    later: list(j.later), earlier: list(j.earlier), same: list(j.same) };
}

async function ask(seed, key){
  const base = { systemInstruction: { parts: [{ text: SYSTEM }] }, contents: [{ role: "user", parts: [{ text: ASK(seed) }] }] };
  const tries = [];
  for (const search of [true, false]) for (const model of MODELS) tries.push({ model, search });
  let last = null; try{ last = JSON.parse(localStorage.getItem("lineage.gemini")); }catch{}
  const i = last ? tries.findIndex(t => t.model === last.model && t.search === last.search) : -1;
  if (i > 0) tries.unshift(...tries.splice(i, 1));
  let j = null, said = "", ok = null;
  for (const t of tries){
    const body = JSON.stringify(t.search ? { ...base, tools: [{ google_search: {} }] } : base);
    let r;
    try{ r = await fetch(API + t.model + ":generateContent", { method: "POST", headers: { "Content-Type": "application/json", "x-goog-api-key": key }, body }); }
    catch(e){ log("network", e.message); throw fail("Couldn't reach Gemini. Check the internet connection and try again.", "busy"); }
    j = await r.json().catch(() => ({}));
    const m = String(j.error?.message || "");
    log(t.model, t.search ? "search" : "no search", r.status, m.slice(0, 300));
    if (/API_KEY_INVALID|API key not valid/i.test(m) || r.status === 401) throw fail("That Gemini key didn't work. Make a new one and paste it here.", "key");
    if (r.ok){ ok = t; break; }
    said = said || m;
    // not offered, no free allowance, busy or not allowed with search: move on to the next one
  }
  if (!ok){
    const short = said.split(/[.\n]/)[0].slice(0, 140);
    throw fail("Gemini didn't answer with any of its free models. " + (short ? "Google said: " + short + "." : "Try again in a minute."), "busy");
  }
  try{ localStorage.setItem("lineage.gemini", JSON.stringify(ok)); }catch{}
  const c = j?.candidates?.[0];
  const text = (c?.content?.parts || []).filter(p => p.text && !p.thought).map(p => p.text).join("");
  if (!text) throw fail("Gemini couldn't answer about this album.", "other");
  try{ return parse(text, seed); }
  catch(e){ log("unreadable answer", text.slice(0, 300)); throw fail("Gemini's answer came back garbled. Try again.", "other"); }
}

/* ---------- drawing ---------- */
const make = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };
function cover(r, i, list){
  const c = make("div", "lg-cover"), label = make("i", null, r.name);
  c.appendChild(label);
  if (r.src){
    label.style.opacity = 0;
    const im = new Image(); im.alt = ""; im.draggable = false;
    im.onload = () => im.classList.add("in");
    im.onerror = () => { im.remove(); label.style.opacity = ""; };
    im.src = r.src; c.appendChild(im);
  }
  return c;
}
function card(r, list, i, onPick){
  const t = make("article", "lg-card"); t.dataset.list = list; t.dataset.i = i;
  const txt = make("div", "lg-txt");
  txt.append(make("div", "lg-title", r.name), make("div", "lg-sub", [r.artist, r.year].filter(Boolean).join(" · ")));
  if (r.why) txt.appendChild(make("p", "lg-why", r.why));
  t.append(cover(r), txt);
  t.onclick = () => onPick && onPick(r);
  return t;
}
const sortYear = (l, dir) => l.map((r, i) => [r, i]).sort((a, b) => dir * ((b[0].year || 0) - (a[0].year || 0)) || a[1] - b[1]);

// newest at the top: what it influenced above, the album with its contemporaries either side in the middle, its influences below
function render(el, state, { onPick, onAgain, onLinks } = {}){
  const s = state.seed, links = state.links || [], linked = !!state.showLinks;
  // the albums you linked on Discover stand in for Gemini's answer while they're shown
  const ans = linked ? null : state.answer, about = ans && ans.scope === "artist" ? s.artist : s.name;
  const frag = document.createDocumentFragment();

  const up = make("section", "lg-up");
  if (ans){
    if (ans.later.length){
      for (const [r, i] of sortYear(ans.later, 1)) up.appendChild(card(r, "later", i, onPick));
      up.appendChild(make("div", "lg-head", ans.scope === "artist" ? "↑ Influenced by " + s.artist + ", the artist" : "↑ Influenced by this album"));
    } else up.appendChild(make("div", "lg-head", "Gemini found nothing clearly influenced by " + about));
  }
  frag.appendChild(up);

  const mid = make("section", "lg-mid"), row = make("div", "lg-row");
  const same = linked ? links.map(r => ({ ...r, why: r.why || "Linked on Discover" })).map((r, i) => [r, i]) : ans ? ans.same.map((r, i) => [r, i]) : [];
  const left = same.filter((_, k) => k % 2 === 1).reverse(), right = same.filter((_, k) => k % 2 === 0);
  const side = ([r, i]) => { const t = card(r, linked ? "links" : "same", i, onPick); t.classList.add("lg-side"); return t; };
  left.forEach(x => row.appendChild(side(x)));
  const hero = make("div", "lg-hero");
  const art = make("div", "lg-art"), img = new Image(); img.alt = ""; img.draggable = false;
  if (s.src) img.src = s.src; else img.style.visibility = "hidden";
  const big = (s.src || "").includes("ab67616d00001e02") ? s.src.replace("ab67616d00001e02", "ab67616d0000b273") : null;
  if (big){ const hi = new Image(); hi.onload = () => { img.src = big; }; hi.src = big; }
  art.appendChild(img);
  hero.append(art, make("div", "lg-name", s.name), make("div", "lg-sub", [s.artist, s.year].filter(Boolean).join(" · ")));
  if (linked) hero.appendChild(make("p", "lg-note", links.length ? "Albums you linked to this one on Discover" : "Nothing is linked to this album yet. Give an album 👍 on Discover to link it."));
  else if (state.loading) hero.appendChild(make("p", "lg-note", "Asking Gemini about " + s.name + "… this can take a minute."));
  else if (state.error) hero.appendChild(make("p", "lg-note", state.error));
  else if (ans){
    const n = ans.scope === "artist" ? "There isn't much written about this album, so Gemini answered about " + s.artist + ", the artist." : "";
    if (n) hero.appendChild(make("p", "lg-note", n));
    if (same.length) hero.appendChild(make("div", "lg-head lg-same", "← Around the same time →"));
  }
  if (onAgain && !linked && !state.loading && (ans || state.error)){
    const b = make("button", "dz-more", ans ? "↻ Ask Gemini again" : "↻ Try again"); b.type = "button";
    b.onclick = () => onAgain();
    hero.appendChild(b);
  }
  if (onLinks && (links.length || linked)){
    const b = make("button", "dz-more", linked ? "Show Family Tree" : "Linked Albums (" + links.length + ")"); b.type = "button";
    b.onclick = () => onLinks();
    hero.appendChild(b);
  }
  row.appendChild(hero);
  right.forEach(x => row.appendChild(side(x)));
  mid.appendChild(row); frag.appendChild(mid);

  const down = make("section", "lg-down");
  if (ans){
    if (ans.earlier.length){
      down.appendChild(make("div", "lg-head", ans.scope === "artist" ? "↓ Influences on " + s.artist + ", the artist" : "↓ Influences on this album"));
      for (const [r, i] of sortYear(ans.earlier, 1)) down.appendChild(card(r, "earlier", i, onPick));
    } else down.appendChild(make("div", "lg-head", "Gemini found no clear influences on " + about));
  }
  frag.appendChild(down);

  el.replaceChildren(frag);
  // the album starts in the middle of the screen, its row scrolled so it sits in the centre too
  row.scrollLeft = hero.offsetLeft + hero.offsetWidth / 2 - row.clientWidth / 2;
  const a = art.getBoundingClientRect(), box = el.getBoundingClientRect();
  el.scrollTop += a.top + a.height / 2 - (box.top + el.clientHeight / 2);
}

window.Lineage = { ask, render, _test: { parse, ASK } };
})();
