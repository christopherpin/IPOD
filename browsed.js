/* browsed: photos of albums you looked at in a shop. Gemini reads each photo for the album's name,
   artist and year; the photo is shrunk and kept in a bin that empties itself after a few days. */
"use strict";
(() => {
const MODELS = ["gemini-2.5-flash", "gemini-flash-latest", "gemini-2.5-flash-lite", "gemini-flash-lite-latest", "gemini-2.0-flash"];
const API = "https://generativelanguage.googleapis.com/v1beta/models/";
const BIN_DAYS = 7;
const fail = (msg, kind) => Object.assign(new Error(msg), { kind });

const ASK = `This photo was taken in a record shop. It shows one or more album covers (front or back), or a record sleeve.
Work out which album each cover is: its title, the main artist, and the year it was ORIGINALLY released (not a reissue).
Read the text on the cover, and look the album up with Google Search when it is available, to be sure.
Only list albums you can identify with confidence; leave out anything you can't read or aren't sure of.
Reply with only this JSON, no other text:
{"albums": [{"album": "", "artist": "", "year": 0}]}`;

// a smaller JPEG: plenty for Gemini to read the cover, and much less to keep in the bin
async function shrink(file, max = 1280){
  const img = await createImageBitmap(file).catch(() => null);
  if (!img) throw fail("That file isn't a photo the page can open.", "other");
  const s = Math.min(1, max / Math.max(img.width, img.height));
  const c = document.createElement("canvas");
  c.width = Math.round(img.width * s); c.height = Math.round(img.height * s);
  c.getContext("2d").drawImage(img, 0, 0, c.width, c.height);
  return new Promise(r => c.toBlob(r, "image/jpeg", 0.8));
}
const b64 = blob => new Promise(r => { const f = new FileReader(); f.onload = () => r(String(f.result).split(",")[1]); f.readAsDataURL(blob); });

async function identify(blob, key){
  const parts = [{ inline_data: { mime_type: "image/jpeg", data: await b64(blob) } }, { text: ASK }];
  const base = { contents: [{ role: "user", parts }] };
  let said = "";
  for (const search of [true, false]) for (const model of MODELS){
    const body = JSON.stringify(search ? { ...base, tools: [{ google_search: {} }] } : base);
    let r;
    try{ r = await fetch(API + model + ":generateContent", { method: "POST", headers: { "Content-Type": "application/json", "x-goog-api-key": key }, body }); }
    catch{ throw fail("Couldn't reach Gemini. Check the internet connection and try again.", "busy"); }
    const j = await r.json().catch(() => ({}));
    const m = String(j.error?.message || "");
    if (/API_KEY_INVALID|API key not valid/i.test(m) || r.status === 401) throw fail("That Gemini key didn't work. Make a new one and paste it here.", "key");
    if (!r.ok){ said = said || m; continue; } // not offered on the free tier, busy, or no search: try the next
    const text = (j.candidates?.[0]?.content?.parts || []).filter(p => p.text && !p.thought).map(p => p.text).join("");
    const a = text.indexOf("{"), b = text.lastIndexOf("}");
    try{
      const list = JSON.parse(text.slice(a, b + 1)).albums;
      return (Array.isArray(list) ? list : []).filter(x => x && x.album && x.artist)
        .map(x => ({ name: String(x.album).trim(), artist: String(x.artist).trim(), year: +x.year || null }));
    } catch { return []; }
  }
  throw fail("Gemini didn't answer. " + (said ? "Google said: " + said.split(/[.\n]/)[0].slice(0, 140) + "." : "Try again in a minute."), "busy");
}

/* ---------- the bin: shrunk photos and what was read from them, deleted after BIN_DAYS ---------- */
let dbp = null;
const db = () => dbp ||= new Promise((ok, no) => {
  const q = indexedDB.open("ipod-bin", 1);
  q.onupgradeneeded = () => q.result.createObjectStore("photos", { keyPath: "id", autoIncrement: true });
  q.onsuccess = () => ok(q.result); q.onerror = () => no(q.error);
});
const store = async mode => (await db()).transaction("photos", mode).objectStore("photos");
const done = q => new Promise((ok, no) => { q.onsuccess = () => ok(q.result); q.onerror = () => no(q.error); });
async function toBin(photo, found){ try{ await done((await store("readwrite")).add({ at: Date.now(), photo, found })); }catch{} }
async function emptyOld(){
  try{
    const s = await store("readwrite"), all = await done(s.getAll()), cut = Date.now() - BIN_DAYS * 864e5;
    for (const x of all) if (x.at < cut) s.delete(x.id);
    return all.filter(x => x.at >= cut).length;
  } catch { return 0; }
}

window.Browsed = { shrink, identify, toBin, emptyOld, BIN_DAYS };
})();
