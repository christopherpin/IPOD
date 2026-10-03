/* iPod tab: an iPod touch (2008, iPhone OS 3) running the Music app.
   Browses Playlists, Artists and Albums down to a single album. Each album opens its own page,
   built by IPod.albumPage, which is the place to add tracklists and other album details later.

   index.html calls IPod.show(el, opts) whenever the tab opens; opts:
     albums     the shared album list (same objects as the Wall)
     playlists  () => [{ name, albums }]   read each time the Playlists tab is opened
     clean      album name -> name without "(Remastered)" etc. (optional) */
(function(){
"use strict";
const W = 370, H = 660; // device size before scaling to the window
const esc = s => String(s ?? "").replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
// sorted the way the iPod does it: "The" is ignored, accents don't matter, numbers and symbols go last under #
const sortKey = s => String(s || "").normalize("NFKD").replace(/[̀-ͯ]/g, "").replace(/^the\s+/i, "").trim().toLowerCase();
const letterOf = s => { const c = sortKey(s).charAt(0).toUpperCase(); return c >= "A" && c <= "Z" ? c : "#"; };
const byName = (a, b) => (letterOf(a) === "#") - (letterOf(b) === "#") || sortKey(a).localeCompare(sortKey(b));

const ICONS = {
  playlists: '<path d="M3 6h16v2.6H3zM3 12h16v2.6H3zM3 18h10v2.6H3z"/><path d="M22 4l6 1.6v2.6l-3.6-1v13.3a3.6 3 0 1 1-2.4-2.8z"/>',
  artists: '<circle cx="15" cy="9.5" r="5.8"/><path d="M3.5 28c0-6.8 5.2-10.6 11.5-10.6S26.5 21.2 26.5 28z"/>',
  albums: '<path d="M2 5h20v20H2z" opacity=".55"/><path d="M8 3h20v20H8zM18 7.5a5.5 5.5 0 1 0 0 11a5.5 5.5 0 1 0 0-11zm0 4a1.5 1.5 0 1 1 0 3a1.5 1.5 0 1 1 0-3z" fill-rule="evenodd"/>'
};
const TABS = [["playlists", "Playlists"], ["artists", "Artists"], ["albums", "Albums"]];

let root, opts, albums = [], built = null;
let tab = (() => { try{ return JSON.parse(localStorage.getItem("wall.ipod.tab")); }catch{ return null; } })();
if (!TABS.some(t => t[0] === tab)) tab = "albums";
const stacks = {}; // per tab: [{ title, el }]

const nameOf = a => (opts.clean ? opts.clean(a.name || "") : a.name) || (a.title || "").split(" · ")[0];
const yearOf = a => a.year || a.released || null;

function shell(){
  root.innerHTML = `
  <svg width="0" height="0" style="position:absolute"><defs>
    <linearGradient id="ipBlue" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#7fd8ff"/><stop offset=".5" stop-color="#29a6f7"/><stop offset=".5" stop-color="#1688e6"/><stop offset="1" stop-color="#0d6ed1"/></linearGradient>
    <linearGradient id="ipGrey" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#a8a8a8"/><stop offset="1" stop-color="#6b6b6b"/></linearGradient>
  </defs></svg>
  <div class="ip-fit"><div class="ip-device"><div class="ip-glass">
    <div class="ip-screen">
      <div class="ip-status">
        <span class="l">iPod <svg width="15" height="11" viewBox="0 0 15 11"><path d="M7.5 11 5.3 8.3a3.4 3.4 0 0 1 4.4 0zM3.8 6.5 2.3 4.7a8 8 0 0 1 10.4 0l-1.5 1.8a5.7 5.7 0 0 0-7.4 0zM.8 2.9 0 1.9 .1 1.8A11.6 11.6 0 0 1 15 1.9l-.8 1a10.3 10.3 0 0 0-13.4 0z"/></svg></span>
        <span class="t"></span>
        <span class="r"><svg width="25" height="11" viewBox="0 0 25 11"><path d="M2 0h19a2 2 0 0 1 2 2v7a2 2 0 0 1-2 2H2a2 2 0 0 1-2-2V2a2 2 0 0 1 2-2zm0 1.2a.8.8 0 0 0-.8.8v7c0 .4.4.8.8.8h19c.4 0 .8-.4.8-.8V2a.8.8 0 0 0-.8-.8z"/><path d="M2.5 2.5h18v6h-18zM23.6 3.5h.6a.8.8 0 0 1 .8.8v2.4a.8.8 0 0 1-.8.8h-.6z"/></svg></span>
      </div>
      <div class="ip-nav"><div class="ip-back gone"><span></span></div><div class="ip-title"></div></div>
      <div class="ip-pages"></div>
      <div class="ip-tabs">${TABS.map(([k, label]) => `<div class="ip-tab" data-tab="${k}"><svg viewBox="0 0 30 30">${ICONS[k]}</svg>${label}</div>`).join("")}</div>
    </div>
  </div><div class="ip-home" title="Home"></div></div></div>`;
  root.querySelector(".ip-back").onclick = pop;
  root.querySelector(".ip-home").onclick = home;
  root.querySelector(".ip-tabs").onclick = e => { const t = e.target.closest(".ip-tab"); if (t) setTab(t.dataset.tab); };
  dragScroll(root.querySelector(".ip-pages"));
  clock();
}

/* ---------- fitting the device to the window ---------- */
function fit(){
  if (!root || root.classList.contains("hidden")) return;
  const s = Math.min(1.25, (innerWidth - 24) / W, (innerHeight - 76) / H);
  const box = root.querySelector(".ip-fit");
  box.style.width = W * s + "px"; box.style.height = H * s + "px";
  root.querySelector(".ip-device").style.transform = `scale(${s})`;
  scale = s;
}
let scale = 1;
addEventListener("resize", fit);

function clock(){
  const t = root.querySelector(".ip-status .t");
  if (!t) return;
  t.textContent = new Date().toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  setTimeout(clock, 60000 - Date.now() % 60000 + 50);
}

/* ---------- pages ---------- */
const pagesEl = () => root.querySelector(".ip-pages");
function page(html){
  const el = document.createElement("div");
  el.className = "ip-page";
  el.innerHTML = html;
  return el;
}
function bar(){
  const st = stacks[tab], top = st[st.length - 1], prev = st[st.length - 2];
  root.querySelector(".ip-title").textContent = top.title;
  const back = root.querySelector(".ip-back");
  back.classList.toggle("gone", !prev);
  if (prev) back.firstChild.textContent = prev.title;
  for (const t of root.querySelectorAll(".ip-tab")) t.classList.toggle("on", t.dataset.tab === tab);
}
// cross-fade the title as a page slides in
function fadeBar(){
  const title = root.querySelector(".ip-title"), back = root.querySelector(".ip-back");
  title.classList.add("fade"); back.style.opacity = 0;
  setTimeout(() => { bar(); title.classList.remove("fade"); back.style.opacity = ""; }, 170);
}
function push(title, el){
  const st = stacks[tab], from = st[st.length - 1].el;
  st.push({ title, el });
  el.classList.add("right", "still");
  pagesEl().appendChild(el);
  el.offsetWidth; // start from the right-hand edge
  el.classList.remove("right", "still");
  from.classList.add("left");
  fadeBar();
}
function pop(){
  const st = stacks[tab];
  if (st.length < 2) return;
  const gone = st.pop().el, now = st[st.length - 1].el;
  gone.classList.add("right");
  now.classList.remove("left");
  setTimeout(() => gone.remove(), 400);
  fadeBar();
}
function home(){
  const st = stacks[tab];
  if (st.length < 2){ st[0].el.scrollTo({ top: 0, behavior: "smooth" }); return; }
  for (const p of st.splice(1)) p.el.remove();
  st[0].el.classList.remove("left");
  bar();
}
function setTab(t){
  tab = t;
  try{ localStorage.setItem("wall.ipod.tab", JSON.stringify(t)); }catch{}
  if (!stacks[t]) stacks[t] = [rootPage(t)];
  // only this tab's pages are shown; the others keep their place for when you come back
  for (const [k, st] of Object.entries(stacks)) for (const p of st) p.el.classList.toggle("hidden", k !== t);
  for (const p of stacks[t]) if (!p.el.parentNode) pagesEl().appendChild(p.el);
  bar();
}

/* ---------- lists ---------- */
function albumRows(list){
  return list.map(a => `<div class="ip-row al" data-album="${esc(a.id)}" data-id="${esc(a.id)}"><img src="${esc(a.src)}" data-id="${esc(a.id)}" loading="lazy" alt="" draggable="false"><div><b>${esc(nameOf(a))}</b><i>${esc(a.artist)}</i></div></div>`).join("");
}
// a long alphabetical list with section headers and the A-Z strip down the right-hand side
function sectioned(items, label, row){
  const groups = new Map();
  for (const it of items){ const l = letterOf(label(it)); if (!groups.has(l)) groups.set(l, []); groups.get(l).push(it); }
  const html = [...groups].map(([l, list]) => `<div class="ip-sec" data-letter="${l}">${l}</div>${list.map(row).join("")}`).join("");
  const el = page(html || `<div class="ip-empty">No Albums</div>`);
  if (groups.size > 1){
    const idx = document.createElement("div");
    idx.className = "ip-index";
    idx.innerHTML = [..."ABCDEFGHIJKLMNOPQRSTUVWXYZ#"].map(l => `<span>${l}</span>`).join("");
    indexBar(idx, el);
    // the strip stays put while the list scrolls, so it sits beside the page rather than in it
    el._index = idx;
  }
  return el;
}
function indexBar(idx, el){
  const jump = y => {
    const r = idx.getBoundingClientRect();
    const letters = "ABCDEFGHIJKLMNOPQRSTUVWXYZ#";
    const want = letters[Math.max(0, Math.min(letters.length - 1, Math.floor((y - r.top) / r.height * letters.length)))];
    // the nearest section at or after the letter asked for
    const secs = [...el.querySelectorAll(".ip-sec")];
    const hit = secs.find(s => letters.indexOf(s.dataset.letter) >= letters.indexOf(want)) || secs[secs.length - 1];
    if (hit) el.scrollTop = hit.offsetTop;
  };
  idx.addEventListener("pointerdown", e => {
    e.preventDefault(); e.stopPropagation();
    idx.setPointerCapture(e.pointerId); idx.classList.add("down"); jump(e.clientY);
    const move = ev => jump(ev.clientY);
    const up = () => { idx.classList.remove("down"); idx.removeEventListener("pointermove", move); idx.removeEventListener("pointerup", up); idx.removeEventListener("pointercancel", up); };
    idx.addEventListener("pointermove", move); idx.addEventListener("pointerup", up); idx.addEventListener("pointercancel", up);
  });
}
function rootPage(t){
  let el, title;
  if (t === "albums"){
    title = "Albums";
    el = sectioned([...albums].sort((a, b) => byName(nameOf(a), nameOf(b))), nameOf, a => albumRows([a]));
  } else if (t === "artists"){
    title = "Artists";
    const names = [...new Set(albums.map(a => a.artist).filter(Boolean))].sort(byName);
    el = sectioned(names, n => n, n => `<div class="ip-row" data-artist="${esc(n)}"><b>${esc(n)}</b></div>`);
  } else {
    title = "Playlists";
    el = page("");
    fillPlaylists(el);
  }
  wire(el);
  return { title, el: withIndex(el) };
}
// pages with an A-Z strip are wrapped so the strip can sit on top without scrolling away
function withIndex(el){
  if (!el._index) return el;
  const box = document.createElement("div");
  box.className = "ip-page";
  box.style.overflow = "hidden";
  el.classList.remove("ip-page");
  el.style.cssText = "position:absolute;inset:0;overflow-y:auto;overflow-x:hidden;scrollbar-width:none";
  el.classList.add("ip-scroll");
  box.append(el, el._index);
  box.scrollTo = (...a) => el.scrollTo(...a);
  return box;
}
function fillPlaylists(el){
  const lists = opts.playlists ? opts.playlists() : [];
  el._lists = lists;
  el.innerHTML = lists.map((p, i) => `<div class="ip-row go" data-list="${i}"><b>${esc(p.name)}</b></div>`).join("") || `<div class="ip-empty">No Playlists</div>`;
}
function albumList(title, list){
  const el = page(list.length ? albumRows(list) : `<div class="ip-empty">No Albums</div>`);
  el._albums = list; // playlists can hold albums that aren't in your library
  wire(el);
  push(title, el);
}
const byId = id => albums.find(a => a.id === id);
// the album itself: the end of the line for now
const IPod = window.IPod = {
  albumPage(a){
    const y = yearOf(a);
    return page(`<div class="ip-album"><img src="${esc(a.src)}" data-id="${esc(a.id)}" alt="" draggable="false"><div>
      <span class="ar">${esc(a.artist)}</span><span class="nm">${esc(nameOf(a))}</span>${y ? `<span class="yr">Released ${y}</span>` : ""}</div></div>
      <div class="ip-lines"></div>`);
  },
  show(el, o){
    root = el; opts = o || {};
    if (!root.firstChild) shell();
    root.classList.remove("hidden");
    fit();
    // the lists are built once from the finished album list, so nothing moves while you look
    if (built !== opts.albums){
      built = opts.albums; albums = (opts.albums || []).filter(a => a && a.id);
      for (const k of Object.keys(stacks)) delete stacks[k];
      pagesEl().replaceChildren();
    }
    if (stacks.playlists && stacks.playlists.length === 1) fillPlaylists(stacks.playlists[0].el);
    setTab(tab);
  }
};
function openAlbum(a){ push(nameOf(a), IPod.albumPage(a)); }
function wire(el){
  el.addEventListener("click", e => {
    if (dragged) return;
    const row = e.target.closest(".ip-row");
    if (!row) return;
    row.classList.add("press");
    setTimeout(() => row.classList.remove("press"), 450);
    if (row.dataset.album){ const id = row.dataset.album, a = (el._albums || []).find(x => x.id === id) || byId(id); if (a) openAlbum(a); }
    else if (row.dataset.artist){
      const n = row.dataset.artist;
      const list = albums.filter(a => a.artist === n).sort((a, b) => (yearOf(a) || 9999) - (yearOf(b) || 9999) || byName(nameOf(a), nameOf(b)));
      // like the real iPod, an artist with one album goes straight to it
      if (list.length === 1) openAlbum(list[0]); else albumList(n, list);
    }
    else if (row.dataset.list){ const p = el._lists[+row.dataset.list]; if (p) albumList(p.name, p.albums); }
  });
}

/* ---------- touch-style scrolling with the mouse ---------- */
let dragged = false;
function dragScroll(area){
  area.addEventListener("pointerdown", e => {
    if (e.pointerType !== "mouse" || e.button !== 0 || e.target.closest(".ip-index")) return;
    const pg = e.target.closest(".ip-scroll") || e.target.closest(".ip-page");
    if (!pg) return;
    let lastY = e.clientY, lastT = performance.now(), v = 0, moved = 0;
    dragged = false;
    const move = ev => {
      const dy = (ev.clientY - lastY) / scale, now = performance.now();
      moved += Math.abs(dy);
      if (moved > 5) dragged = true;
      pg.scrollTop -= dy;
      v = -dy / Math.max(1, now - lastT) * 0.8 + v * 0.2;
      lastY = ev.clientY; lastT = now;
    };
    const up = () => {
      removeEventListener("pointermove", move); removeEventListener("pointerup", up);
      if (performance.now() - lastT > 80) v = 0;
      let t = performance.now();
      (function glide(now){
        if (Math.abs(v) < 0.02) return;
        pg.scrollTop += v * (now - t); v *= Math.pow(0.995, now - t); t = now;
        requestAnimationFrame(glide);
      })(t);
      setTimeout(() => { dragged = false; }, 0);
    };
    addEventListener("pointermove", move); addEventListener("pointerup", up);
  });
}
})();
