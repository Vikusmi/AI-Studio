// The canvas editor. The server owns the document; every change goes through /api/op.
import { initAssets, componentBanner, styleSelect, textStyleSelect, wireInspector } from "./features/assets.js";
import { initGuides } from "./features/guides.js";
import { initExport } from "./features/export.js";
import { initHistory } from "./features/history.js";
import { initTips } from "./features/tips.js";
import { initAsk } from "./features/ask.js";
import { initPen } from "./features/pen.js";
import { spacingSnap } from "./features/spacing.js";
const $ = (s, r = document) => r.querySelector(s);
const world = $("#world"), overlay = $("#overlay"), viewport = $("#viewport"), layersList = $("#layers-list"), inspector = $("#inspector"), pop = $("#pop");

let state = { artboards: [] };
let canUndo = false, canRedo = false;
let selection = [];
let view = { x: 80, y: 90, z: 0.6 };
let editing = null;       // { id, el, original }
let drag = null;
let guides = null, pen = null;   // features that live in their own files (set up once the editor is ready)
let hoverId = null;
let spaceDown = false;
let altDown = false;
let tool = "select";      // select | rect | ellipse | text | frame
let snapOn = true;        // pink guides pull the layer in; ⌘ held turns it off for one drag
try { if (localStorage.getItem("studio-snap") === "off") snapOn = false; } catch {}
const entered = new Set(); // groups the user double-clicked into: their layers can be selected directly
const collapsed = new Set();

try { const v = JSON.parse(localStorage.getItem("studio-view")); if (v) view = v; } catch {}

// ---------- server ----------
const report = (msg) => { try { navigator.sendBeacon?.("/api/log", String(msg)) || fetch("/api/log", { method: "POST", body: String(msg) }); } catch {} };
addEventListener("error", (e) => report(`${e.message} at ${e.filename}:${e.lineno}:${e.colno}`));
addEventListener("unhandledrejection", (e) => report("unhandled: " + (e.reason && (e.reason.stack || e.reason.message) || e.reason)));
async function op(name, args = {}) {
  const r = await fetch("/api/op", { method: "POST", body: JSON.stringify({ op: name, args }) });
  const j = await r.json();
  if (!r.ok) { toast(j.error || "Something went wrong"); throw new Error(j.error); }
  return j.result;
}
function toast(msg) {
  const t = document.createElement("div");
  t.textContent = msg;
  t.style.cssText = "position:fixed;bottom:18px;left:50%;transform:translateX(-50%);background:#161616;color:#fff;padding:9px 14px;border-radius:8px;z-index:99;font-size:13px";
  document.body.appendChild(t);
  setTimeout(() => t.remove(), 3200);
}
const es = new EventSource("/api/events");
let project = null;
es.addEventListener("doc", (e) => {
  const d = JSON.parse(e.data);
  const switched = project && d.project && d.project.id !== project.id;
  if (switched) { try { localStorage.setItem("studio-view:" + project.id, JSON.stringify(view)); } catch {} selection = []; endCrop?.(); }
  state = d.state; canUndo = d.canUndo; canRedo = d.canRedo;
  if (d.project) { project = d.project; $("#proj-name").textContent = project.name; document.title = project.name + " — Studio"; }
  selection = selection.filter((id) => find(id));
  refresh();
  if (switched) {
    // each project remembers its own view; a new one starts fitted
    let v = null; try { v = JSON.parse(localStorage.getItem("studio-view:" + project.id)); } catch {}
    if (v) { view = v; applyView(); setTimeout(ensureVisible, 60); } else setTimeout(() => fit(), 60);
    if (!$("#home").hidden) renderHome();
  }
});

// ---------- tree helpers ----------
function find(id, list = state.artboards, parent = null) {
  for (let i = 0; i < list.length; i++) {
    const n = list[i];
    if (n.id === id) return { node: n, parent, list, index: i };
    if (n.children) { const r = find(id, n.children, n); if (r) return r; }
  }
  return null;
}
const nodeOf = (id) => find(id)?.node;
function artboardOf(id) {
  for (const ab of state.artboards) if (ab.id === id || find(id, ab.children || [])) return ab;
  return null;
}
function label(n) {
  if (n.name) return n.name;
  if (n.tag === "#text") return n.text.slice(0, 40);
  const k = n.children || [];
  if (k.length === 1 && k[0].tag === "#text") return k[0].text.slice(0, 40);
  return { img: "Image", svg: "SVG", div: "Frame", span: "Text", p: "Text", a: "Link" }[n.tag] || n.tag;
}
const INLINE = new Set(["span", "b", "i", "strong", "em", "a", "u", "small", "sup", "sub", "br"]);
const inlineTree = (n) => n.tag === "#text" || (INLINE.has(n.tag) && (n.children || []).every(inlineTree));
// text, possibly with inline formatting; a flex container of spans is a layout, not text
const isTextLeaf = (n) => n.tag !== "svg" && n.tag !== "img" && n.tag !== "#text" && (n.children || []).length > 0 && n.children.every(inlineTree) && !(/flex/.test((n.style || {}).display || "") && n.children.some((c) => c.tag !== "#text"));
const isContainer = (n) => n.tag !== "img" && n.tag !== "svg" && n.tag !== "#text" && !isTextLeaf(n);
const elFor = (id) => world.querySelector(`[data-id="${id}"]`);

// ---------- rendering the document ----------
function fixUrl(u) { return u.startsWith("assets/") ? "/" + u : u; }
function renderNode(n) {
  if (n.tag === "#text") return document.createTextNode(n.text);
  let el;
  if (n.tag === "svg") {
    const t = document.createElement("template");
    t.innerHTML = n.raw.trim();
    el = t.content.firstElementChild;
    el.removeAttribute("style");
    el.querySelectorAll("script").forEach((s) => s.remove());
  } else el = document.createElement(n.tag);
  el.dataset.id = n.id;
  if (n.group || n.crop) el.dataset.group = "1";
  for (const [k, v] of Object.entries(n.attrs || {})) {
    if (/^on/i.test(k)) continue;
    try { el.setAttribute(k, k === "src" ? fixUrl(v) : v); } catch {}
  }
  for (const [k, v] of Object.entries(n.style || {})) el.style.setProperty(k, String(v).replace(/url\((['"]?)assets\//g, "url($1/assets/"));
  if (n.hidden) el.style.setProperty("display", "none", "important");
  // links and images are natively draggable in the browser; that would steal the pointer from our own drag
  el.draggable = false;
  for (const c of n.children || []) el.appendChild(renderNode(c));
  return el;
}
function renderWorld() {
  world.textContent = "";
  for (const ab of state.artboards) {
    const w = document.createElement("div");
    w.className = "abw";
    w.dataset.abw = ab.id;
    w.style.left = ab.x + "px";
    w.style.top = ab.y + "px";
    w.appendChild(renderNode(ab));
    world.appendChild(w);
  }
  $("#empty").hidden = state.artboards.length > 0;
}
// single-weight display fonts need a bare family name; variable ones get their weight range (and italics where they have them)
const SINGLE = new Set(["Anton", "Bebas Neue", "Bowlby One", "Caprasimo", "Lobster", "Pacifico", "Titan One", "Chewy", "Dela Gothic One", "Rubik Mono One", "Shrikhand", "Paytone One", "Bagel Fat One", "Gloock", "Instrument Serif", "DM Serif Display", "Abril Fatface", "Righteous", "Permanent Marker"]);
const SPECS = { Newsreader: ":ital,wght@0,300..600;1,300..600", "DM Mono": ":wght@300;400;500", "Hanken Grotesk": ":ital,wght@0,300..800;1,300..800", Fraunces: ":ital,wght@0,300..900;1,300..900", Caveat: ":wght@400..700", "Inter Tight": ":ital,wght@0,300..800;1,300..800", Nunito: ":ital,wght@0,300..900;1,300..900" };
const fontSpec = (f) => (SINGLE.has(f) ? (f === "Instrument Serif" || f === "DM Serif Display" ? ":ital@0;1" : "") : SPECS[f] || ":wght@300;400;500;600;700;800");
const loadedFonts = new Set();
function loadFonts() {
  // custom (uploaded) fonts are @font-face rules; everything else comes from Google Fonts through the local cache, or Google directly if that fails
  let cs = document.getElementById("customfonts");
  if (!cs) { cs = document.createElement("style"); cs.id = "customfonts"; document.head.appendChild(cs); }
  const faces = (state.fonts || []).map((f) => `@font-face{font-family:"${f.family}";src:url("/${f.file}");font-weight:${f.weight};font-style:${f.style};font-display:swap}`).join("");
  if (cs.textContent !== faces) cs.textContent = faces;
  const custom = new Set((state.fonts || []).map((f) => f.family.toLowerCase()));
  const fams = new Set();
  const walk = (n) => {
    const f = n.style && n.style["font-family"];
    if (f) { const first = f.split(",")[0].trim().replace(/^['"]|['"]$/g, ""); if (first && !custom.has(first.toLowerCase()) && !/^(sans-serif|serif|monospace|cursive|system-ui|inherit)$/i.test(first)) fams.add(first); }
    (n.children || []).forEach(walk);
  };
  state.artboards.forEach(walk);
  const key = [...fams].sort().join("|");
  if (key === [...loadedFonts].sort().join("|")) return;
  loadedFonts.clear(); fams.forEach((f) => loadedFonts.add(f));
  if (!fams.size) return;
  const q = [...fams].map((f) => "family=" + encodeURIComponent(f).replace(/%20/g, "+") + fontSpec(f)).join("&") + "&display=swap";
  const link = $("#gfonts");
  link.onerror = () => { link.onerror = null; link.href = "https://fonts.googleapis.com/css2?" + q; };
  link.href = "/fonts/css2?" + q;
}

let pendingRefresh = false;
function refresh() {
  if (editing) return;
  // never rebuild the DOM under a live drag; catch up when it ends
  if (drag && drag.moved && (drag.kind === "move" || drag.kind === "resize")) { pendingRefresh = true; return; }
  renderWorld();
  loadFonts();
  applyView();
  renderLayers();
  renderInspector();
  $("#btn-undo").disabled = !canUndo;
  $("#btn-redo").disabled = !canRedo;
  window.dispatchEvent(new Event("studio-refresh"));
}

// ---------- view (pan / zoom) ----------
function applyView() {
  world.style.transform = `translate(${view.x}px,${view.y}px) scale(${view.z})`;
  $("#zoom-label").textContent = Math.round(view.z * 100) + "%";
  try { localStorage.setItem("studio-view", JSON.stringify(view)); if (project) localStorage.setItem("studio-view:" + project.id, JSON.stringify(view)); } catch {}
  drawOverlay();
}
function zoomAt(cx, cy, nz) {
  nz = Math.min(4, Math.max(0.08, nz));
  view.x = cx - ((cx - view.x) * nz) / view.z;
  view.y = cy - ((cy - view.y) * nz) / view.z;
  view.z = nz;
  applyView();
}
function fit(ids) {
  const abs = state.artboards.filter((a) => !ids || ids.includes(a.id));
  if (!abs.length) return;
  const r = viewport.getBoundingClientRect();
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const a of abs) {
    const el = elFor(a.id);
    const w = el ? el.offsetWidth : parseInt(a.style.width, 10) || 600, h = el ? el.offsetHeight : 800;
    x0 = Math.min(x0, a.x); y0 = Math.min(y0, a.y); x1 = Math.max(x1, a.x + w); y1 = Math.max(y1, a.y + h);
  }
  const pad = 70;
  const z = Math.min(1, Math.min((r.width - pad * 2) / (x1 - x0), (r.height - pad * 2) / (y1 - y0)));
  view.z = Math.max(0.08, z);
  view.x = (r.width - (x1 - x0) * view.z) / 2 - x0 * view.z;
  view.y = (r.height - (y1 - y0) * view.z) / 2 - y0 * view.z + 10;
  applyView();
}
viewport.addEventListener("wheel", (e) => {
  e.preventDefault();
  // while cropping, pinching / ctrl-scrolling zooms the picture inside its frame instead of the canvas
  if (cropping && (e.ctrlKey || e.metaKey)) { cropZoomBy(Math.exp(-e.deltaY * 0.01)); return; }
  const r = viewport.getBoundingClientRect();
  if (e.ctrlKey || e.metaKey) zoomAt(e.clientX - r.left, e.clientY - r.top, view.z * Math.exp(-e.deltaY * 0.01));
  else { view.x -= e.deltaX; view.y -= e.deltaY; applyView(); }
}, { passive: false });
// Safari/WebKit (the Mac app) reports trackpad pinches as gesture events instead of ctrl+wheel
let gestureZ = 1;
viewport.addEventListener("gesturestart", (e) => { e.preventDefault(); gestureZ = view.z; });
viewport.addEventListener("gesturechange", (e) => { e.preventDefault(); const r = viewport.getBoundingClientRect(); zoomAt(e.clientX - r.left, e.clientY - r.top, gestureZ * e.scale); });
viewport.addEventListener("gestureend", (e) => e.preventDefault());
new ResizeObserver(drawOverlay).observe(viewport);

// ---------- overlay: selection boxes, artboard titles, hover ----------
// Alt-hover: pixel distances between the selection and what you point at
function measure(a, b) {
  const z = view.z;
  const ov = (a0, a1, b0, b1) => { const lo = Math.max(a0, b0), hi = Math.min(a1, b1); return hi > lo ? (lo + hi) / 2 : null; };
  const seg = (x0, y0, x1, y1) => {
    const len = Math.max(x1 - x0, y1 - y0);
    if (len < 0.5) return;
    const l = document.createElement("div"); l.className = "dist-line";
    Object.assign(l.style, { left: x0 + "px", top: y0 + "px", width: Math.max(x1 - x0, 1) + "px", height: Math.max(y1 - y0, 1) + "px" });
    const t = document.createElement("div"); t.className = "dist-label"; t.textContent = Math.round(len / z);
    Object.assign(t.style, { left: (x0 + x1) / 2 + "px", top: (y0 + y1) / 2 + "px" });
    overlay.append(l, t);
  };
  const ym = ov(a.y, a.y + a.h, b.y, b.y + b.h) ?? a.y + a.h / 2, xm = ov(a.x, a.x + a.w, b.x, b.x + b.w) ?? a.x + a.w / 2;
  const aR = a.x + a.w, bR = b.x + b.w, aB = a.y + a.h, bB = b.y + b.h;
  if (b.x >= aR) seg(aR, ym, b.x, ym); else if (bR <= a.x) seg(bR, ym, a.x, ym);
  else { seg(Math.min(a.x, b.x), ym, Math.max(a.x, b.x), ym); seg(Math.min(aR, bR), ym, Math.max(aR, bR), ym); }
  if (b.y >= aB) seg(xm, aB, xm, b.y); else if (bB <= a.y) seg(xm, bB, xm, a.y);
  else { seg(xm, Math.min(a.y, b.y), xm, Math.max(a.y, b.y)); seg(xm, Math.min(aB, bB), xm, Math.max(aB, bB)); }
}
const titleEls = new Map(); // persistent, so a click on a title isn't lost when the overlay redraws
function drawOverlay() {
  const vr = viewport.getBoundingClientRect();
  [...overlay.children].forEach((c) => c.classList.contains("ab-title") || c.remove());
  const rect = (el) => { const r = el.getBoundingClientRect(); return { x: r.left - vr.left, y: r.top - vr.top, w: r.width, h: r.height }; };
  const live = new Set();
  for (const ab of state.artboards) {
    const el = elFor(ab.id);
    if (!el) continue;
    live.add(ab.id);
    const r = rect(el);
    let t = titleEls.get(ab.id);
    if (!t) { t = document.createElement("div"); t.dataset.title = ab.id; titleEls.set(ab.id, t); }
    if (t.parentNode !== overlay) overlay.appendChild(t);
    t.className = "ab-title" + (selection.includes(ab.id) ? " sel" : "");
    if (!t.querySelector("input")) t.textContent = ab.name || "Artboard";
    t.style.left = r.x + "px"; t.style.top = r.y + "px";
  }
  for (const [id, t] of titleEls) if (!live.has(id)) { t.remove(); titleEls.delete(id); }
  if (hoverId && !selection.includes(hoverId) && !drag) {
    const el = elFor(hoverId);
    if (el) { const r = rect(el); const b = document.createElement("div"); b.className = "hover-box"; Object.assign(b.style, { left: r.x + "px", top: r.y + "px", width: r.w + "px", height: r.h + "px" }); overlay.appendChild(b); }
  }
  if (altDown && !drag && selection.length === 1 && hoverId && hoverId !== selection[0]) {
    const a = elFor(selection[0]), b = elFor(hoverId);
    if (a && b) measure(rect(a), rect(b));
  }
  for (const id of selection) {
    const el = elFor(id), n = nodeOf(id);
    if (!el || !n) continue;
    const r = rect(el);
    const b = document.createElement("div"); b.className = "sel-box" + (cropping && cropping.id === id ? " crop" : "");
    Object.assign(b.style, { left: r.x + "px", top: r.y + "px", width: r.w + "px", height: r.h + "px" });
    overlay.appendChild(b);
    if (selection.length === 1 && !drag?.indicator) {
      const abs = n.style && n.style.position === "absolute";
      // the whole blue edge is grabbable, not just the dots
      for (const h of n.artboard ? ["e", "s"] : ["n", "s", "e", "w"]) {
        const d = document.createElement("div"), T = 8;
        d.className = "edge"; d.dataset.h = h;
        if (h === "n" || h === "s") Object.assign(d.style, { left: r.x + "px", top: (h === "n" ? r.y : r.y + r.h) - T / 2 + "px", width: r.w + "px", height: T + "px", cursor: "ns-resize" });
        else Object.assign(d.style, { top: r.y + "px", left: (h === "w" ? r.x : r.x + r.w) - T / 2 + "px", height: r.h + "px", width: T + "px", cursor: "ew-resize" });
        overlay.appendChild(d);
      }
      for (const h of n.artboard ? ["e", "s", "se"] : ["n", "s", "e", "w", "ne", "nw", "se", "sw"]) {
        const d = document.createElement("div");
        d.className = "handle"; d.dataset.h = h;
        d.style.left = (h.includes("w") ? r.x : h.includes("e") ? r.x + r.w : r.x + r.w / 2) + "px";
        d.style.top = (h.includes("n") ? r.y : h.includes("s") ? r.y + r.h : r.y + r.h / 2) + "px";
        d.style.cursor = (h.length === 2 ? (h === "nw" || h === "se" ? "nwse" : "nesw") : h === "n" || h === "s" ? "ns" : "ew") + "-resize";
        overlay.appendChild(d);
      }
    }
    if (selection.length === 1 && !n.artboard && !drag?.indicator && !(drag && drag.kind === "move" && drag.moved)) {
      const rb = document.createElement("div"); rb.className = "rot"; rb.title = "Rotate (⇧ snaps to 15°)";
      Object.assign(rb.style, { left: r.x + r.w / 2 + "px", top: r.y - 28 + "px" });
      overlay.appendChild(rb);
    }
    if (!n.artboard) {
      const tag = document.createElement("div"); tag.className = "sel-tag"; tag.textContent = drag && drag.kind === "rotate" && drag.id === id ? `${Math.round(drag.deg)}°` : `${label(n)}  ${Math.round(el.offsetWidth)} × ${Math.round(el.offsetHeight)}`;
      Object.assign(tag.style, { left: r.x + "px", top: r.y + "px" });
      overlay.appendChild(tag);
    }
  }
  if (drag && drag.indicator) overlay.appendChild(drag.indicator);
  // equal-spacing guides: the gaps that match, with their size
  if (drag && drag.spacing) for (const g of drag.spacing) {
    const line = document.createElement("div"), lab = document.createElement("div");
    line.className = "dist-line"; lab.className = "dist-label"; lab.textContent = Math.round(g.size / view.z);
    if (g.axis === "x") { Object.assign(line.style, { left: g.from - vr.left + "px", top: g.at - vr.top + "px", width: g.to - g.from + "px", height: "1px" }); Object.assign(lab.style, { left: (g.from + g.to) / 2 - vr.left + "px", top: g.at - vr.top + "px" }); }
    else { Object.assign(line.style, { top: g.from - vr.top + "px", left: g.at - vr.left + "px", height: g.to - g.from + "px", width: "1px" }); Object.assign(lab.style, { top: (g.from + g.to) / 2 - vr.top + "px", left: g.at - vr.left + "px" }); }
    overlay.append(line, lab);
  }
  if (drag && drag.guides) {
    for (const x of drag.guides.x) { const g = document.createElement("div"); g.className = "guide"; Object.assign(g.style, { left: x - vr.left + "px", top: 0, width: "1px", height: "100%" }); overlay.appendChild(g); }
    for (const y of drag.guides.y) { const g = document.createElement("div"); g.className = "guide"; Object.assign(g.style, { top: y - vr.top + "px", left: 0, height: "1px", width: "100%" }); overlay.appendChild(g); }
  }
  if (pen) pen.drawOverlay(overlay);
  if (guides) guides.draw();
}

// ---------- selection ----------
let selTimer;
function select(ids, { scroll = true } = {}) {
  if (pen && pen.editing() && !(ids.length === 1 && ids[0] === pen.editId())) pen.exitEdit();
  selection = ids.filter(Boolean);
  for (const g of [...entered]) if (!selection.some((id) => id === g || find(id, find(g)?.node.children || []))) entered.delete(g);
  clearTimeout(selTimer);
  selTimer = setTimeout(() => op("selection", { ids: selection }).catch(() => {}), 120);
  // expand collapsed ancestors; rebuild the list only if that changed it, otherwise just move the highlight
  // (rebuilding rows mid-click would swallow double-clicks)
  let expanded = false;
  for (const id of selection) for (let r = find(id); r && r.parent; r = find(r.parent.id)) if (collapsed.delete(r.parent.id)) expanded = true;
  drawOverlay(); renderInspector();
  if (expanded) return renderLayers(scroll);
  layersList.querySelectorAll(".lrow.sel").forEach((x) => x.classList.remove("sel"));
  for (const id of selection) layersList.querySelector(`[data-lid="${id}"]`)?.classList.add("sel");
  if (scroll && selection[0]) layersList.querySelector(`[data-lid="${selection[0]}"]`)?.scrollIntoView({ block: "nearest" });
}

// ---------- canvas pointer handling ----------
// clicking a layer inside a group picks the whole group, like Figma; double-click goes inside
function pickFrom(t) {
  let pick = t;
  for (let x = t; x && world.contains(x); x = x.parentElement && x.parentElement.closest("[data-id]")) if (x.dataset.group && !entered.has(x.dataset.id)) pick = x;
  return pick.dataset.id;
}
function targetId(e) { const t = e.target.closest && e.target.closest("[data-id]"); return t && world.contains(t) ? pickFrom(t) : null; }
viewport.addEventListener("pointerdown", (e) => {
  if (e.target.closest("#toolbar, .menu, #pop")) return;
  if (e.button === 2) return; // right click: context menu
  if (editing) { if (!e.target.closest("[contenteditable]")) finishEdit(true); else return; }
  if (e.target.closest("input")) return;
  if (pen && pen.editing() && pen.vecDown(e)) return;     // points and handles of a path being edited
  if (pen && pen.editing() && pen.vecPickPath(e)) { drawOverlay(); return; }
  if (guides && guides.pointerDown(e)) return;             // grabbing an existing guide
  viewport.setPointerCapture(e.pointerId);
  const title = e.target.closest(".ab-title");
  const handle = e.target.closest(".handle, .edge");
  if (handle && selection.length === 1) {
    const n = nodeOf(selection[0]), el = elFor(n.id);
    drag = { kind: "resize", h: handle.dataset.h, id: n.id, n, el, sx: e.clientX, sy: e.clientY, w0: el.offsetWidth, h0: el.offsetHeight, start: absStart(n, el), moved: false };
    return;
  }
  if (e.target.closest(".rot") && selection.length === 1) { startRotate(e); return; }
  if (e.button === 1 || spaceDown) { drag = { kind: "pan", sx: e.clientX, sy: e.clientY, ox: view.x, oy: view.y }; viewport.classList.add("panning"); return; }
  if (title) {
    const id = title.dataset.title;
    if (!(e.shiftKey && selection.length)) select([id]); else select([...selection, id]);
    const ab = nodeOf(id);
    drag = { kind: "artboard", id, sx: e.clientX, sy: e.clientY, ox: ab.x, oy: ab.y, moved: false, wrap: world.querySelector(`[data-abw="${id}"]`) };
    return;
  }
  if (tool === "pen") { pen.pointerDown(e); drag = { kind: "pen", moved: false }; return; }
  if (tool !== "select") {
    // drawing: find the frame under the cursor, then drag out the new shape
    const hit = document.elementFromPoint(e.clientX, e.clientY);
    let el = hit && world.contains(hit) ? hit.closest("[data-id]") : null;
    while (el) { const nn = nodeOf(el.dataset.id); if (nn && isContainer(nn)) break; el = el.parentElement && el.parentElement.closest("[data-id]"); }
    if (!el) { toast("Draw inside an artboard."); return; }
    drag = { kind: "draw", tool, parentId: el.dataset.id, parentEl: el, sx: e.clientX, sy: e.clientY, moved: false };
    return;
  }
  if (cropping) {
    const hit = document.elementFromPoint(e.clientX, e.clientY);
    const el = elFor(cropping.id), cn = nodeOf(cropping.id);
    if (el && cn && cn.crop && (hit === el || el.contains(hit))) {
      // a zoomed crop: dragging slides the picture inside its frame
      const pic = el.firstElementChild, W = el.offsetWidth, H = el.offsetHeight, iw = pic.offsetWidth, ih = pic.offsetHeight;
      drag = { kind: "crop", frame: true, id: cropping.id, el, pic, sx: e.clientX, sy: e.clientY, W, H, iw, ih, px0: cn.crop.px, py0: cn.crop.py, moved: false };
      return;
    }
    if (el && hit === el) {
      const pos = (getComputedStyle(el).objectPosition || "50% 50%").split(" ").map((v) => parseFloat(v));
      drag = { kind: "crop", id: cropping.id, el, sx: e.clientX, sy: e.clientY, nw: el.naturalWidth || 1, nh: el.naturalHeight || 1, w: el.offsetWidth, h: el.offsetHeight, px0: isNaN(pos[0]) ? 50 : pos[0], py0: isNaN(pos[1]) ? 50 : pos[1], moved: false };
      return;
    }
    endCrop();
  }
  const id = targetId(e);
  // empty canvas: box-select artboards. (Pan with Space+drag, the middle button, or scrolling.)
  if (!id) { if (!e.shiftKey) select([]); drag = { kind: "marquee", scope: null, base: e.shiftKey ? [...selection] : [], sx: e.clientX, sy: e.clientY, moved: false }; return; }
  if (e.shiftKey) select(selection.includes(id) ? selection.filter((s) => s !== id) : [...selection, id]);
  else if (!selection.includes(id)) select([id]);
  const n = nodeOf(id);
  // pressing on an artboard's background: box-select inside it
  if (n.artboard) { drag = { kind: "marquee", scope: id, base: e.shiftKey ? [...selection] : [], sx: e.clientX, sy: e.clientY, moved: false }; return; }
  // a layer inside an auto-layout frame is reordered, not freely placed (the frame keeps laying its children out)
  const par = find(id)?.parent;
  const flowEl = !["absolute", "fixed"].includes(getComputedStyle(elFor(id)).position);
  drag = { kind: par && par.auto && flowEl ? "reorder" : "move", id, sx: e.clientX, sy: e.clientY, moved: false, el: elFor(id), n };
});
const inAuto = (id) => { const r = find(id); const el = elFor(id); return !!(r && r.parent && r.parent.auto && el && !["absolute", "fixed"].includes(getComputedStyle(el).position)); };
// Nothing in the canvas reflows when you touch it. Before a layer is moved or resized, everything that sits in its parent's
// layout is pinned where it is (position:absolute at its measured spot) and the parent keeps its height. One undo step.
// Returns the style updates and each pinned layer's spot in the parent (canvas units).
function pinPlan(ids) {
  const z = view.z, updates = [], pos = new Map(), seen = new Set();
  const r1 = (v) => Math.round(v * 10) / 10;   // tenths of a pixel: invisible, and never a 1px jump
  const auto = (v) => !v || /^(auto|fit-content|max-content|min-content)$/.test(v);
  for (const id of ids) {
    const first = elFor(id);
    if (!first || seen.has(first.parentElement)) continue;
    const par = first.parentElement; seen.add(par);
    const pr = par.getBoundingClientRect(), pcs = getComputedStyle(par);
    const flow = [...par.children].filter((c) => c.dataset && c.dataset.id && !["absolute", "fixed"].includes(getComputedStyle(c).position) && getComputedStyle(c).display !== "none");
    if (!flow.length) continue;
    const pn = nodeOf(par.dataset.id);
    // the parent keeps its exact size: once its children leave the layout it would otherwise shrink-wrap to nothing
    const ps = {};
    if (pcs.position === "static") ps.position = "relative";
    if (pn && auto(pn.style.height)) ps.height = r1(parseFloat(pcs.height)) + "px";
    if (pn && auto(pn.style.width)) ps.width = r1(parseFloat(pcs.width)) + "px";
    if (Object.keys(ps).length && par.dataset.id) updates.push({ nodeIds: [par.dataset.id], styles: ps });
    for (const c of flow) {
      const r = c.getBoundingClientRect(), cs = getComputedStyle(c), n = nodeOf(c.dataset.id);
      const w = parseFloat(cs.width), h = parseFloat(cs.height);   // layout size, exact (not the rotated bounding box)
      // measured from the centre, so a rotated layer keeps its place
      const left = (r.left + r.width / 2 - pr.left) / z - w / 2 - (parseFloat(pcs.borderLeftWidth) || 0) - (parseFloat(cs.marginLeft) || 0);
      const top = (r.top + r.height / 2 - pr.top) / z - h / 2 - (parseFloat(pcs.borderTopWidth) || 0) - (parseFloat(cs.marginTop) || 0);
      const styles = { position: "absolute", left: r1(left) + "px", top: r1(top) + "px", width: r1(w + 0.05) + "px" };
      // text keeps its natural height (so editing it later still grows it); everything else keeps its measured height
      if (!(n && isTextLeaf(n)) || !auto(n.style.height)) styles.height = r1(h) + "px";
      updates.push({ nodeIds: [c.dataset.id], styles });
      pos.set(c.dataset.id, { left: r1(left), top: r1(top), width: r1(w), height: r1(h) });
    }
  }
  return { updates, pos };
}
// show the pins on screen right away so nothing jumps while you drag
function applyPinsDom(updates) {
  for (const u of updates) for (const id of u.nodeIds) { const el = elFor(id); if (el) for (const [k, v] of Object.entries(u.styles)) el.style.setProperty(k, v); }
}
function absStart(n, el) {
  const num = (v) => (v === undefined ? null : parseFloat(v));
  return { left: num(n.style.left), top: num(n.style.top), right: num(n.style.right), bottom: num(n.style.bottom), ol: el.offsetLeft, ot: el.offsetTop };
}
// styles that move an absolute element by (ux, uy) canvas units, keeping its anchoring (left/top or right/bottom)
function absMove(s, ux, uy) {
  const out = {};
  if (s.left !== null || s.right === null) out.left = Math.round((s.left ?? s.ol) + ux) + "px"; else out.right = Math.round(s.right - ux) + "px";
  if (s.top !== null || s.bottom === null) out.top = Math.round((s.top ?? s.ot) + uy) + "px"; else out.bottom = Math.round(s.bottom - uy) + "px";
  return out;
}
function snap(vals, targets) {
  let best = null;
  for (const t of targets) for (const m of vals) { const d = t - m; if (Math.abs(d) <= 6 && (!best || Math.abs(d) < Math.abs(best.d))) best = { d, at: t }; }
  return best;
}
viewport.addEventListener("pointermove", (e) => {
  if (!drag) {
    if (tool === "pen" && pen) pen.hoverMove(e);
    const id = targetId(e);
    if (id !== hoverId) { hoverId = id; drawOverlay(); }
    return;
  }
  const dx = e.clientX - drag.sx, dy = e.clientY - drag.sy;
  if (drag.kind === "pan") { view.x = drag.ox + dx; view.y = drag.oy + dy; applyView(); return; }
  if (drag.kind === "pen") { pen.pointerMove(e); return; }
  if (drag.kind === "rotate") { rotateMove(e); return; }
  if (!drag.moved && Math.hypot(dx, dy) < (drag.kind === "resize" ? 1 : 4)) return;
  drag.moved = true;
  if (drag.kind === "artboard") { drag.nx = Math.round(drag.ox + dx / view.z); drag.ny = Math.round(drag.oy + dy / view.z); drag.wrap.style.left = drag.nx + "px"; drag.wrap.style.top = drag.ny + "px"; drawOverlay(); }
  else if (drag.kind === "move") {
    if (!drag.items) startMove();
    let sdx = dx, sdy = dy;
    drag.guides = { x: [], y: [] };
    if (snapOn && !e.metaKey) {
      const r = drag.r0;
      const sx = snap([r.left + dx, r.left + dx + r.width / 2, r.right + dx], drag.tx), sy = snap([r.top + dy, r.top + dy + r.height / 2, r.bottom + dy], drag.ty);
      if (sx) { sdx += sx.d; drag.guides.x.push(sx.at); }
      if (sy) { sdy += sy.d; drag.guides.y.push(sy.at); }
      // equal spacing with the neighbours (only on an axis where no edge snapped)
      drag.spacing = [];
      const at = () => ({ l: r.left + sdx, t: r.top + sdy, r: r.right + sdx, b: r.bottom + sdy });
      let usedX = !!sx, usedY = !!sy;
      if (drag.rects && !sx) { const sp = spacingSnap(at(), drag.rects, "x", 6); if (sp) { sdx += sp.shift; usedX = true; for (const g of sp.gaps) drag.spacing.push({ axis: "x", from: g.from, to: g.to, at: g.at, size: g.size }); } }
      if (drag.rects && !sy) { const sp = spacingSnap(at(), drag.rects, "y", 6); if (sp) { sdy += sp.shift; usedY = true; for (const g of sp.gaps) drag.spacing.push({ axis: "y", from: g.from, to: g.to, at: g.at, size: g.size }); } }
      // the artboard's layout grid
      if (guides && drag.abId) { const a = at(), gs = guides.gridSnap(drag.abId, { left: a.l, top: a.t, right: a.r, bottom: a.b }, 6); if (gs) { if (gs.dx != null && !usedX) sdx += gs.dx; if (gs.dy != null && !usedY) sdy += gs.dy; } }
    }
    drag.final = drag.items.map((it) => {
      const styles = absMove(it.start, sdx / view.z, sdy / view.z);
      for (const [k, v] of Object.entries(styles)) it.el.style[k] = v;
      return { nodeIds: [it.id], styles };
    });
    drawOverlay();
  } else if (drag.kind === "resize") {
    if (!drag.pinned) startResize();
    const { h, start: s, n } = drag, z = view.z;
    let w = drag.w0, ht = drag.h0;
    if (h.includes("e")) w += dx / z;
    if (h.includes("w")) w -= dx / z;
    if (h.includes("s")) ht += dy / z;
    if (h.includes("n")) ht -= dy / z;
    if (e.shiftKey && h.length === 2) { const k = Math.max(w / drag.w0, ht / drag.h0); w = drag.w0 * k; ht = drag.h0 * k; }
    w = Math.max(8, Math.round(w)); ht = Math.max(8, Math.round(ht));
    const styles = {};
    if (h.includes("e") || h.includes("w")) styles.width = w + "px";
    if (h.includes("s") || h.includes("n")) styles.height = ht + "px";
    if (!n.artboard && !drag.sizeOnly) {
      const dw = w - drag.w0, dh = ht - drag.h0;
      if (h.includes("e") && s.left === null && s.right !== null) styles.right = Math.round(s.right - dw) + "px";
      if (h.includes("w") && (s.left !== null || s.right === null)) styles.left = Math.round((s.left ?? s.ol) - dw) + "px";
      if (h.includes("s") && s.top === null && s.bottom !== null) styles.bottom = Math.round(s.bottom - dh) + "px";
      if (h.includes("n") && (s.top !== null || s.bottom === null)) styles.top = Math.round((s.top ?? s.ot) - dh) + "px";
    }
    drag.styles = styles;
    for (const [k, v] of Object.entries(styles)) drag.el.style[k] = v;
    drawOverlay();
  } else if (drag.kind === "reorder") reorderMove(e);
  else if (drag.kind === "crop") cropPan(e);
  else if (drag.kind === "marquee") {
    const vr = viewport.getBoundingClientRect();
    const b = { l: Math.min(drag.sx, e.clientX), t: Math.min(drag.sy, e.clientY), r: Math.max(drag.sx, e.clientX), b: Math.max(drag.sy, e.clientY) };
    const cands = drag.scope ? [...elFor(drag.scope).children].filter((c) => c.dataset && c.dataset.id) : state.artboards.map((a) => elFor(a.id)).filter(Boolean);
    const hits = cands.filter((c) => { const r = c.getBoundingClientRect(); return r.left < b.r && r.right > b.l && r.top < b.b && r.bottom > b.t && getComputedStyle(c).display !== "none"; }).map((c) => c.dataset.id);
    const next = [...new Set([...drag.base, ...hits])];
    if (next.join() !== selection.join()) select(next, { scroll: false });
    const ind = document.createElement("div"); ind.className = "marquee";
    Object.assign(ind.style, { left: b.l - vr.left + "px", top: b.t - vr.top + "px", width: b.r - b.l + "px", height: b.b - b.t + "px" });
    drag.indicator = ind; drawOverlay();
  } else if (drag.kind === "draw") {
    const vr = viewport.getBoundingClientRect();
    drag.box = { x0: Math.min(drag.sx, e.clientX), y0: Math.min(drag.sy, e.clientY), x1: Math.max(drag.sx, e.clientX), y1: Math.max(drag.sy, e.clientY) };
    const ind = document.createElement("div"); ind.className = "draw-box";
    Object.assign(ind.style, { left: drag.box.x0 - vr.left + "px", top: drag.box.y0 - vr.top + "px", width: drag.box.x1 - drag.box.x0 + "px", height: drag.box.y1 - drag.box.y0 + "px" });
    const tag = document.createElement("span"); tag.className = "draw-size"; tag.textContent = `${Math.round((drag.box.x1 - drag.box.x0) / view.z)} × ${Math.round((drag.box.y1 - drag.box.y0) / view.z)}`; ind.appendChild(tag);
    drag.indicator = ind; drawOverlay();
  }
});
// ----- auto layout: turn a free arrangement into a row / column that lays itself out, and back -----
async function toggleAutoLayout(id) {
  const n = nodeOf(id), el = elFor(id);
  if (!n || !el) return;
  const kids = [...el.children].filter((c) => c.dataset && c.dataset.id && getComputedStyle(c).display !== "none");
  if (n.auto) {
    // off: the children keep exactly where they are, as free layers
    const flow = kids.filter((c) => !["absolute", "fixed"].includes(getComputedStyle(c).position));
    const plan = flow.length ? pinPlan(flow.map((c) => c.dataset.id)) : { updates: [] };
    try { await op("setAutoLayout", { nodeId: id, auto: false, updates: plan.updates }); } catch {}
    return;
  }
  const z = view.z, fr = el.getBoundingClientRect(), cs = getComputedStyle(el);
  const bl = parseFloat(cs.borderLeftWidth) || 0, bt = parseFloat(cs.borderTopWidth) || 0;
  const W = el.clientWidth, H = el.clientHeight;
  const rects = kids.map((c) => { const r = c.getBoundingClientRect(), k = getComputedStyle(c); const w = parseFloat(k.width), h = parseFloat(k.height); return { id: c.dataset.id, x: (r.left + r.width / 2 - fr.left) / z - bl - w / 2, y: (r.top + r.height / 2 - fr.top) / z - bt - h / 2, w, h }; });
  const frameStyles = { display: "flex", "justify-content": "flex-start" };
  let order = null, childStyles = [];
  if (rects.length) {
    const ov = (a0, al, b0, bl2) => Math.min(a0 + al, b0 + bl2) - Math.max(a0, b0);
    const rowish = rects.length > 1 && rects.every((a) => rects.every((b) => ov(a.y, a.h, b.y, b.h) > 0.5 * Math.min(a.h, b.h)));
    const dir = rowish ? "row" : "column";
    const sorted = [...rects].sort((a, b) => (dir === "row" ? a.x - b.x : a.y - b.y));
    const gaps = []; for (let i = 0; i + 1 < sorted.length; i++) gaps.push(dir === "row" ? sorted[i + 1].x - (sorted[i].x + sorted[i].w) : sorted[i + 1].y - (sorted[i].y + sorted[i].h));
    const gap = gaps.length ? Math.max(0, Math.round(gaps.reduce((a, b) => a + b, 0) / gaps.length)) : 0;
    const pad = { t: Math.max(0, Math.round(Math.min(...rects.map((r) => r.y)))), l: Math.max(0, Math.round(Math.min(...rects.map((r) => r.x)))) };
    pad.b = Math.max(0, Math.round(H - Math.max(...rects.map((r) => r.y + r.h)))); pad.r = Math.max(0, Math.round(W - Math.max(...rects.map((r) => r.x + r.w))));
    const same = (f) => { const v = rects.map(f); return Math.max(...v) - Math.min(...v) <= 1.5; };
    const align = dir === "column" ? (same((r) => r.x) ? "flex-start" : same((r) => r.x + r.w / 2) ? "center" : same((r) => r.x + r.w) ? "flex-end" : "flex-start") : (same((r) => r.y) ? "flex-start" : same((r) => r.y + r.h / 2) ? "center" : same((r) => r.y + r.h) ? "flex-end" : "flex-start");
    Object.assign(frameStyles, { "flex-direction": dir, gap: gap + "px", padding: `${pad.t}px ${pad.r}px ${pad.b}px ${pad.l}px`, "align-items": align });
    order = sorted.map((r) => r.id);
    childStyles = [{ nodeIds: rects.map((r) => r.id), styles: { position: null, left: null, top: null, right: null, bottom: null } }];
  } else frameStyles["flex-direction"] = "column";
  if (!n.artboard) frameStyles.height = null;            // the frame now hugs its content
  try { await op("setAutoLayout", { nodeId: id, auto: true, order, updates: [{ nodeIds: [id], styles: frameStyles }, ...childStyles] }); } catch {}
}

// ----- rotate: the handle above the selection; ⇧ snaps to 15° -----
const rotOf = (t) => { const m = /rotate\((-?[\d.]+)deg\)/.exec(t || ""); return m ? parseFloat(m[1]) : 0; };
const withRot = (t, deg) => {
  t = t || "";
  const has = /rotate\((-?[\d.]+)deg\)/.test(t);
  if (Math.abs(deg) < 0.01) return has ? t.replace(/\s*rotate\((-?[\d.]+)deg\)\s*/, " ").trim() : t;
  return has ? t.replace(/rotate\((-?[\d.]+)deg\)/, `rotate(${deg}deg)`) : `rotate(${deg}deg) ${t}`.trim();
};
function startRotate(e) {
  const n = nodeOf(selection[0]), el = elFor(n.id); if (!n || !el) return;
  const r = el.getBoundingClientRect(), cx = r.left + r.width / 2, cy = r.top + r.height / 2;
  drag = { kind: "rotate", id: n.id, n, el, cx, cy, a0: Math.atan2(e.clientY - cy, e.clientX - cx), deg0: rotOf(n.style.transform), deg: rotOf(n.style.transform), sx: e.clientX, sy: e.clientY, moved: false };
}
function rotateMove(e) {
  const d = drag;
  let deg = d.deg0 + ((Math.atan2(e.clientY - d.cy, e.clientX - d.cx) - d.a0) * 180) / Math.PI;
  deg = ((deg + 540) % 360) - 180;
  if (e.shiftKey) deg = Math.round(deg / 15) * 15;
  d.deg = Math.round(deg * 10) / 10; d.moved = true;
  d.el.style.transform = withRot(d.n.style.transform, d.deg);
  drawOverlay();
}
async function rotateEnd(d) {
  if (!d.moved) return;
  const t = withRot(d.n.style.transform, d.deg);
  try { await op("updateStyles", { updates: [{ nodeIds: [d.id], styles: { transform: t || null } }] }); } catch {}
}

// ----- reorder: dragging a layer inside an auto-layout frame -----
function reorderMove(e) {
  const d = drag, el = d.el, z = view.z;
  if (!d.started) {
    d.started = true; el.style.opacity = "0.55"; el.style.zIndex = "40"; el.style.pointerEvents = "none"; el.style.transition = "none";
  }
  el.style.translate = `${(e.clientX - d.sx) / z}px ${(e.clientY - d.sy) / z}px`;
  d.drop = null; d.indicator = null;
  const stack = document.elementsFromPoint(e.clientX, e.clientY).filter((x) => x.dataset && x.dataset.id && world.contains(x) && !el.contains(x));
  let cont = null;
  for (const x of stack) { const nn = nodeOf(x.dataset.id); if (nn && isContainer(nn) && nn.auto) { cont = x; break; } }
  if (cont) {
    const kids = [...cont.children].filter((c) => c.dataset.id && c !== el && getComputedStyle(c).position !== "absolute" && getComputedStyle(c).display !== "none");
    const cs = getComputedStyle(cont), row = cs.display.includes("flex") && cs.flexDirection.startsWith("row");
    let index = kids.length;
    for (let i = 0; i < kids.length; i++) { const r = kids[i].getBoundingClientRect(); if (row ? e.clientX < r.left + r.width / 2 : e.clientY < r.top + r.height / 2) { index = i; break; } }
    const vr = viewport.getBoundingClientRect(), ind = document.createElement("div");
    if (!kids.length) { const r = cont.getBoundingClientRect(); ind.className = "drop-box"; Object.assign(ind.style, { left: r.left - vr.left + "px", top: r.top - vr.top + "px", width: r.width + "px", height: r.height + "px" }); }
    else {
      ind.className = "drop-line";
      const ref = index < kids.length ? kids[index] : kids[kids.length - 1], r = ref.getBoundingClientRect(), after = index >= kids.length;
      if (row) Object.assign(ind.style, { left: (after ? r.right : r.left) - vr.left - 1.5 + "px", top: r.top - vr.top + "px", width: "3px", height: r.height + "px" });
      else Object.assign(ind.style, { left: r.left - vr.left + "px", top: (after ? r.bottom : r.top) - vr.top - 1.5 + "px", width: r.width + "px", height: "3px" });
    }
    d.indicator = ind; d.drop = { parentId: cont.dataset.id, index, refId: index < kids.length ? kids[index].dataset.id : null };
  }
  drawOverlay();
}
async function reorderEnd(d, cancelled) {
  const el = d.el;
  if (el) { el.style.opacity = ""; el.style.zIndex = ""; el.style.pointerEvents = ""; el.style.transition = ""; el.style.translate = ""; }
  if (cancelled || !d.moved || !d.drop) { if (d.started) refresh(); drawOverlay(); return; }
  const r = find(d.id), target = nodeOf(d.drop.parentId);
  // the index among the frame's children without the dragged layer, whatever else (absolute layers) sits in there
  const others = (target.children || []).filter((c) => c.id !== d.id);
  const index = d.drop.refId ? others.findIndex((c) => c.id === d.drop.refId) : others.length;
  const sameSpot = r.parent && r.parent.id === d.drop.parentId && index === (r.parent.children || []).filter((c) => c.id !== d.id).findIndex((c, i) => i === r.index);
  if (!sameSpot) { try { await op("move", { nodeId: d.id, parentId: d.drop.parentId, index }); } catch {} } else refresh();
  drawOverlay();
}

// the first time a layer actually moves: pin its layout neighbours, then it follows the cursor as a free layer
function startMove() {
  const items = selection.map((sid) => ({ id: sid, n: nodeOf(sid), el: elFor(sid) })).filter((it) => it.n && it.el && !it.n.artboard);
  const flowIds = items.filter((it) => !["absolute", "fixed"].includes(getComputedStyle(it.el).position)).map((it) => it.id);
  const plan = pinPlan(flowIds);
  drag.pins = plan.updates;
  applyPinsDom(plan.updates);
  drag.items = items.map((it) => {
    const p = plan.pos.get(it.id);
    return { ...it, start: p ? { left: p.left, top: p.top, right: null, bottom: null, ol: p.left, ot: p.top } : absStart(it.n, it.el) };
  });
  // snap targets (screen coordinates): the parent's and the siblings' edges and centres
  const el = drag.el;
  drag.r0 = el.getBoundingClientRect(); drag.tx = []; drag.ty = [];
  const par = el.parentElement;
  const sibs = [...par.children].filter((c) => c.dataset && c.dataset.id && !drag.items.some((it) => it.el === c));
  for (const rf of [par, ...sibs]) { const b = rf.getBoundingClientRect(); drag.tx.push(b.left, b.left + b.width / 2, b.right); drag.ty.push(b.top, b.top + b.height / 2, b.bottom); }
  drag.rects = sibs.filter((c) => getComputedStyle(c).display !== "none").map((c) => { const b = c.getBoundingClientRect(); return { l: b.left, t: b.top, r: b.right, b: b.bottom }; });
  // the artboard's own guides are snap targets too
  drag.abId = artboardOf(drag.id)?.id;
  if (guides && drag.abId) { const g = guides.guideTargets(drag.abId); drag.tx.push(...g.x); drag.ty.push(...g.y); }
}
function startResize() {
  drag.pinned = true;
  const { n, el } = drag;
  if (n.artboard) return;
  if (inAuto(n.id)) { drag.sizeOnly = true; return; }     // the frame keeps laying it out: only its size changes
  if (!["absolute", "fixed"].includes(getComputedStyle(el).position)) {
    const plan = pinPlan([n.id]);
    drag.pins = plan.updates;
    applyPinsDom(plan.updates);
    const p = plan.pos.get(n.id);
    if (p) drag.start = { left: p.left, top: p.top, right: null, bottom: null, ol: p.left, ot: p.top };
  }
}
viewport.addEventListener("pointerup", async (e) => {
  const d = drag; drag = null;
  viewport.classList.remove("panning");
  if (!d) return;
  if (d.kind === "pan") return;
  if (d.kind === "pen") { pen.pointerUp(e); return; }
  if (d.kind === "rotate") return rotateEnd(d);
  if (d.kind === "reorder") return reorderEnd(d);
  if (d.kind === "draw") return finishDraw(d);
  if (d.kind === "marquee") { drawOverlay(); return; }
  if (d.kind === "crop") {
    if (d.frame) { if (d.moved) await op("cropImage", { nodeId: d.id, zoom: nodeOf(d.id).crop.zoom, px: d.npx, py: d.npy }); return; }
    if (d.moved && d.pos) await op("updateStyles", { updates: [{ nodeIds: [d.id], styles: { "object-position": d.pos } }] });
    return;
  }
  if (d.kind === "artboard" && d.moved) await op("moveArtboard", { nodeId: d.id, x: d.nx, y: d.ny });
  else if (d.kind === "move" && d.moved && d.final) {
    // the pins (neighbours + the moved layers) and the final spots go to the server as one undo step
    drawOverlay();
    try { await op("updateStyles", { updates: [...(d.pins || []), ...d.final] }); } catch (err) { toast(err.message); }
    if (pendingRefresh) { pendingRefresh = false; refresh(); }
  } else if (d.kind === "resize" && d.moved && d.styles) {
    try { await op("updateStyles", { updates: [...(d.pins || []), { nodeIds: [d.id], styles: d.styles }] }); } catch (err) { toast(err.message); }
    if (pendingRefresh) { pendingRefresh = false; refresh(); }
  }
});
async function finishDraw(d) {
  setTool("select");
  drawOverlay();
  const b = d.moved && d.box ? d.box : { x0: d.sx, y0: d.sy, x1: d.sx, y1: d.sy };
  const par = d.parentEl, pr = par.getBoundingClientRect(), pcs = getComputedStyle(par), z = view.z;
  const left = Math.round((b.x0 - pr.left) / z - (parseFloat(pcs.borderLeftWidth) || 0)), top = Math.round((b.y0 - pr.top) / z - (parseFloat(pcs.borderTopWidth) || 0));
  let w = Math.round((b.x1 - b.x0) / z), h = Math.round((b.y1 - b.y0) / z);
  const dragged = d.moved && w >= 6 && h >= 6;
  if (!dragged) { w = d.tool === "frame" ? 280 : 120; h = d.tool === "frame" ? 180 : 120; }
  const pos = `position:absolute;left:${left}px;top:${top}px;`;
  const size = `width:${w}px;height:${h}px;`;
  const html = {
    rect: `<div layer-name="Rectangle" style="${pos}${size}background-color:#d9d9d9"></div>`,
    ellipse: `<div layer-name="Ellipse" style="${pos}${size}background-color:#d9d9d9;border-radius:50%"></div>`,
    frame: `<div layer-name="Frame" style="${pos}${size}display:flex;flex-direction:column;gap:12px;padding:16px;background-color:#f3f3f0"></div>`,
    text: `<span layer-name="Text" style="${pos}${dragged ? `width:${w}px;` : "white-space:nowrap;"}font-family:'Inter Tight',sans-serif;font-size:24px;line-height:1.2;color:#111111">Text</span>`,
  }[d.tool];
  try {
    if (pcs.position === "static") await op("updateStyles", { updates: [{ nodeIds: [d.parentId], styles: { position: "relative" } }] });
    const r = await op("insert", { parentId: d.parentId, html });
    select([r[0].id]);
    if (d.tool === "text") setTimeout(() => { startEdit(r[0].id); const el = elFor(r[0].id); if (el) getSelection().selectAllChildren(el); }, 120);
  } catch {}
}
// the browser can cancel a pointer (e.g. it starts its own drag): end ours cleanly instead of freezing mid-move
viewport.addEventListener("pointercancel", () => {
  const d = drag; drag = null;
  viewport.classList.remove("panning");
  if (d && d.kind === "reorder") reorderEnd(d, true);
  if (d && d.moved && (d.kind === "move" || d.kind === "resize" || d.kind === "artboard" || d.kind === "rotate")) refresh();
  drawOverlay();
});
viewport.addEventListener("dragstart", (e) => e.preventDefault());
viewport.addEventListener("pointerleave", () => { if (hoverId) { hoverId = null; drawOverlay(); } });
viewport.addEventListener("dblclick", (e) => {
  // pointer capture retargets events to the viewport, so hit-test by position
  if (pen && pen.editing() && pen.vecDouble(e)) return;
  if (tool === "pen") return;
  const hit = document.elementFromPoint(e.clientX, e.clientY);
  const title = hit && hit.closest(".ab-title");
  if (title) return renameArtboard(title.dataset.title);
  const t = hit && world.contains(hit) && hit.closest("[data-id]");
  if (!t) return;
  let id = pickFrom(t);
  const g = nodeOf(id);
  if (g && g.crop) { startCrop(id); return; }
  // double-click on a group goes inside it: the layer under the cursor gets selected (and edited, if it is text)
  if (g && t.dataset.id !== id && elFor(id)?.dataset.group) { entered.add(id); id = pickFrom(t); select([id]); }
  const n = nodeOf(id);
  if (!n) return;
  if (n.tag === "svg") { pen.editVector(id); return; }
  if (n.tag === "img") { if (cropping && cropping.id === id) endCrop(); else startCrop(id); return; }
  if (isTextLeaf(n)) startEdit(id);
});
viewport.addEventListener("click", (e) => { if (e.target.closest("a")) e.preventDefault(); });

function startEdit(id) {
  const el = elFor(id);
  if (!el) return;
  const rich = !!nodeOf(id).children.some((c) => c.tag !== "#text");
  editing = { id, el, original: el.textContent, rich, originalHtml: el.innerHTML };
  el.contentEditable = rich ? "true" : "plaintext-only";
  el.addEventListener("paste", (e) => { e.preventDefault(); document.execCommand("insertText", false, e.clipboardData.getData("text/plain")); });
  el.style.outline = "none";
  el.focus();
  const range = document.createRange(); range.selectNodeContents(el);
  const s = getSelection(); s.removeAllRanges(); s.addRange(range);
  el.addEventListener("keydown", editKeys);
  el.addEventListener("blur", () => finishEdit(true), { once: true });
}
function editKeys(e) {
  if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); finishEdit(true); }
  if (e.key === "Escape") { e.preventDefault(); finishEdit(false); }
  e.stopPropagation();
}
async function finishEdit(commit) {
  if (!editing) return;
  const { id, el, original, rich, originalHtml } = editing;
  editing = null;
  el.removeEventListener("keydown", editKeys);
  el.contentEditable = "false";
  if (rich) {
    const html = el.innerHTML;
    if (commit && html !== originalHtml && el.textContent.trim()) await op("setInner", { nodeId: id, html });
    else { el.innerHTML = originalHtml; refresh(); }
    return;
  }
  const text = el.textContent.replace(/\s+/g, " ").trim();
  if (commit && text !== original && text) await op("setText", { nodeId: id, text });
  else { el.textContent = original; refresh(); }
}
function renameArtboard(id) {
  const t = titleEls.get(id);
  if (!t) return;
  const input = document.createElement("input");
  input.value = nodeOf(id).name || "";
  t.textContent = ""; t.appendChild(input);
  input.focus(); input.select();
  let done = false;
  const finish = (ok) => { if (done) return; done = true; const v = input.value.trim(); input.remove(); if (ok && v) op("rename", { items: [{ nodeId: id, name: v }] }); else drawOverlay(); };
  input.addEventListener("keydown", (e) => { e.stopPropagation(); if (e.key === "Enter") finish(true); if (e.key === "Escape") finish(false); });
  input.addEventListener("blur", () => finish(true));
  input.addEventListener("pointerdown", (e) => e.stopPropagation());
}

// ---------- keyboard ----------
// layer order: later siblings paint on top (the Layers panel lists the front-most layer first, like Figma)
async function reorder(kind) {
  const ids = selection.filter((id) => find(id) && !nodeOf(id).artboard);
  if (!ids.length) return;
  try { if (!(await op("reorder", { nodeIds: ids, to: kind }))) toast({ front: "Already in front", forward: "Already in front", back: "Already at the back", backward: "Already at the back" }[kind]); }
  catch (e) { toast(e.message); }
}
addEventListener("keydown", (e) => {
  if (!$("#preview").hidden) { if (e.key === "Escape") closePreview(); return; }
  if (!$("#home").hidden || document.querySelector("#present")) return;
  if (!$("#ctx").hidden && e.key === "Escape") return closeMenus();
  const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement.tagName) || editing;
  if (e.code === "Space" && !typing) { spaceDown = true; e.preventDefault(); }
  if (e.key === "Alt" && !altDown) { altDown = true; drawOverlay(); }
  if (typing) return;
  const mod = e.metaKey || e.ctrlKey;
  if (pen && pen.onKey(e)) return;
  const toolKey = !mod && !e.altKey && { v: "select", r: "rect", o: "ellipse", t: "text", f: "frame", p: "pen" }[e.key.toLowerCase()];
  if (toolKey) { e.preventDefault(); return setTool(toolKey); }
  if (mod && (e.code === "BracketRight" || e.code === "BracketLeft") && selection.length) {
    // layer order: ⌘] forward, ⌘[ backward, with Shift to the very front / back (Shift changes e.key, so go by the key's position)
    e.preventDefault();
    reorder(e.code === "BracketRight" ? (e.shiftKey ? "front" : "forward") : e.shiftKey ? "back" : "backward");
    return;
  }
  if (mod && e.shiftKey && e.key.toLowerCase() === "h") { e.preventDefault(); return goHome(); }
  if (mod && e.shiftKey && e.key.toLowerCase() === "r") { e.preventDefault(); return guides.setRulers(!guides.rulersOn()); }
  if (mod && e.shiftKey && e.key.toLowerCase() === "e") { e.preventDefault(); return exporter.open(); }
  if (mod && !e.shiftKey && e.key.toLowerCase() === "k") { e.preventDefault(); return ask.open(); }
  if (mod && (e.key === "\\" || e.code === "Backslash")) { e.preventDefault(); return toggleAllPanels(); }
  if (mod && e.altKey && e.code === "KeyE") { e.preventDefault(); return openPreview(); }
  if (!mod && !e.altKey && e.key.toLowerCase() === "i") { e.preventDefault(); return $("#btn-add-image").click(); }
  if (mod && e.key.toLowerCase() === "z") { e.preventDefault(); op(e.shiftKey ? "redo" : "undo"); }
  else if (mod && e.key.toLowerCase() === "d") { e.preventDefault(); if (selection.length) op("duplicate", { nodeIds: selection }).then((r) => select(r.map((x) => x.id))); }
  else if (mod && e.key.toLowerCase() === "g") { e.preventDefault(); if (e.shiftKey) ungroupSel(); else groupSel(); }
  else if (mod && e.key === "0") { e.preventDefault(); fit(); }
  else if (mod && (e.key === "=" || e.key === "+")) { e.preventDefault(); const r = viewport.getBoundingClientRect(); zoomAt(r.width / 2, r.height / 2, view.z * 1.25); }
  else if (mod && e.key === "-") { e.preventDefault(); const r = viewport.getBoundingClientRect(); zoomAt(r.width / 2, r.height / 2, view.z / 1.25); }
  else if (e.key === "Delete" || e.key === "Backspace") { if (selection.length) { e.preventDefault(); op("remove", { nodeIds: selection }); } }
  else if (cropping && (e.key === "Escape" || e.key === "Enter")) { e.preventDefault(); endCrop(); }
  else if (e.key === "Escape") { if (tool !== "select") setTool("select"); else select([]); }
  else if (e.key === "Enter" && selection.length === 1) { const n = nodeOf(selection[0]); if (n && isTextLeaf(n)) { e.preventDefault(); startEdit(n.id); } else if (n && n.tag === "svg") { e.preventDefault(); pen.editVector(n.id); } else if (n && n.crop) { e.preventDefault(); startCrop(n.id); } }
  else if (e.key === "ArrowUp" && e.altKey && selection.length) { const r = find(selection[0]); if (r && r.parent) select([r.parent.id]); }
  else if (e.key.startsWith("Arrow") && selection.length) {
    const step = e.shiftKey ? 10 : 1, dx = { ArrowLeft: -step, ArrowRight: step }[e.key] || 0, dy = { ArrowUp: -step, ArrowDown: step }[e.key] || 0;
    let ids = selection.filter((id) => nodeOf(id) && !nodeOf(id).artboard && elFor(id));
    if (ids.some(inAuto)) { ids = ids.filter((id) => !inAuto(id)); toast("Layers in an auto-layout frame are positioned by the frame (gap, padding, alignment)."); }
    for (const id of selection) { const n = nodeOf(id); if (n && n.artboard) { op("moveArtboard", { nodeId: id, x: n.x + dx, y: n.y + dy }); e.preventDefault(); } }
    if (!ids.length) return;
    e.preventDefault();
    const plan = pinPlan(ids.filter((id) => !["absolute", "fixed"].includes(getComputedStyle(elFor(id)).position)));
    const ups = [...plan.updates];
    for (const id of ids) {
      const p = plan.pos.get(id);
      if (p) ups.push({ nodeIds: [id], styles: { left: p.left + dx + "px", top: p.top + dy + "px" } });
      else {
        // only the axis that moved: two quick key presses must not overwrite each other with stale values
        const st = absMove(absStart(nodeOf(id), elFor(id)), dx, dy);
        if (!dx) { delete st.left; delete st.right; }
        if (!dy) { delete st.top; delete st.bottom; }
        ups.push({ nodeIds: [id], styles: st });
      }
    }
    op("updateStyles", { updates: ups });
  }
});
addEventListener("keyup", (e) => { if (e.code === "Space") spaceDown = false; if (e.key === "Alt") { altDown = false; drawOverlay(); } });
addEventListener("blur", () => { altDown = false; spaceDown = false; });

// ---------- tools and move mode ----------
function setTool(t) {
  if (tool === "pen" && t !== "pen" && pen) pen.cancel();
  if (t === "pen" && pen && pen.editing()) pen.exitEdit();
  tool = t;
  document.querySelectorAll("[data-tool]").forEach((b) => b.classList.toggle("on", b.dataset.tool === t));
  viewport.style.cursor = t === "select" ? "" : "crosshair";
}
document.querySelectorAll("[data-tool]").forEach((b) => (b.onclick = () => setTool(tool === b.dataset.tool && tool !== "select" ? "select" : b.dataset.tool)));
function setSnap(on) {
  snapOn = on;
  try { localStorage.setItem("studio-snap", on ? "on" : "off"); } catch {}
  const b = $("#btn-snap"); if (b) b.classList.toggle("on", on);
}
$("#btn-snap").onclick = () => setSnap(!snapOn);
setTool("select"); setSnap(snapOn);

// align the selection to its parent (one element) or to each other (several); distribute needs three
async function alignSel(kind) {
  const items = selection.map((id) => ({ id, n: nodeOf(id), el: elFor(id) })).filter((it) => it.n && it.el && !it.n.artboard);
  if (!items.length) return;
  if (items.some((it) => inAuto(it.id))) return toast("These layers sit in an auto-layout frame: use its gap, padding and alignment to position them.");
  const z = view.z;
  for (const it of items) it.r = it.el.getBoundingClientRect();
  const dist = kind === "distH" || kind === "distV";
  let ref;
  if (items.length === 1 && !dist) { const pr = items[0].el.parentElement.getBoundingClientRect(); ref = { l: pr.left, t: pr.top, r: pr.right, b: pr.bottom }; }
  else ref = { l: Math.min(...items.map((i) => i.r.left)), t: Math.min(...items.map((i) => i.r.top)), r: Math.max(...items.map((i) => i.r.right)), b: Math.max(...items.map((i) => i.r.bottom)) };
  const move = new Map();
  if (dist) {
    if (items.length < 3) return toast("Select three or more elements to distribute.");
    const h = kind === "distH", key = h ? "left" : "top", size = h ? "width" : "height";
    const sorted = [...items].sort((a, b) => a.r[key] - b.r[key]);
    const span = h ? ref.r - ref.l : ref.b - ref.t, total = sorted.reduce((t, i) => t + i.r[size], 0), gap = (span - total) / (sorted.length - 1);
    let cur = h ? ref.l : ref.t;
    for (const it of sorted) { move.set(it, h ? [cur - it.r.left, 0] : [0, cur - it.r.top]); cur += it.r[size] + gap; }
  } else for (const it of items) {
    const r = it.r;
    move.set(it, {
      left: [ref.l - r.left, 0], hcenter: [(ref.l + ref.r) / 2 - (r.left + r.right) / 2, 0], right: [ref.r - r.right, 0],
      top: [0, ref.t - r.top], vcenter: [0, (ref.t + ref.b) / 2 - (r.top + r.bottom) / 2], bottom: [0, ref.b - r.bottom],
    }[kind]);
  }
  const moving = [...move].filter(([, [dx, dy]]) => Math.abs(dx) >= 0.5 || Math.abs(dy) >= 0.5);
  if (!moving.length) return;
  const isAbs = (it) => ["absolute", "fixed"].includes(getComputedStyle(it.el).position);
  const plan = pinPlan(moving.filter(([it]) => !isAbs(it)).map(([it]) => it.id));
  const ups = [...plan.updates];
  for (const [it, [dx, dy]] of moving) {
    const p = plan.pos.get(it.id);
    if (p) ups.push({ nodeIds: [it.id], styles: { left: Math.round(p.left + dx / z) + "px", top: Math.round(p.top + dy / z) + "px" } });
    else ups.push({ nodeIds: [it.id], styles: absMove(absStart(it.n, it.el), dx / z, dy / z) });
  }
  await op("updateStyles", { updates: ups });
}
const AI = (body) => `<svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.3">${body}</svg>`;
const ALIGN_BTNS = [
  ["left", "Align left", AI('<path d="M2 1v14"/><rect x="4" y="3" width="10" height="4"/><rect x="4" y="9" width="6" height="4"/>')],
  ["hcenter", "Center horizontally", AI('<path d="M8 1v14"/><rect x="2" y="3" width="12" height="4"/><rect x="4" y="9" width="8" height="4"/>')],
  ["right", "Align right", AI('<path d="M14 1v14"/><rect x="2" y="3" width="10" height="4"/><rect x="6" y="9" width="6" height="4"/>')],
  ["top", "Align top", AI('<path d="M1 2h14"/><rect x="3" y="4" width="4" height="10"/><rect x="9" y="4" width="4" height="6"/>')],
  ["vcenter", "Center vertically", AI('<path d="M1 8h14"/><rect x="3" y="2" width="4" height="12"/><rect x="9" y="4" width="4" height="8"/>')],
  ["bottom", "Align bottom", AI('<path d="M1 14h14"/><rect x="3" y="2" width="4" height="10"/><rect x="9" y="6" width="4" height="6"/>')],
  ["distH", "Distribute horizontally", AI('<path d="M2 1v14M14 1v14"/><rect x="6" y="3" width="4" height="10"/>')],
  ["distV", "Distribute vertically", AI('<path d="M1 2h14M1 14h14"/><rect x="3" y="6" width="10" height="4"/>')],
];

// ---------- images ----------
async function upload(file) {
  const r = await fetch("/api/upload?name=" + encodeURIComponent(file.name || "image.png"), { method: "POST", body: file });
  const j = await r.json();
  if (!r.ok) throw new Error(j.error);
  return j.src;
}
function pickImage(cb) {
  const f = $("#file");
  f.value = "";
  f.onchange = async () => { if (f.files[0]) cb(await upload(f.files[0])); };
  f.click();
}
function insertTarget() {
  const id = selection[0];
  if (id) {
    const n = nodeOf(id);
    if (n && isContainer(n)) return id;
    const r = find(id);
    if (r && r.parent) return r.parent.id;
  }
  return state.artboards.length ? state.artboards[state.artboards.length - 1].id : null;
}
async function insertHtml(html) {
  const t = insertTarget();
  if (!t) return toast("Create an artboard first.");
  const r = await op("insert", { parentId: t, html });
  select(r.map((x) => x.id));
}
async function addImageFile(file) {
  const src = await upload(file);
  await insertHtml(`<img src="${src}" style="width:100%;height:auto;display:block">`);
}
addEventListener("paste", (e) => {
  if (/^(INPUT|TEXTAREA)$/.test(document.activeElement.tagName) || editing) return;
  clearTimeout(pasteFallback);
  const txt = e.clipboardData?.getData("text/plain") || "";
  if (txt.startsWith(CLIP_MARK)) {
    e.preventDefault();
    const key = txt.slice(CLIP_MARK.length, txt.indexOf("-->"));
    if (clip && clip.key === key) pasteNodes(clip.nodes, clip.parents);
    else { const t = insertTarget(); if (t) op("insert", { parentId: t, html: txt.slice(txt.indexOf("-->") + 3) }).then((r) => select(r.map((x) => x.id))); }
    return;
  }
  const f = [...(e.clipboardData?.files || [])].find((x) => x.type.startsWith("image/"));
  if (f) { e.preventDefault(); addImageFile(f).catch((err) => toast(err.message)); }
});
viewport.addEventListener("dragover", (e) => e.preventDefault());
async function dropComponent(e, cid) {
  const hit = document.elementFromPoint(e.clientX, e.clientY);
  let el = hit && world.contains(hit) ? hit.closest("[data-id]") : null;
  while (el) { const nn = nodeOf(el.dataset.id); if (nn && isContainer(nn)) break; el = el.parentElement && el.parentElement.closest("[data-id]"); }
  if (!el) return toast("Drop it on an artboard.");
  const pr = el.getBoundingClientRect(), cs = getComputedStyle(el), z = view.z;
  const left = Math.round((e.clientX - pr.left) / z - (parseFloat(cs.borderLeftWidth) || 0)), top = Math.round((e.clientY - pr.top) / z - (parseFloat(cs.borderTopWidth) || 0));
  try {
    if (cs.position === "static") await op("updateStyles", { updates: [{ nodeIds: [el.dataset.id], styles: { position: "relative" } }] });
    const r = await op("createInstance", { componentId: cid, parentId: el.dataset.id, style: { position: "absolute", left: left + "px", top: top + "px" } });
    select([r.id]);
  } catch {}
}
viewport.addEventListener("drop", (e) => {
  const cid = e.dataTransfer && e.dataTransfer.getData("text/studio-component");
  if (cid) { e.preventDefault(); dropComponent(e, cid); return; }
  const f = [...(e.dataTransfer?.files || [])].find((x) => x.type.startsWith("image/"));
  if (f) { e.preventDefault(); addImageFile(f).catch((err) => toast(err.message)); }
});

// ---------- image crop: the box is the crop, drag the picture inside it ----------
let cropping = null;
async function startCrop(id) {
  const n = nodeOf(id), el = elFor(id);
  if (!n || !el) return;
  select([id]);
  if (n.crop) { cropping = { id }; viewport.classList.add("cropping"); toast("Drag the picture to slide it inside the frame · ⌘ + scroll zooms it · Enter or Esc to finish."); drawOverlay(); renderInspector(); return; }
  const st = {};
  if (n.style["object-fit"] !== "cover") st["object-fit"] = "cover";
  if (!n.style.height || n.style.height === "auto") st.height = el.offsetHeight + "px";
  if (Object.keys(st).length) await op("updateStyles", { updates: [{ nodeIds: [id], styles: st }] });
  cropping = { id };
  viewport.classList.add("cropping");
  toast("Crop: drag the image to reposition it, drag the edges to change the crop. Enter or Esc to finish.");
  drawOverlay();
}
let cropZoomTimer;
function cropZoomBy(f) {
  const n = nodeOf(cropping.id), el = elFor(cropping.id); if (!n || !el) return;
  const cur = n.crop ? n.crop.zoom : 1, zoom = Math.max(1, Math.min(8, cur * f));
  clearTimeout(cropZoomTimer);
  cropZoomTimer = setTimeout(() => setCropZoom(cropping.id, zoom), 120);
  const tag = document.querySelector(".sel-tag"); if (tag) tag.textContent = Math.round(zoom * 100) + "%";
}
// zoom the picture of an image / crop frame (the picture becomes a clipping frame when it is zoomed in)
async function setCropZoom(id, zoom) {
  const n = nodeOf(id), el = elFor(id); if (!n || !el) return;
  try {
    if (n.crop) await op("cropImage", { nodeId: id, zoom, px: n.crop.px, py: n.crop.py });
    else {
      if (zoom <= 1.0001) return;
      const pos = (getComputedStyle(el).objectPosition || "50% 50%").split(" ").map((v) => parseFloat(v));
      await op("cropImage", { nodeId: id, zoom, px: isNaN(pos[0]) ? 50 : pos[0], py: isNaN(pos[1]) ? 50 : pos[1], nw: el.naturalWidth || 1, nh: el.naturalHeight || 1, w: el.offsetWidth, h: el.offsetHeight });
    }
  } catch {}
}
function endCrop() { cropping = null; viewport.classList.remove("cropping"); drawOverlay(); }
function cropPan(e) {
  if (drag.frame) {
    // slide the picture inside its frame: left/top follow the pointer, px/py (0..100) are what is saved
    const { pic, W, H, iw, ih, px0, py0 } = drag, z = view.z;
    const dx = (e.clientX - drag.sx) / z, dy = (e.clientY - drag.sy) / z;
    const ox = W - iw, oy = H - ih;
    const left0 = ox * (px0 / 100), top0 = oy * (py0 / 100);
    const left = Math.max(Math.min(ox, 0), Math.min(0, left0 + dx)), top = Math.max(Math.min(oy, 0), Math.min(0, top0 + dy));
    drag.npx = ox ? Math.round((left / ox) * 1000) / 10 : 50; drag.npy = oy ? Math.round((top / oy) * 1000) / 10 : 50;
    pic.style.left = left + "px"; pic.style.top = top + "px";
    return;
  }
  const { el, nw, nh, w, h, px0, py0 } = drag;
  const k = Math.max(w / nw, h / nh), ox = nw * k - w, oy = nh * k - h;
  const z = view.z, dx = (e.clientX - drag.sx) / z, dy = (e.clientY - drag.sy) / z;
  const px = ox > 0 ? Math.max(0, Math.min(100, px0 - (dx / ox) * 100)) : 50, py = oy > 0 ? Math.max(0, Math.min(100, py0 - (dy / oy) * 100)) : 50;
  drag.pos = `${Math.round(px * 10) / 10}% ${Math.round(py * 10) / 10}%`;
  el.style.objectPosition = drag.pos;
}

// ---------- copy / paste of elements ----------
const VOID = new Set(["img", "br", "hr", "input"]);
const escA = (v) => String(v).replace(/&/g, "&amp;").replace(/"/g, "&quot;");
const escT = (v) => String(v).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
function nodeHtml(n) {
  if (n.tag === "#text") return escT(n.text);
  if (n.tag === "svg") return n.raw;
  let a = Object.entries(n.attrs || {}).map(([k, v]) => ` ${k}="${escA(v)}"`).join("");
  if (n.name) a += ` layer-name="${escA(n.name)}"`;
  const st = Object.entries(n.style || {}).map(([k, v]) => `${k}:${v}`).join(";");
  if (st) a += ` style="${escA(st)}"`;
  return VOID.has(n.tag) ? `<${n.tag}${a}>` : `<${n.tag}${a}>${(n.children || []).map(nodeHtml).join("")}</${n.tag}>`;
}
let clip = null; // { key, nodes, parents }
const CLIP_MARK = "<!--studio-clip:";
let lastCopy = 0;
function copyLayers(dt) {
  const nodes = selection.map((id) => nodeOf(id)).filter((n) => n && !n.artboard);
  if (!nodes.length) return false;
  const fresh = Date.now() - lastCopy > 300;
  if (fresh || !clip) clip = { key: Math.random().toString(36).slice(2), nodes: JSON.parse(JSON.stringify(nodes)), parents: selection.map((id) => find(id)?.parent?.id) };
  const text = CLIP_MARK + clip.key + "-->" + nodes.map(nodeHtml).join("");
  if (dt) { dt.setData("text/plain", text); dt.setData("text/html", nodes.map(nodeHtml).join("")); }
  else navigator.clipboard?.writeText(text).catch(() => {});
  if (fresh) toast(`Copied ${nodes.length} layer${nodes.length > 1 ? "s" : ""}`);
  lastCopy = Date.now();
  return true;
}
const typingNow = () => /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement.tagName) || editing || !$("#home").hidden;
addEventListener("copy", (e) => {
  if (typingNow() || (getSelection().toString() && !selection.length)) return;
  if (copyLayers(e.clipboardData)) e.preventDefault();
});
// ⌘C / ⌘V straight from the keyboard too: WebKit only sends copy/paste events when something editable has focus
let pasteFallback = null;
addEventListener("keydown", (e) => {
  if (!(e.metaKey || e.ctrlKey) || typingNow()) return;
  const k = e.key.toLowerCase();
  if (k === "c" && selection.length) copyLayers(null);
  if (k === "v" && clip) { clearTimeout(pasteFallback); pasteFallback = setTimeout(() => pasteNodes(clip.nodes, clip.parents), 80); }
});
async function pasteNodes(nodes, parents) {
  let target = insertTarget();
  if (selection.length && clip && clip.nodes.some((n) => n.id === selection[0])) target = find(selection[0])?.parent?.id || target;
  if (!target) return toast("Create an artboard first.");
  // pasted into the same frame: nudge absolute layers so the copy is visible
  const html = nodes.map((n, i) => {
    const c = JSON.parse(JSON.stringify(n));
    if (parents && parents[i] === target && c.style && c.style.position === "absolute") {
      if (c.style.left) c.style.left = parseFloat(c.style.left) + 20 + "px";
      if (c.style.top) c.style.top = parseFloat(c.style.top) + 20 + "px";
    }
    return nodeHtml(c);
  }).join("");
  const r = await op("insert", { parentId: target, html });
  select(r.map((x) => x.id));
}

// ---------- present: artboards as full-screen slides ----------
function present() {
  if (!state.artboards.length) return toast("No artboard yet.");
  const order = [...state.artboards].sort((a, b) => a.y - b.y || a.x - b.x);
  const start = selection.length ? order.findIndex((a) => a.id === artboardOf(selection[0])?.id) : 0;
  let i = Math.max(0, start);
  const box = document.createElement("div"); box.id = "present";
  box.innerHTML = `<div class="stage"></div><div class="pbar"><button data-p="prev">←</button><span class="pc"></span><button data-p="next">→</button><button data-p="close">Esc</button></div>`;
  document.body.appendChild(box);
  const stage = box.querySelector(".stage");
  const show = () => {
    const ab = order[i], src = elFor(ab.id);
    stage.textContent = "";
    const c = src.cloneNode(true);
    c.removeAttribute("data-id"); c.querySelectorAll("[data-id]").forEach((x) => x.removeAttribute("data-id"));
    const w = src.offsetWidth, h = src.offsetHeight, k = Math.min(innerWidth / w, (innerHeight - 50) / h);
    Object.assign(c.style, { transform: `scale(${k})`, transformOrigin: "0 0", position: "absolute", left: (innerWidth - w * k) / 2 + "px", top: (innerHeight - 50 - h * k) / 2 + "px", boxShadow: "none" });
    stage.appendChild(c);
    box.querySelector(".pc").textContent = `${i + 1} / ${order.length} · ${ab.name || "Artboard"}`;
  };
  const go = (d) => { i = Math.max(0, Math.min(order.length - 1, i + d)); show(); };
  const close = () => { box.remove(); removeEventListener("keydown", keys, true); removeEventListener("resize", show); if (document.fullscreenElement) document.exitFullscreen().catch(() => {}); };
  const keys = (e) => {
    e.stopPropagation(); e.preventDefault();
    if (e.key === "Escape") close();
    else if (["ArrowRight", "ArrowDown", " ", "PageDown", "Enter"].includes(e.key)) go(1);
    else if (["ArrowLeft", "ArrowUp", "PageUp", "Backspace"].includes(e.key)) go(-1);
  };
  box.querySelector(".pbar").onclick = (e) => { const p = e.target.dataset.p; if (p === "prev") go(-1); if (p === "next") go(1); if (p === "close") close(); };
  stage.onclick = () => go(1);
  addEventListener("keydown", keys, true);
  addEventListener("resize", show);
  box.requestFullscreen?.().catch(() => {});
  show();
}

// ---------- artboard presets ----------
const PRESETS = [
  ["Email", [["Email", 600, ""]]],
  ["Social", [["Instagram post", 1080, 1080], ["Instagram portrait", 1080, 1350], ["Instagram story / Reel", 1080, 1920], ["TikTok", 1080, 1920], ["Facebook post", 1200, 630], ["LinkedIn post", 1200, 627], ["X post", 1600, 900], ["YouTube thumbnail", 1280, 720], ["Pinterest pin", 1000, 1500]]],
  ["Ads", [["Medium rectangle", 300, 250], ["Leaderboard", 728, 90], ["Half page", 300, 600], ["Wide skyscraper", 160, 600], ["Billboard", 970, 250], ["Mobile banner", 320, 50], ["Large mobile banner", 320, 100]]],
  ["Presentation", [["Slide 16:9", 1920, 1080], ["Slide 4:3", 1024, 768]]],
  ["Web & app", [["Desktop", 1440, 900], ["Laptop", 1280, 800], ["Tablet", 768, 1024], ["Mobile", 390, 844]]],
  ["Print", [["A4", 794, 1123], ["US Letter", 816, 1056], ["Business card", 1050, 600], ["Poster 18×24", 1728, 2304]]],
];

// ---------- toolbar ----------
$("#btn-undo").onclick = () => op("undo");
$("#btn-redo").onclick = () => op("redo");
$("#btn-fit").onclick = () => fit();
$("#btn-present").onclick = () => present();
$("#btn-add-image").onclick = () => pickImage(async (src) => insertHtml(`<img src="${src}" style="width:100%;height:auto;display:block">`));
function currentArtboard() {
  if (selection.length) { const a = artboardOf(selection[0]); if (a) return a; }
  return state.artboards[0];
}
$("#btn-html").onclick = () => { const a = currentArtboard(); if (!a) return toast("No artboard yet."); location.href = `/api/export?id=${a.id}`; };
const exportEmail = (fmt, extra = "") => { const a = currentArtboard(); if (!a) return toast("No artboard yet."); location.href = `/api/export?id=${a.id}&format=${fmt}${extra}`; };
$("#btn-email").onclick = () => exportEmail("email");
$("#btn-email-zip").onclick = () => exportEmail("email-zip");
$("#btn-email-eml").onclick = () => exportEmail("eml");
$("#btn-email-copy").onclick = async () => {
  const a = currentArtboard(); if (!a) return toast("No artboard yet.");
  toast("Rendering the email…");
  try {
    const html = await (await fetch(`/api/export?id=${a.id}&format=email&images=files`)).text();
    await navigator.clipboard.writeText(html);
    toast("Copied. Images are referenced as images/…: upload them, or use “Email + images”.");
  } catch (e) { toast("Couldn't copy: " + e.message); }
};
$("#btn-png").onclick = () => {
  const a = currentArtboard(); if (!a) return toast("No artboard yet.");
  const l = document.createElement("a"); l.href = `/api/screenshot?id=${a.id}&scale=2`; l.download = (a.name || "design").replace(/\W+/g, "-").toLowerCase() + ".png"; l.click();
};
$("#btn-add-artboard").onclick = (e) => {
  const presets = PRESETS.flatMap(([g, items]) => items.map((it) => [g, ...it]));
  pop.hidden = false;
  const r = e.currentTarget.getBoundingClientRect();
  pop.style.left = r.left + "px"; pop.style.top = r.bottom + 8 + "px";
  pop.innerHTML = `<div class="f"><label>Name</label><input id="p-name" value="Artboard ${state.artboards.length + 1}"></div>
  <div class="f"><label>Preset</label><select id="p-preset">${PRESETS.map(([g, items]) => `<optgroup label="${g}">${items.map((it) => `<option value="${presets.findIndex((p) => p[0] === g && p[1] === it[0])}">${it[0]} · ${it[1]}${it[2] ? "×" + it[2] : ""}</option>`).join("")}</optgroup>`).join("")}</select></div>
  <div class="row"><div class="f"><label>Width</label><input id="p-w" type="number" value="600"></div><div class="f"><label>Height (empty = grows)</label><input id="p-h" type="number" placeholder="auto"></div></div>
  <div class="row" style="justify-content:flex-end"><button id="p-cancel">Cancel</button><button id="p-ok" class="primary">Create</button></div>`;
  if (r.bottom + pop.offsetHeight + 8 > innerHeight) pop.style.top = Math.max(8, r.top - pop.offsetHeight - 10) + "px";
  pop.style.left = Math.min(r.left, innerWidth - pop.offsetWidth - 8) + "px";
  const name = $("#p-name"); name.focus(); name.select();
  $("#p-preset").onchange = (ev) => { const p = presets[ev.target.value]; $("#p-w").value = p[2]; $("#p-h").value = p[3]; if (/^Artboard \d+$/.test(name.value)) name.value = p[1]; };
  const close = () => (pop.hidden = true);
  $("#p-cancel").onclick = close;
  const ok = async () => {
    const a = { name: name.value.trim() || "Artboard", width: Number($("#p-w").value) || 600 };
    if ($("#p-h").value) a.height = Number($("#p-h").value);
    close();
    const r = await op("createArtboard", a);
    select([r.id]);
    setTimeout(() => fit([r.id]), 60);
  };
  $("#p-ok").onclick = ok;
  pop.onkeydown = (ev) => { if (ev.key === "Enter") ok(); if (ev.key === "Escape") close(); };
};
addEventListener("pointerdown", (e) => {
  if (!pop.hidden && !pop.contains(e.target) && !e.target.closest("#btn-add-artboard") && !e.target.closest(".needs-pop")) pop.hidden = true;
  if (!e.target.closest(".menu") && !e.target.closest("#btn-export") && !e.target.closest("#zoom-label")) closeMenus();
});

// ---------- groups, and splitting a button into its box and its text ----------
const isFlowEl = (el) => !["absolute", "fixed"].includes(getComputedStyle(el).position);
// where a layer sits inside its parent, in canvas units (measured from its centre so rotation is harmless)
function spotIn(el, par) {
  const z = view.z, pr = par.getBoundingClientRect(), pcs = getComputedStyle(par), cs = getComputedStyle(el), r = el.getBoundingClientRect();
  const w = el.offsetWidth, h = el.offsetHeight;
  return {
    left: (r.left + r.width / 2 - pr.left) / z - w / 2 - (parseFloat(pcs.borderLeftWidth) || 0) - (parseFloat(cs.marginLeft) || 0),
    top: (r.top + r.height / 2 - pr.top) / z - h / 2 - (parseFloat(pcs.borderTopWidth) || 0) - (parseFloat(cs.marginTop) || 0), width: w, height: h,
  };
}
async function groupSel() {
  const items = selection.map((id) => ({ id, n: nodeOf(id), el: elFor(id) })).filter((it) => it.n && it.el && !it.n.artboard);
  if (!items.length) return toast("Select layers to group.");
  const par = items[0].el.parentElement;
  if (items.some((it) => it.el.parentElement !== par)) return toast("Select layers that share the same frame to group them.");
  const plan = pinPlan(items.filter((it) => isFlowEl(it.el)).map((it) => it.id));
  const pins = [...plan.updates];
  if (getComputedStyle(par).position === "static" && par.dataset.id && !pins.some((u) => u.nodeIds[0] === par.dataset.id)) pins.unshift({ nodeIds: [par.dataset.id], styles: { position: "relative" } });
  const boxes = items.map((it) => ({ id: it.id, pinned: plan.pos.has(it.id), ...(plan.pos.get(it.id) || spotIn(it.el, par)) }));
  const frame = { left: Math.min(...boxes.map((b) => b.left)), top: Math.min(...boxes.map((b) => b.top)) };
  frame.width = Math.max(...boxes.map((b) => b.left + b.width)) - frame.left; frame.height = Math.max(...boxes.map((b) => b.top + b.height)) - frame.top;
  const members = boxes.map((b) => ({ id: b.id, left: b.left - frame.left, top: b.top - frame.top, ...(b.pinned ? { width: b.width, height: b.height } : {}) }));
  try { select([await op("group", { nodeIds: items.map((it) => it.id), frame, members, pins })]); } catch {}
}
async function ungroupSel() {
  const items = selection.map((id) => ({ id, n: nodeOf(id), el: elFor(id) })).filter((it) => it.n && it.el && !it.n.artboard && (it.n.children || []).some((c) => c.tag !== "#text"));
  if (!items.length) return toast("Select a group or frame to ungroup.");
  const pins = [], members = [];
  for (const it of items) {
    const par = it.el.parentElement;
    pins.push(...pinPlan([it.id]).updates);
    if (getComputedStyle(par).position === "static" && par.dataset.id && !pins.some((u) => u.nodeIds[0] === par.dataset.id)) pins.unshift({ nodeIds: [par.dataset.id], styles: { position: "relative" } });
    for (const c of it.el.children) {
      if (!c.dataset || !c.dataset.id) continue;
      const cn = nodeOf(c.dataset.id), sp = spotIn(c, par), flow = isFlowEl(c);
      members.push({ id: c.dataset.id, left: sp.left, top: sp.top, ...(flow ? (cn && isTextLeaf(cn) ? { width: Math.ceil(sp.width) + 2 } : { width: sp.width, height: sp.height }) : {}) });
    }
  }
  try { const freed = await op("ungroup", { nodeIds: items.map((it) => it.id), members, pins }); select(freed); } catch {}
}
const hasBox = (n) => Object.keys(n.style || {}).some((k) => /^(background|padding|box-shadow)/.test(k) || (/^border/.test(k) && !/radius/.test(k)));
const canSplit = (n) => n && !n.artboard && isTextLeaf(n) && hasBox(n);
async function splitSel() {
  const id = selection.length === 1 ? selection[0] : null, n = id && nodeOf(id), el = id && elFor(id);
  if (!canSplit(n)) return toast("Select a button or text that has its own background to separate its text.");
  try { const t = await op("splitText", { nodeId: id, width: el.offsetWidth, height: el.offsetHeight }); select([t]); toast("The text is its own layer now: drag it or double-click to edit."); } catch {}
}

// ---------- menus: export, zoom, right-click ----------
const ctx = $("#ctx");
function closeMenus() { ctx.hidden = true; $("#export-menu").hidden = true; }
// items: [label, action, { key, disabled, danger }] or "-" for a separator
function openMenu(x, y, items) {
  closeMenus();
  ctx.innerHTML = items.map((it, i) => it === "-" ? `<div class="msep"></div>` : `<button class="mi${it[2]?.danger ? " danger" : ""}" data-i="${i}" ${it[2]?.disabled ? "disabled" : ""}>${it[0]}<span>${it[2]?.key || ""}</span></button>`).join("");
  ctx.hidden = false;
  ctx.style.left = Math.min(x, innerWidth - ctx.offsetWidth - 6) + "px";
  ctx.style.top = Math.min(y, innerHeight - ctx.offsetHeight - 6) + "px";
  ctx.onclick = (e) => { const b = e.target.closest("[data-i]"); if (!b || b.disabled) return; closeMenus(); items[b.dataset.i][1](); };
}
$("#btn-export").onclick = (e) => {
  const m = $("#export-menu"), open = m.hidden;
  closeMenus();
  if (!open) return;
  m.hidden = false;
  const r = e.currentTarget.getBoundingClientRect();
  m.style.top = r.bottom + 6 + "px"; m.style.left = r.right - m.offsetWidth + "px";
};
$("#export-menu").addEventListener("click", () => ($("#export-menu").hidden = true));
$("#zoom-label").onclick = (e) => {
  const r = e.currentTarget.getBoundingClientRect(), vr = viewport.getBoundingClientRect(), cx = vr.width / 2, cy = vr.height / 2;
  openMenu(r.left, r.bottom + 6, [
    ["Zoom in", () => zoomAt(cx, cy, view.z * 1.25), { key: "⌘+" }], ["Zoom out", () => zoomAt(cx, cy, view.z / 1.25), { key: "⌘−" }], ["Zoom to fit", () => fit(), { key: "⌘0" }],
    ["Zoom to selection", () => fit(selection), { disabled: !selection.length }], "-",
    [guides.rulersOn() ? "Hide rulers" : "Show rulers", () => guides.setRulers(!guides.rulersOn()), { key: "⇧⌘R" }],
    ["Clear guides", () => { const a = guides.activeArtboard(); if (a) guides.clearGuides(a.id); }, { disabled: !state.artboards.some((a) => (a.guides || []).length) }], "-",
    ["50%", () => zoomAt(cx, cy, 0.5)], ["100%", () => zoomAt(cx, cy, 1)], ["200%", () => zoomAt(cx, cy, 2)],
  ]);
};
function canvasMenu(x, y, id) {
  const n = id && nodeOf(id);
  if (n && !selection.includes(id)) select([id]);
  if (!n) return openMenu(x, y, [
    ["Paste", () => clip && pasteNodes(clip.nodes, clip.parents), { key: "⌘V", disabled: !clip }],
    ["New artboard…", () => $("#btn-add-artboard").click()], "-",
    ["Zoom to fit", () => fit(), { key: "⌘0" }], ["Present", () => present()],
  ]);
  if (n.artboard) return openMenu(x, y, [
    ["Rename", () => renameArtboard(id)], ["Duplicate", () => op("duplicate", { nodeIds: [id] }).then((r) => select(r.map((x) => x.id))), { key: "⌘D" }],
    ["Paste inside", () => clip && pasteNodes(clip.nodes, clip.parents), { key: "⌘V", disabled: !clip }], "-",
    ["Preview as email…", () => openPreview(id), { key: "⌥⌘E" }],
    ["Export PNG", () => $("#btn-png").click()], ["Download HTML", () => $("#btn-html").click()], ["Present from here", () => present()], "-",
    ["Zoom to artboard", () => fit([id])], "-",
    ["Delete", () => op("remove", { nodeIds: [id] }), { key: "⌫", danger: true }],
  ]);
  const many = selection.length > 1;
  const items = [
    ["Copy", () => copyLayers(null), { key: "⌘C" }],
    ["Paste", () => clip && pasteNodes(clip.nodes, clip.parents), { key: "⌘V", disabled: !clip }],
    ["Duplicate", () => op("duplicate", { nodeIds: selection }).then((r) => select(r.map((x) => x.id))), { key: "⌘D" }],
    ["Delete", () => op("remove", { nodeIds: selection }), { key: "⌫", danger: true }], "-",
  ];
  if (n.tag === "img" && !many) items.push(["Crop image", () => startCrop(id)], ["Replace image…", () => pickImage((src) => op("setAttrs", { nodeId: id, attrs: { src } }))], "-");
  if (isTextLeaf(n) && !many) items.push(["Edit text", () => startEdit(id), { key: "↵" }], "-");
  items.push(
    ["Bring to front", () => reorder("front"), { key: "⇧⌘]" }], ["Bring forward", () => reorder("forward"), { key: "⌘]" }],
    ["Send backward", () => reorder("backward"), { key: "⌘[" }], ["Send to back", () => reorder("back"), { key: "⇧⌘[" }], "-",
    ["Group", () => groupSel(), { key: "⌘G" }],
    ...(!many && n.instanceOf ? [["Go to main component", () => { const cid = n.instanceOf; let main = null; const w = (x) => { if (x.component === cid) main = x; (x.children || []).forEach(w); }; state.artboards.forEach(w); if (main) { select([main.id]); fit([main.id]); } }], ["Detach instance", () => op("detachInstance", { nodeIds: [id] })]] : []),
    ...(!many && !n.component && !n.instanceOf ? [["Create component", () => assets.makeComponent(id)]] : []),
    ["Ungroup", () => ungroupSel(), { key: "⇧⌘G", disabled: !selection.some((sid) => (nodeOf(sid)?.children || []).some((c) => c.tag !== "#text")) }],
    ...(canSplit(n) && !many ? [["Separate text from box", () => splitSel()]] : []),
    [n.hidden ? "Show" : "Hide", () => selection.forEach((sid) => op("setHidden", { nodeId: sid, hidden: !nodeOf(sid).hidden }))],
    ["Rename", () => renameLayer(id), { disabled: many }],
    ["Select parent", () => { const r = find(id); if (r && r.parent) select([r.parent.id]); }, { key: "⌥↑" }],
  );
  openMenu(x, y, items);
}
viewport.addEventListener("contextmenu", (e) => {
  e.preventDefault();
  if (e.target.closest("#toolbar")) return;
  const hit = document.elementFromPoint(e.clientX, e.clientY);
  const title = hit && hit.closest(".ab-title");
  const t = hit && world.contains(hit) ? hit.closest("[data-id]") : null;
  canvasMenu(e.clientX, e.clientY, title ? title.dataset.title : t ? pickFrom(t) : null);
});
layersList.addEventListener("contextmenu", (e) => {
  const row = e.target.closest(".lrow"); if (!row) return;
  e.preventDefault(); canvasMenu(e.clientX, e.clientY, row.dataset.lid);
});
addEventListener("contextmenu", (e) => { if (!e.target.closest("input, textarea, [contenteditable]")) e.preventDefault(); });

// ---------- preview: the email in a mail app, on desktop and on a phone ----------
// Design: your artboard exactly as drawn. Email-safe: the table-based export, i.e. what Gmail and Outlook can really show.
const pv = $("#preview");
let pvMode = "desktop", pvKind = "design", pvId = null, pvWarn = [], pvPlan = { sections: [] }, pvDoc = { design: "", email: null };
try { pvKind = localStorage.getItem("studio-pv-kind") || "design"; pvMode = localStorage.getItem("studio-pv-mode") || "desktop"; } catch {}
function closePreview() { pv.hidden = true; pv.innerHTML = ""; }
const abWidth = () => { const a = nodeOf(pvId); return parseInt(a?.style?.width, 10) || 600; };
async function openPreview(id) {
  if (!state.artboards.length) return toast("No artboard yet.");
  pvId = id || currentArtboard()?.id || state.artboards[0].id;
  pv.hidden = false;
  pv.innerHTML = `
    <div class="pv-top">
      <div class="pv-title">Preview</div>
      <select id="pv-ab" title="Which artboard to preview">${state.artboards.map((a) => `<option value="${a.id}" ${a.id === pvId ? "selected" : ""}>${esc(a.name || "Artboard")}</option>`).join("")}</select>
      <div class="seg small" title="Device"><button data-pvm="desktop">Desktop</button><button data-pvm="mobile">Mobile</button></div>
      <div class="seg small" title="Design: exactly as you drew it. Email-safe: what Gmail and Outlook can show"><button data-pvk="design">Design</button><button data-pvk="email">Email-safe</button></div>
      <div class="spacer"></div>
      <button id="pv-download">Email HTML</button>
      <button id="pv-close" class="primary">Close</button>
    </div>
    <div class="pv-banner" hidden></div>
    <div class="pv-stage"><div class="pv-loading">Rendering…</div></div>`;
  $("#pv-close").onclick = closePreview;
  $("#pv-download").onclick = () => (location.href = `/api/export?id=${pvId}&format=email`);
  $("#pv-ab").onchange = (e) => { pvId = e.target.value; loadPreview(); };
  pv.querySelectorAll("[data-pvm]").forEach((b) => (b.onclick = () => { pvMode = b.dataset.pvm; try { localStorage.setItem("studio-pv-mode", pvMode); } catch {} drawPreview(); }));
  pv.querySelectorAll("[data-pvk]").forEach((b) => (b.onclick = () => { pvKind = b.dataset.pvk; try { localStorage.setItem("studio-pv-kind", pvKind); } catch {} drawPreview(); }));
  await loadPreview();
}
const pvPrep = (html, centre) => html.replace("<head>", `<head><base href="${location.origin}/" target="_blank"><style>${centre ? "html,body{background:transparent!important;margin:0}body{display:flex;justify-content:center}" : ""}html{-webkit-text-size-adjust:100%}</style>`);
async function loadPreview() {
  const stage = pv.querySelector(".pv-stage");
  if (stage) stage.innerHTML = `<div class="pv-loading">Rendering…</div>`;
  const id = pvId;
  pvDoc = { design: "", email: null }; pvPlan = { sections: [] };
  try {
    const [d, plan] = await Promise.all([fetch(`/api/export?id=${id}&embed=0`), fetch(`/api/email-plan?id=${id}`)]);
    if (id !== pvId) return;
    pvDoc.design = pvPrep(await d.text(), true); pvPlan = await plan.json();
  } catch {}
  drawPreview();
}
// the email-safe version is rendered on demand (sections that tables can't express are cut into image slices: a few seconds the first time)
async function loadEmailSafe() {
  const id = pvId;
  try {
    const r = await fetch(`/api/export?id=${id}&format=email`);
    const html = await r.text();
    if (id !== pvId) return;
    pvDoc.email = pvPrep(html, false);
    try { pvWarn = JSON.parse(decodeURIComponent(r.headers.get("x-email-warnings") || "[]")); } catch { pvWarn = []; }
  } catch { pvDoc.email = ""; }
  if (id === pvId) drawPreview();
}
function drawPreview() {
  const stage = pv.querySelector(".pv-stage");
  if (!stage) return;
  pv.querySelectorAll("[data-pvm]").forEach((b) => b.classList.toggle("on", b.dataset.pvm === pvMode));
  pv.querySelectorAll("[data-pvk]").forEach((b) => b.classList.toggle("on", b.dataset.pvk === pvKind));
  // what email apps would do with this design, from a quick analysis (design view) or from the real export (email-safe view)
  const banner = pv.querySelector(".pv-banner");
  const n = pvPlan.sections.length;
  if (pvKind === "email") {
    banner.hidden = false;
    banner.innerHTML = pvDoc.email === null ? `<b>Email-safe view.</b> Rendering image slices for the sections tables can't express…` : `<b>Email-safe view.</b> ${pvWarn.length ? pvWarn.map(esc).join("; ") + "." : "Everything is live email tables and text."} This is what Gmail and Outlook can show.`;
  } else if (n) {
    banner.hidden = false;
    banner.innerHTML = `<b>Design view.</b> Shown exactly as drawn. In the email export, ${n} section${n > 1 ? "s" : ""} (${pvPlan.sections.slice(0, 4).map((x) => esc(x.name)).join(", ")}${n > 4 ? "…" : ""}) can't be built from email tables and will become image slices with working links. Switch to <b>Email-safe</b> to see it.`;
  } else banner.hidden = true;
  const ab = nodeOf(pvId), subject = esc((ab && ab.name) || "Email"), sender = esc((project && project.name) || "Studio");
  const head = `<div class="pv-avatar">${esc(sender.trim()[0] || "S")}</div><div class="pv-meta"><div><b>${sender}</b></div><div class="pv-mut">to me</div></div>`;
  const W = abWidth();
  if (pvMode === "desktop") {
    stage.innerHTML = `
      <div class="pv-desktop">
        <div class="pv-bar"><span class="pv-dots"><i></i><i></i><i></i></span><span class="pv-mut">Inbox</span></div>
        <div class="pv-msg"><h3 class="pv-subject">${subject}</h3><div class="pv-head">${head}<div class="pv-time pv-mut">9:41 AM</div></div></div>
        <div class="pv-mail"><div class="pv-fit"><iframe class="pv-frame" title="Email preview"></iframe></div></div>
      </div>`;
  } else {
    stage.innerHTML = `
      <div class="pv-phone"><div class="pv-screen">
        <div class="pv-status"><span>9:41</span><span class="pv-ind"><b></b><b></b><b></b><u></u></span></div>
        <div class="pv-nav"><span>‹ Inbox</span><span class="pv-mut">•••</span></div>
        <div class="pv-scroll">
          <div class="pv-msg"><div class="pv-head">${head}<div class="pv-time pv-mut">9:41</div></div><h3 class="pv-subject">${subject}</h3></div>
          <div class="pv-fit"><iframe class="pv-frame" title="Email preview"></iframe></div>
        </div>
      </div></div>`;
  }
  const fr = stage.querySelector("iframe"), box = fr.parentElement;
  // the email is laid out at its real width, then scaled to fit the screen it's shown on (phones shrink emails that aren't responsive)
  const fit = () => {
    try {
      const pane = box.clientWidth || (pvMode === "mobile" ? 390 : 760);
      const wide = pvKind === "email" && pvMode === "desktop" ? Math.max(W, Math.min(pane, 700)) : W;
      const k = Math.min(1, pane / wide);
      fr.style.width = wide + "px";
      const h = Math.max(fr.contentDocument.documentElement.scrollHeight, fr.contentDocument.body.scrollHeight);
      fr.style.height = h + "px"; fr.style.transform = `scale(${k})`; box.style.height = Math.ceil(h * k) + "px";
      if (pvMode === "desktop") fr.style.marginLeft = Math.max(0, (pane - wide * k) / 2) + "px";
    } catch {}
  };
  fr.onload = () => { fit(); setTimeout(fit, 400); setTimeout(fit, 1400); setTimeout(fit, 3000); };
  if (pvKind === "email" && pvDoc.email === null) { loadEmailSafe(); fr.srcdoc = "<body style='font:14px sans-serif;color:#888;display:grid;place-items:center;height:240px;margin:0'>Rendering the email…</body>"; return; }
  fr.srcdoc = pvDoc[pvKind] || "<p style='font:14px sans-serif;padding:20px'>Nothing to preview.</p>";
}
$("#btn-preview").onclick = () => openPreview();

// ---------- theme: Auto follows the system, or force Light / Dark ----------
const THEMES = ["auto", "light", "dark"];
let themePref = "auto";
try { themePref = localStorage.getItem("studio-theme") || "auto"; } catch {}
const dark = matchMedia("(prefers-color-scheme: dark)");
function applyTheme() {
  const t = themePref === "auto" ? (dark.matches ? "dark" : "light") : themePref;
  document.documentElement.dataset.theme = t;
  const b = $("#btn-theme");
  if (b) {
    b.title = `Theme: ${themePref[0].toUpperCase() + themePref.slice(1)} (click to change)`;
    b.innerHTML = themePref === "dark" ? `<svg viewBox="0 0 24 24"><path d="M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5z"/></svg>`
      : themePref === "light" ? `<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="4"/><path d="M12 3v2M12 19v2M3 12h2M19 12h2M5.6 5.6L7 7M17 17l1.4 1.4M5.6 18.4L7 17M17 7l1.4-1.4"/></svg>`
      : `<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="8"/><path d="M12 4v16"/><path d="M12 4a8 8 0 0 1 0 16z" fill="currentColor" stroke="none"/></svg>`;
  }
  // the Mac app's window (title bar, background) follows
  try { window.webkit?.messageHandlers?.studioTheme?.postMessage({ pref: themePref, theme: t }); } catch {}
}
function setTheme(t) { themePref = t; try { localStorage.setItem("studio-theme", t); } catch {} applyTheme(); }
$("#btn-theme").onclick = () => setTheme(THEMES[(THEMES.indexOf(themePref) + 1) % THEMES.length]);
dark.addEventListener?.("change", applyTheme);
applyTheme();

// ---------- side panels: drag the edge to resize, collapse to a thin rail, ⌘\ hides everything ----------
const panels = { l: { el: $("#layers"), rz: $("#rz-l"), min: 170, max: 520, def: 250, key: "lw" }, r: { el: $("#inspector-panel"), rz: $("#rz-r"), min: 220, max: 560, def: 280, key: "rw" } };
let panelState = { lw: 250, rw: 280, lc: false, rc: false };
try { Object.assign(panelState, JSON.parse(localStorage.getItem("studio-panels") || "{}")); } catch {}
function applyPanels() {
  const root = document.documentElement.style;
  root.setProperty("--lw", panelState.lw + "px"); root.setProperty("--rw", panelState.rw + "px");
  panels.l.el.classList.toggle("collapsed", !!panelState.lc); panels.r.el.classList.toggle("collapsed", !!panelState.rc);
  panels.l.rz.style.display = panelState.lc ? "none" : ""; panels.r.rz.style.display = panelState.rc ? "none" : "";
  try { localStorage.setItem("studio-panels", JSON.stringify(panelState)); } catch {}
  setTimeout(drawOverlay, 190);
}
function togglePanel(side, force) {
  const k = side + "c"; panelState[k] = force === undefined ? !panelState[k] : force; applyPanels();
}
document.querySelectorAll("[data-collapse]").forEach((b) => (b.onclick = () => togglePanel(b.dataset.collapse)));
for (const [side, P] of Object.entries(panels)) {
  P.rz.addEventListener("dblclick", () => { panelState[P.key] = P.def; applyPanels(); });
  P.rz.addEventListener("pointerdown", (e) => {
    e.preventDefault(); P.rz.setPointerCapture(e.pointerId); P.rz.classList.add("drag"); document.body.classList.add("resizing");
    const x0 = e.clientX, w0 = panelState[P.key];
    const move = (ev) => {
      const w = w0 + (side === "l" ? ev.clientX - x0 : x0 - ev.clientX);
      if (w < P.min - 50) { panelState[side + "c"] = true; } else { panelState[side + "c"] = false; panelState[P.key] = Math.max(P.min, Math.min(P.max, Math.round(w))); }
      document.documentElement.style.setProperty(side === "l" ? "--lw" : "--rw", panelState[P.key] + "px");
      P.el.classList.toggle("collapsed", !!panelState[side + "c"]);
      drawOverlay();
    };
    const up = () => { P.rz.removeEventListener("pointermove", move); P.rz.removeEventListener("pointerup", up); P.rz.classList.remove("drag"); document.body.classList.remove("resizing"); applyPanels(); };
    P.rz.addEventListener("pointermove", move); P.rz.addEventListener("pointerup", up);
  });
}
applyPanels();
function toggleAllPanels() {
  const both = panelState.lc && panelState.rc;
  panelState.lc = panelState.rc = !both; applyPanels();
}
window.studio_panels = toggleAllPanels;

// ---------- project name ----------
$("#proj-name").onclick = () => {
  const el = $("#proj-name"); if (el.querySelector("input") || !project) return;
  const input = document.createElement("input"); input.value = project.name; input.className = "rename";
  el.textContent = ""; el.appendChild(input); input.focus(); input.select();
  let done = false;
  const finish = (ok) => { if (done) return; done = true; const v = input.value.trim(); el.textContent = project.name; if (ok && v && v !== project.name) op("renameProject", { name: v }); };
  input.onkeydown = (ev) => { ev.stopPropagation(); if (ev.key === "Enter") finish(true); if (ev.key === "Escape") finish(false); };
  input.onblur = () => finish(true);
};

// ---------- home: projects and new designs ----------
const NEW_KINDS = [
  ["Blank canvas", null, null],
  ["Instagram post", 1080, 1080], ["Instagram story", 1080, 1920], ["Presentation", 1920, 1080],
  ["Email", 600, null], ["Display ad", 300, 250], ["YouTube thumbnail", 1280, 720], ["A4 poster", 794, 1123],
];
const ago = (t) => { const s = (Date.now() - t) / 1000; if (s < 60) return "just now"; if (s < 3600) return Math.floor(s / 60) + " min ago"; if (s < 86400) return Math.floor(s / 3600) + " h ago"; if (s < 86400 * 30) return Math.floor(s / 86400) + " days ago"; return new Date(t).toLocaleDateString(); };
async function renderHome() {
  const grid = $("#new-grid");
  if (!grid.children.length) {
    grid.innerHTML = NEW_KINDS.map(([name, w, h], i) => {
      const k = w ? Math.min(54 / w, 54 / (h || w * 1.4)) : 0;
      const shape = w ? `<span class="shape" style="width:${Math.round(w * k)}px;height:${Math.round((h || w * 1.4) * k)}px"></span>` : `<span class="shape plus">+</span>`;
      return `<button class="newcard" data-new="${i}"><div class="nthumb">${shape}</div><b>${name}</b><span>${w ? `${w} × ${h || "auto"}` : "Empty project"}</span></button>`;
    }).join("");
    grid.onclick = async (e) => {
      const b = e.target.closest("[data-new]"); if (!b) return;
      const [name, w, h] = NEW_KINDS[b.dataset.new];
      await op("createProject", { name: name === "Blank canvas" ? "Untitled" : name, artboard: w ? { name, width: w, ...(h ? { height: h } : {}) } : null });
      openEditor(true);
    };
  }
  const list = await op("projects");
  const q = $("#home-search").value.trim().toLowerCase();
  const shown = list.filter((p) => !q || p.name.toLowerCase().includes(q));
  $("#proj-grid").innerHTML = shown.map((p) => {
    let thumb = `<div class="empty-thumb">Empty</div>`;
    if (p.cover) {
      const W = 260, H = 170, w = p.cover.width, h = p.cover.height || Math.round(w * 1.3), k = Math.min(W / w, H / h);
      thumb = `<iframe tabindex="-1" loading="lazy" src="/api/projects/${p.id}/preview?v=${Math.round(p.updated)}" style="width:${w}px;height:${h}px;transform:scale(${k});left:calc(50% - ${(w * k) / 2}px);top:${(H - h * k) / 2}px"></iframe>`;
    }
    return `<div class="pcard${p.current ? " current" : ""}" data-pid="${p.id}"><div class="pthumb">${thumb}</div><div class="pmeta"><div><b class="pname">${esc(p.name)}</b><span>Edited ${ago(p.updated)} · ${p.artboards} artboard${p.artboards === 1 ? "" : "s"}</span></div><button class="more" title="More">•••</button></div></div>`;
  }).join("") || `<p class="muted">${q ? "No project matches." : "No projects yet: start one above."}</p>`;
  refreshTrashCount();
}
async function openProjectId(id) { await op("openProject", { id }); openEditor(false); }
function projectMenu(x, y, id) {
  const card = $(`.pcard[data-pid="${id}"]`);
  openMenu(x, y, [
    ["Open", () => openProjectId(id)],
    ["Rename", () => {
      const b = card.querySelector(".pname"), input = document.createElement("input"); input.value = b.textContent; input.className = "rename";
      b.replaceWith(input); input.focus(); input.select();
      let done = false;
      const finish = async (ok) => { if (done) return; done = true; if (ok && input.value.trim()) await op("renameProject", { id, name: input.value.trim() }); renderHome(); };
      input.onkeydown = (ev) => { ev.stopPropagation(); if (ev.key === "Enter") finish(true); if (ev.key === "Escape") finish(false); };
      input.onblur = () => finish(true);
    }],
    ["Duplicate", async () => { await op("duplicateProject", { id }); renderHome(); }], "-",
    ["Move to Trash", () => confirmBox(`Move “${card.querySelector(".pname")?.textContent}” to the trash?`, "Move to Trash", async () => { await op("deleteProject", { id }); renderHome(); }), { danger: true }],
  ]);
}
$("#proj-grid").addEventListener("click", (e) => {
  const card = e.target.closest(".pcard"); if (!card || e.target.closest("input")) return;
  if (e.target.closest(".more")) { const r = e.target.getBoundingClientRect(); return projectMenu(r.left, r.bottom + 4, card.dataset.pid); }
  openProjectId(card.dataset.pid);
});
$("#proj-grid").addEventListener("contextmenu", (e) => { const card = e.target.closest(".pcard"); if (!card) return; e.preventDefault(); projectMenu(e.clientX, e.clientY, card.dataset.pid); });
$("#home-search").addEventListener("input", () => renderHome());
function confirmBox(text, okLabel, onOk) {
  pop.hidden = false;
  pop.innerHTML = `<p style="margin:0 0 4px">${esc(text)}</p><div class="row" style="justify-content:flex-end"><button id="c-no">Cancel</button><button id="c-ok" class="primary danger">${okLabel}</button></div>`;
  pop.style.left = innerWidth / 2 - 135 + "px"; pop.style.top = innerHeight / 3 + "px";
  $("#c-no").onclick = () => (pop.hidden = true);
  $("#c-ok").onclick = () => { pop.hidden = true; onOk(); };
}
// ---- trash: restore, or delete for good (one, several, or all) ----
let trashOpen = false, trashItems = [];
const trashSel = new Set();
function showTrash(on) { trashOpen = on; trashSel.clear(); $("#home-main").hidden = on; $("#trash-view").hidden = !on; $("#home-search").hidden = on; if (on) renderTrash(); else renderHome(); }
async function refreshTrashCount() { const n = (await op("trash")).length; $("#trash-count").textContent = n ? n : ""; }
async function renderTrash() {
  trashItems = await op("trash");
  for (const id of [...trashSel]) if (!trashItems.some((t) => t.entry === id)) trashSel.delete(id);
  $("#trash-grid").innerHTML = trashItems.map((t) => `<div class="pcard tcard${trashSel.has(t.entry) ? " sel" : ""}" data-tid="${esc(t.entry)}"><div class="pthumb"><span class="tick"></span>${t.artboards} artboard${t.artboards === 1 ? "" : "s"}</div><div class="pmeta"><div><b class="pname">${esc(t.name)}</b><span>Deleted ${ago(t.deleted)}</span></div></div></div>`).join("") || `<p class="muted">The trash is empty.</p>`;
  const n = trashSel.size;
  $("#trash-sel").textContent = n ? `${n} selected` : "";
  $("#trash-restore").disabled = $("#trash-delsel").disabled = !n;
  $("#trash-empty").disabled = $("#trash-selall").disabled = !trashItems.length;
  $("#trash-selall").textContent = n && n === trashItems.length ? "Deselect all" : "Select all";
  refreshTrashCount();
}
const plural = (n, w) => `${n} ${w}${n === 1 ? "" : "s"}`;
const nameOf = (entry) => trashItems.find((t) => t.entry === entry)?.name;
$("#btn-trash").onclick = () => showTrash(true);
$("#trash-back").onclick = () => showTrash(false);
$("#trash-grid").addEventListener("click", (e) => {
  const c = e.target.closest(".tcard"); if (!c) return;
  const id = c.dataset.tid; trashSel.has(id) ? trashSel.delete(id) : trashSel.add(id);
  renderTrash();
});
$("#trash-selall").onclick = () => { if (trashSel.size === trashItems.length) trashSel.clear(); else trashItems.forEach((t) => trashSel.add(t.entry)); renderTrash(); };
$("#trash-restore").onclick = async () => { await op("restoreProjects", { ids: [...trashSel] }); trashSel.clear(); renderTrash(); };
$("#trash-delsel").onclick = () => {
  const ids = [...trashSel], what = ids.length === 1 ? `“${nameOf(ids[0])}”` : plural(ids.length, "project");
  confirmBox(`Delete ${what} permanently? This can't be undone.`, "Delete permanently", async () => { await op("purgeProjects", { ids }); trashSel.clear(); renderTrash(); });
};
$("#trash-empty").onclick = () => confirmBox(`Permanently delete everything in the trash (${plural(trashItems.length, "project")})? This can't be undone.`, "Empty Trash", async () => { await op("purgeProjects"); trashSel.clear(); renderTrash(); });
function goHome() { location.hash = "#/"; }
function openEditor(fresh) { if (fresh) try { localStorage.removeItem("studio-view:" + project?.id); } catch {} location.hash = "#/edit"; }
function route() {
  const home = !location.hash.startsWith("#/edit");
  $("#home").hidden = !home;
  document.body.classList.toggle("at-home", home);
  if (home) { closeMenus(); trashOpen ? showTrash(false) : renderHome(); document.title = "Studio"; }
  else { if (project) document.title = project.name + " — Studio"; setTimeout(() => { drawOverlay(); ensureVisible(); }, 30); }
}
addEventListener("hashchange", route);
$("#btn-home").onclick = goHome;
// hooks for the native Mac app's menu bar
window.studio = { panels: () => toggleAllPanels(), theme: () => $("#btn-theme").click(), preview: () => openPreview(), home: goHome, newProject: () => { goHome(); setTimeout(() => $("#new-grid .newcard")?.focus(), 50); }, fit: () => fit(), present: () => present() };
route();

// ---------- layers panel ----------
const ICONS = { div: "▢", img: "▨", svg: "⬡", span: "T", p: "T", a: "↗" };
const iconOf = (n) => (n.group ? "◫" : ICONS[n.tag] || "▢");
function renderLayers(scroll) {
  layersList.textContent = "";
  const walk = (n, depth) => {
    if (n.tag === "#text") return;
    const kids = isTextLeaf(n) || n.crop ? [] : (n.children || []).filter((c) => c.tag !== "#text");
    kids.reverse(); // front-most layer on top, like Figma
    const row = document.createElement("div");
    row.className = "lrow" + (n.artboard ? " art" : "") + (selection.includes(n.id) ? " sel" : "") + (n.hidden ? " off" : "");
    row.dataset.lid = n.id;
    row.draggable = !n.artboard;
    row.style.paddingLeft = 6 + depth * 14 + "px";
    const open = !collapsed.has(n.id);
    row.innerHTML = `<span class="tw">${kids.length ? (open ? "▼" : "▶") : ""}</span><span class="ic">${n.artboard ? "▣" : n.component ? "◆" : n.instanceOf ? "◇" : n.crop ? "▨" : n.group ? "◫" : isTextLeaf(n) ? "T" : ICONS[n.tag] || "▢"}</span><span class="nm"></span><span class="eye" title="Show/hide">${n.hidden ? "○" : "●"}</span>`;
    row.querySelector(".nm").textContent = label(n);
    layersList.appendChild(row);
    if (kids.length && open) kids.forEach((c) => walk(c, depth + 1));
  };
  state.artboards.forEach((a) => walk(a, 0));
  if (scroll && selection[0]) layersList.querySelector(`[data-lid="${selection[0]}"]`)?.scrollIntoView({ block: "nearest" });
}
layersList.addEventListener("click", (e) => {
  const row = e.target.closest(".lrow"); if (!row) return;
  const id = row.dataset.lid;
  if (e.target.classList.contains("tw")) { collapsed.has(id) ? collapsed.delete(id) : collapsed.add(id); return renderLayers(); }
  if (e.target.classList.contains("eye")) return op("setHidden", { nodeId: id, hidden: !nodeOf(id).hidden });
  if (e.shiftKey) select(selection.includes(id) ? selection.filter((s) => s !== id) : [...selection, id], { scroll: false });
  else select([id], { scroll: false });
  const ab = artboardOf(id); const el = elFor(id);
  if (el) { const vr = viewport.getBoundingClientRect(), r = el.getBoundingClientRect(); if (r.bottom < vr.top || r.top > vr.bottom || r.right < vr.left || r.left > vr.right) { view.x += vr.left + vr.width / 2 - (r.left + r.width / 2); view.y += vr.top + vr.height / 2 - (r.top + Math.min(r.height / 2, 200)); applyView(); } }
});
layersList.addEventListener("dblclick", (e) => {
  const row = e.target.closest(".lrow"); if (!row || !e.target.classList.contains("nm")) return;
  renameLayer(row.dataset.lid);
});
function renameLayer(id) {
  const nm = layersList.querySelector(`[data-lid="${id}"] .nm`);
  if (!nm) return;
  const input = document.createElement("input"); input.value = nodeOf(id).name || label(nodeOf(id));
  nm.replaceWith(input); input.focus(); input.select();
  let done = false;
  const finish = (ok) => { if (done) return; done = true; if (ok && input.value.trim()) op("rename", { items: [{ nodeId: id, name: input.value.trim() }] }); else renderLayers(); };
  input.onkeydown = (ev) => { ev.stopPropagation(); if (ev.key === "Enter") finish(true); if (ev.key === "Escape") finish(false); };
  input.onblur = () => finish(true);
}
let dragLayer = null;
layersList.addEventListener("dragstart", (e) => { const row = e.target.closest(".lrow"); if (!row) return; dragLayer = row.dataset.lid; e.dataTransfer.effectAllowed = "move"; e.dataTransfer.setData("text/plain", dragLayer); });
layersList.addEventListener("dragover", (e) => {
  const row = e.target.closest(".lrow"); if (!row || !dragLayer) return;
  e.preventDefault();
  layersList.querySelectorAll(".dt").forEach((x) => x.classList.remove("dt", "before", "after", "inside"));
  const id = row.dataset.lid;
  const r = row.getBoundingClientRect(), y = (e.clientY - r.top) / r.height;
  const n = nodeOf(id);
  const mode = (n.artboard || (isContainer(n) && y > 0.3 && y < 0.7)) ? "inside" : y < 0.5 ? "before" : "after";
  row.classList.add("dt", mode); row.dataset.mode = mode;
});
layersList.addEventListener("dragleave", (e) => { if (!layersList.contains(e.relatedTarget)) layersList.querySelectorAll(".dt").forEach((x) => x.classList.remove("dt", "before", "after", "inside")); });
layersList.addEventListener("drop", async (e) => {
  const row = e.target.closest(".lrow"); if (!row || !dragLayer) return;
  e.preventDefault();
  const id = dragLayer, mode = row.dataset.mode, tid = row.dataset.lid;
  dragLayer = null;
  layersList.querySelectorAll(".dt").forEach((x) => x.classList.remove("dt", "before", "after", "inside"));
  if (id === tid) return;
  try {
    if (mode === "inside") await op("move", { nodeId: id, parentId: tid });
    else {
      const t = find(tid);
      if (!t.parent) return;
      // the panel shows the front-most layer first, so dropping above a row means just after it in the document
      let idx = t.index + (mode === "before" ? 1 : 0);
      const src = find(id);
      if (src.list === t.list && src.index < idx) idx -= 1;
      await op("move", { nodeId: id, parentId: t.parent.id, index: idx });
    }
  } catch {}
});
layersList.addEventListener("dragend", () => { dragLayer = null; });

// ---------- inspector ----------
const FONTS = ["Inter", "Inter Tight", "Funnel Display", "Funnel Sans", "Geist Mono", "Caveat", "DM Sans", "Playfair Display", "Space Grotesk", "Poppins", "Roboto", "Lora", "Manrope", "Bricolage Grotesque", "Instrument Serif", "Fraunces", "Syne", "Archivo", "Work Sans", "Montserrat", "Arial", "Georgia", "Helvetica"];
$("#fonts").innerHTML = FONTS.map((f) => `<option value="${f}">`).join("");
// ---------- fill: solid colour or a linear / radial gradient with draggable stops ----------
function splitTop(s) { const out = []; let d = 0, cur = ""; for (const ch of s) { if (ch === "(") d++; if (ch === ")") d--; if (ch === "," && !d) { out.push(cur.trim()); cur = ""; } else cur += ch; } if (cur.trim()) out.push(cur.trim()); return out; }
function parseGradient(v) {
  const m = /(linear|radial)-gradient\((.*)\)\s*$/i.exec(v || "");
  if (!m) return null;
  const parts = splitTop(m[2]);
  const g = { type: m[1].toLowerCase(), angle: 180, stops: [] };
  if (g.type === "linear" && /deg|turn|^to /.test(parts[0])) { const p = parts.shift(); g.angle = /deg/.test(p) ? parseFloat(p) : /turn/.test(p) ? parseFloat(p) * 360 : { "to top": 0, "to right": 90, "to bottom": 180, "to left": 270, "to top right": 45, "to bottom right": 135, "to bottom left": 225, "to top left": 315 }[p] ?? 180; }
  if (g.type === "radial" && /^(circle|ellipse|closest|farthest|at )/.test(parts[0])) parts.shift();
  parts.forEach((p, i) => { const mm = /^(.*?)(?:\s+(-?[\d.]+)%)?$/.exec(p); g.stops.push({ c: mm[1].trim(), p: mm[2] !== undefined ? parseFloat(mm[2]) : (i / Math.max(1, parts.length - 1)) * 100 }); });
  return g.stops.length >= 2 ? g : null;
}
const gradCss = (g) => `${g.type}-gradient(${g.type === "linear" ? Math.round(g.angle) + "deg" : "circle at center"}, ${[...g.stops].sort((a, b) => a.p - b.p).map((s) => `${s.c} ${Math.round(s.p)}%`).join(", ")})`;
function toHex(c) { const x = document.createElement("canvas").getContext("2d"); x.fillStyle = "#000"; x.fillStyle = c; const v = x.fillStyle; return /^#[0-9a-f]{6}$/i.test(v) ? v : "#000000"; }
let gradState = null;
function fillSection(st, n) {
  const gSrc = [st["background-image"], st.background].find((v) => v && /gradient\(/.test(v));
  const g = parseGradient(gSrc);
  gradState = g;
  const mode = g ? g.type : "solid";
  const solid = st["background-color"] || (!g && st.background && !/url\(/.test(st.background) ? st.background : "") || "";
  let body;
  if (!g) body = `<div class="grid2"><div class="f full"><label>Colour</label><div class="colorrow"><input type="color" data-fillc value="${toHex(solid || "#ffffff")}"><input type="text" data-fillt value="${esc(solid)}" placeholder="none"></div></div></div>`;
  else body = `<div class="gbar" style="background:linear-gradient(90deg, ${[...g.stops].sort((a, b) => a.p - b.p).map((s) => `${s.c} ${s.p}%`).join(", ")})">${g.stops.map((s, i) => `<span class="gstop" data-stop="${i}" style="left:${s.p}%;background:${esc(s.c)}"></span>`).join("")}</div>
    ${g.type === "linear" ? `<div class="grow"><label>Angle</label><input type="range" min="0" max="360" value="${Math.round(g.angle)}" data-gangle><input type="number" value="${Math.round(g.angle)}" data-gangle-n style="width:58px"></div>` : ""}
    ${g.stops.map((s, i) => `<div class="grow"><input type="color" value="${toHex(s.c)}" data-gc="${i}"><input type="text" value="${esc(s.c)}" data-gct="${i}"><input type="number" min="0" max="100" value="${Math.round(s.p)}" data-gp="${i}" style="width:52px"><button data-gdel="${i}" title="Remove stop" ${g.stops.length <= 2 ? "disabled" : ""}>×</button></div>`).join("")}
    <button data-gadd style="width:100%">+ Add stop</button>`;
  return `<div class="sec"><h4>Fill</h4><div class="seg fillmode" style="margin-bottom:8px">${["solid", "linear", "radial"].map((m) => `<button data-fill="${m}" class="${mode === m ? "on" : ""}">${m[0].toUpperCase() + m.slice(1)}</button>`).join("")}</div>${body}${!g && n ? `<div class="grid2" style="margin-top:8px">${styleSelect(ectx, n, "background-color", "Colour style")}</div>` : ""}</div>`;
}
function wireFill(n) {
  const el = () => elFor(n.id);
  const commit = (g) => setStyle({ background: null, "background-image": g ? gradCss(g) : null });
  const live = (g) => { const e = el(); if (e) { e.style.background = ""; e.style.backgroundImage = gradCss(g); } const bar = inspector.querySelector(".gbar"); if (bar) bar.style.background = `linear-gradient(90deg, ${[...g.stops].sort((a, b) => a.p - b.p).map((s) => `${s.c} ${s.p}%`).join(", ")})`; };
  inspector.querySelectorAll("[data-fill]").forEach((b) => (b.onclick = () => {
    const m = b.dataset.fill, st = n.style || {};
    if (m === "solid") { const first = gradState ? gradState.stops[0].c : null; return setStyle({ background: null, "background-image": null, ...(first && !st["background-color"] ? { "background-color": first } : {}) }); }
    const base = gradState || { stops: [{ c: st["background-color"] || "#ff4f1f", p: 0 }, { c: "#7a2cff", p: 100 }], angle: 135 };
    commit({ ...base, type: m });
  }));
  // solid colour: also drop a colour-only background shorthand so the new colour isn't hidden behind it
  const solidSet = (v) => setStyle({ "background-color": v || null, ...(n.style.background && !/url\(|gradient/.test(n.style.background) ? { background: null } : {}) });
  const fc = inspector.querySelector("[data-fillc]"), ft = inspector.querySelector("[data-fillt]");
  if (fc) { let t; fc.oninput = () => { const e = el(); if (e) { e.style.background = ""; e.style.backgroundColor = fc.value; } ft.value = fc.value; clearTimeout(t); t = setTimeout(() => solidSet(fc.value), 150); }; }
  if (ft) { ft.onchange = () => solidSet(ft.value.trim()); ft.onkeydown = (e) => { e.stopPropagation(); if (e.key === "Enter") ft.blur(); }; }
  const g = gradState; if (!g) return;
  const ang = inspector.querySelector("[data-gangle]"), angN = inspector.querySelector("[data-gangle-n]");
  if (ang) { ang.oninput = () => { g.angle = +ang.value; angN.value = ang.value; live(g); }; ang.onchange = () => commit(g); angN.onchange = () => { g.angle = +angN.value || 0; commit(g); }; }
  inspector.querySelectorAll("[data-gc]").forEach((x) => { x.oninput = () => { g.stops[x.dataset.gc].c = x.value; live(g); }; x.onchange = () => commit(g); });
  inspector.querySelectorAll("[data-gct]").forEach((x) => (x.onchange = () => { g.stops[x.dataset.gct].c = x.value.trim() || "#000000"; commit(g); }));
  inspector.querySelectorAll("[data-gp]").forEach((x) => (x.onchange = () => { g.stops[x.dataset.gp].p = Math.max(0, Math.min(100, +x.value || 0)); commit(g); }));
  inspector.querySelectorAll("[data-gdel]").forEach((x) => (x.onclick = () => { g.stops.splice(+x.dataset.gdel, 1); commit(g); }));
  const add = inspector.querySelector("[data-gadd]");
  if (add) add.onclick = () => {
    // new stop in the middle of the widest gap
    const st = [...g.stops].sort((a, b) => a.p - b.p);
    let i = 0;
    for (let k = 1; k < st.length - 1; k++) if (st[k + 1].p - st[k].p > st[i + 1].p - st[i].p) i = k;
    g.stops.push({ c: st[i].c, p: (st[i].p + st[i + 1].p) / 2 });
    commit(g);
  };
  // drag a stop along the bar
  const bar = inspector.querySelector(".gbar");
  bar.querySelectorAll(".gstop").forEach((h) => (h.onpointerdown = (e) => {
    e.preventDefault(); h.setPointerCapture(e.pointerId);
    const i = +h.dataset.stop, r = bar.getBoundingClientRect();
    h.onpointermove = (ev) => { g.stops[i].p = Math.max(0, Math.min(100, ((ev.clientX - r.left) / r.width) * 100)); h.style.left = g.stops[i].p + "%"; const pi = inspector.querySelector(`[data-gp="${i}"]`); if (pi) pi.value = Math.round(g.stops[i].p); live(g); };
    h.onpointerup = () => { h.onpointermove = null; h.onpointerup = null; commit(g); };
  }));
}
// ---------- effects: CSS filters as sliders ----------
const FX = [["blur", "Blur", 0, 40, 0, "px"], ["brightness", "Brightness", 0, 200, 100, "%"], ["contrast", "Contrast", 0, 200, 100, "%"], ["saturate", "Saturation", 0, 200, 100, "%"], ["grayscale", "Grayscale", 0, 100, 0, "%"], ["hue-rotate", "Hue", 0, 360, 0, "deg"]];
function readFx(f) { const o = {}; for (const [k, , , , def, u] of FX) { const m = new RegExp(k + "\\(([-\\d.]+)").exec(f || ""); o[k] = m ? parseFloat(m[1]) * (u === "%" && !/%/.test(f.slice(m.index, m.index + 30).split(")")[0]) ? 100 : 1) : def; } return o; }
const fxCss = (o) => FX.filter(([k, , , , def]) => o[k] !== def).map(([k, , , , , u]) => `${k}(${o[k]}${u})`).join(" ");
function effectsSection(st) {
  const o = readFx(st.filter);
  return `<div class="sec"><h4>Effects</h4>${FX.map(([k, l, mn, mx, , u]) => `<div class="grow fx"><label>${l}</label><input type="range" min="${mn}" max="${mx}" value="${o[k]}" data-fx="${k}"><span>${o[k]}${u === "deg" ? "°" : u}</span></div>`).join("")}<button data-fxreset style="width:100%;margin-top:4px">Reset effects</button></div>`;
}
function wireEffects(n) {
  const o = readFx((n.style || {}).filter);
  inspector.querySelectorAll("[data-fx]").forEach((x) => {
    const u = FX.find((f) => f[0] === x.dataset.fx)[5];
    x.oninput = () => { o[x.dataset.fx] = +x.value; x.nextElementSibling.textContent = x.value + (u === "deg" ? "°" : u); const e = elFor(n.id); if (e) e.style.filter = fxCss(o); };
    x.onchange = () => setStyle({ filter: fxCss(o) || null });
  });
  const r = inspector.querySelector("[data-fxreset]"); if (r) r.onclick = () => setStyle({ filter: null });
}

function setStyle(props) {
  op("updateStyles", { updates: [{ nodeIds: selection, styles: props }] });
}
function renderInspector() {
  const focused = document.activeElement && inspector.contains(document.activeElement) ? document.activeElement : null;
  const key = focused && focused.dataset.prop;
  const caret = focused && focused.selectionStart !== undefined ? [focused.selectionStart, focused.selectionEnd] : null;
  inspector.textContent = "";
  if (!selection.length) { inspector.innerHTML = `<div class="hint">Select something on the canvas or in Layers to edit it.<br><br><b>Tips</b><br>Double-click text to edit it.<br>Drag an element to move it anywhere (guides snap to centres and edges). Drag its blue edge to resize.<br>R / O / T / F draw a rectangle, oval, text or frame. Hold Alt to measure distances.<br>⌘] and ⌘[ change layer order.<br>Drag layers to reorder.<br>Hold Space and drag to pan, pinch or ⌘-scroll to zoom.<br>Paste or drop an image to add it. Double-click an image to crop it.<br>Drag on empty canvas to box-select. ⌘C / ⌘V copy and paste layers.<br>Present plays your artboards as slides.</div>`; return; }
  const n = nodeOf(selection[0]);
  if (!n) return;
  const st = n.style || {};
  const multi = selection.length > 1;
  const html = [];
  html.push(`<div class="nameline"><b>${esc(multi ? selection.length + " selected" : label(n))}</b><span>${n.artboard ? "Artboard" : "&lt;" + n.tag + "&gt;"} · ${multi ? "" : "#" + n.id}</span></div>`);
  if (!multi) { const cb = componentBanner(ectx, n); if (cb) html.push(cb); }
  const inp = (lab, prop, o = {}) => `<div class="f ${o.full ? "full" : ""}"><label>${lab}</label><input data-prop="${prop}" value="${esc(st[prop] ?? "")}" placeholder="${o.ph || ""}" ${o.list ? `list="${o.list}"` : ""}></div>`;
  const sel = (lab, prop, opts) => `<div class="f"><label>${lab}</label><select data-prop="${prop}"><option value=""></option>${opts.map((o) => `<option ${st[prop] === o ? "selected" : ""}>${o}</option>`).join("")}</select></div>`;
  const color = (lab, prop) => { const v = st[prop] || ""; const hex = /^#[0-9a-f]{6}$/i.test(v) ? v : "#ffffff"; return `<div class="f"><label>${lab}</label><div class="colorrow"><input type="color" data-color="${prop}" value="${hex}"><input type="text" data-prop="${prop}" value="${esc(v)}"></div></div>`; };
  if (!selection.some((id) => nodeOf(id)?.artboard)) html.push(`<div class="groupbar"><button data-grp="group" title="Group (⌘G)">Group</button><button data-grp="ungroup" title="Ungroup (⇧⌘G)">Ungroup</button>${!multi && canSplit(n) ? `<button data-grp="split" title="Make the text of this button its own layer">Separate text</button>` : ""}${!multi && !n.artboard && !n.component && !n.instanceOf ? `<button data-grp="component" title="Turn this layer into a component: instances follow it">Component</button>` : ""}</div>`);
  if (!selection.some((id) => nodeOf(id)?.artboard)) html.push(`<div class="alignbar">${ALIGN_BTNS.map(([k, t, svg]) => `<button data-align-act="${k}" title="${t}">${svg}</button>`).join("")}</div>`);
  if (n.artboard && !multi) {
    html.push(`<div class="sec"><h4>Artboard</h4><div class="grid2"><div class="f full"><label>Name</label><input data-name value="${esc(n.name || "")}"></div>${inp("Width", "width")}${inp("Height", "height", { ph: "fit-content" })}</div></div>`);
  } else {
    html.push(`<div class="sec"><h4>Size</h4><div class="grid2">${inp("Width", "width", { ph: "auto" })}${inp("Height", "height", { ph: "auto" })}</div></div>`);
  }
  if (isContainer(n) || n.artboard) {
    const autoRow = !multi && !n.crop ? `<div class="autorow"><button data-autolayout class="${n.auto ? "on" : ""}">${n.auto ? "Auto layout: on" : "Add auto layout"}</button><span class="muted">${n.auto ? "The frame lays its layers out: drag to reorder, set gap and padding below." : "Lay the layers out in a row or a column that keeps itself tidy."}</span></div>` : "";
    html.push(`<div class="sec"><h4>Layout</h4>${autoRow}<div class="grid2">${sel("Display", "display", ["flex", "block", "grid", "none"])}${sel("Direction", "flex-direction", ["column", "row", "column-reverse", "row-reverse"])}${sel("Align", "align-items", ["flex-start", "center", "flex-end", "stretch", "baseline"])}${sel("Justify", "justify-content", ["flex-start", "center", "flex-end", "space-between", "space-around"])}${inp("Gap", "gap")}${inp("Padding", "padding", { ph: "e.g. 24px 32px" })}</div></div>`);
  } else html.push(`<div class="sec"><h4>Spacing</h4><div class="grid2">${inp("Padding", "padding")}${inp("Margin", "margin")}</div></div>`);
  if (!n.artboard) {
    html.push(`<div class="sec"><h4>Position</h4><div class="grid2">${sel("Type", "position", ["static", "relative", "absolute"])}${inp("Z-index", "z-index")}${st.position === "absolute" ? inp("Left", "left") + inp("Top", "top") + inp("Right", "right") + inp("Bottom", "bottom") : ""}<div class="f"><label>Rotation °</label><input type="number" step="1" data-rot value="${rotOf(st.transform)}"></div>${inp("Transform", "transform", { ph: "rotate(-4deg)" })}</div></div>`);
  }
  if (n.tag === "svg" && !multi) html.push(pen.svgControls(n));
  if (n.artboard && !multi) html.push(guides.gridControls(n));
  html.push(fillSection(st, multi ? null : n));
  html.push(`<div class="sec"><h4>Appearance</h4><div class="grid2">${inp("Opacity", "opacity", { ph: "1" })}${inp("Radius", "border-radius")}${inp("Border", "border", { full: true, ph: "1px solid #ddd" })}${inp("Shadow", "box-shadow", { full: true, ph: "0 8px 24px rgba(0,0,0,.15)" })}${sel("Blend", "mix-blend-mode", ["normal", "multiply", "screen", "overlay", "darken", "lighten", "color-burn", "soft-light", "difference", "luminosity"])}${sel("Clip", "overflow", ["visible", "hidden"])}</div></div>`);
  html.push(effectsSection(st));
  if (n.tag === "img" || n.crop) {
    const zoom = n.crop ? n.crop.zoom : 1, pic = n.crop ? (n.children || [])[0] : n;
    html.push(`<div class="sec"><h4>Image</h4><div class="grid2">${n.crop ? "" : sel("Fit", "object-fit", ["cover", "contain", "fill"])}<div class="f full"><label>Zoom <b id="zoomv">${Math.round(zoom * 100)}%</b></label><input type="range" min="100" max="400" step="5" value="${Math.round(zoom * 100)}" data-cropzoom></div>${n.crop ? "" : `<div class="f full"><label>Source</label><input data-attr="src" value="${esc((n.attrs && n.attrs.src) || "")}"></div>`}<div class="f full"><label>Alt text</label><input data-attr="alt" data-attr-id="${pic ? pic.id : n.id}" value="${esc((pic && pic.attrs && pic.attrs.alt) || "")}"></div>${n.crop ? "" : `<div class="f full"><label>Crop to</label><div class="seg">${[["Free", 0], ["1:1", 1], ["4:5", 0.8], ["16:9", 16 / 9], ["9:16", 9 / 16]].map(([l, r]) => `<button data-ratio="${r}">${l}</button>`).join("")}</div></div>`}<button id="crop-img">${n.crop ? "Slide / reposition" : "Crop / reposition"}</button><button id="swap-img" data-pic="${pic ? pic.id : n.id}">Replace…</button>${n.crop ? `<button data-uncrop>Remove zoom</button><button data-bake title="Render the crop to one flat picture (what email needs)">Bake crop</button>` : ""}</div></div>`);
  }
  if (n.tag !== "img" && n.tag !== "svg" && !n.crop) {
    html.push(`<div class="sec"><h4>Text</h4><div class="grid2">${inp("Font", "font-family", { full: true, list: "fonts", ph: "'Inter Tight', sans-serif" })}${inp("Size", "font-size")}${sel("Weight", "font-weight", ["300", "400", "500", "600", "700", "800"])}${color("Color", "color")}${!multi ? styleSelect(ectx, n, "color", "Text colour style") + textStyleSelect(ectx, n) : ""}${inp("Line height", "line-height")}${inp("Tracking", "letter-spacing", { ph: "-0.02em" })}<div class="f full"><label>Align</label><div class="seg">${["left", "center", "right"].map((a) => `<button data-align="${a}" class="${st["text-align"] === a ? "on" : ""}">${a}</button>`).join("")}</div></div>${sel("Case", "text-transform", ["none", "uppercase", "lowercase", "capitalize"])}</div></div>`);
  }
  html.push(`<div class="sec"><h4>All styles (CSS)</h4><textarea class="raw" spellcheck="false" data-raw>${esc(Object.entries(st).map(([k, v]) => `${k}: ${v};`).join("\n"))}</textarea></div>`);
  inspector.innerHTML = html.join("");

  inspector.querySelectorAll("[data-prop]").forEach((el) => {
    el.addEventListener("change", () => {
      if (el.dataset.prop === "position" && el.value === "absolute" && n.style.position !== "absolute" && !n.artboard) {
        return op("updateStyles", { updates: pinPlan([n.id]).updates });
      }
      setStyle({ [el.dataset.prop]: el.value.trim() === "" ? null : el.value.trim() });
    });
    el.addEventListener("keydown", (e) => { if (e.key === "Enter") el.blur(); e.stopPropagation(); });
  });
  let ct; inspector.querySelectorAll("[data-color]").forEach((el) => el.addEventListener("input", () => { clearTimeout(ct); ct = setTimeout(() => setStyle({ [el.dataset.color]: el.value }), 120); }));
  inspector.querySelectorAll("[data-grp]").forEach((b) => (b.onclick = () => ({ group: groupSel, ungroup: ungroupSel, split: splitSel, component: () => assets.makeComponent(selection[0]) })[b.dataset.grp]()));
  inspector.querySelectorAll("[data-align-act]").forEach((b) => (b.onclick = () => alignSel(b.dataset.alignAct)));
  inspector.querySelectorAll("[data-align]").forEach((b) => (b.onclick = () => setStyle({ "text-align": b.dataset.align })));
  inspector.querySelectorAll("[data-attr]").forEach((el) => el.addEventListener("change", () => op("setAttrs", { nodeId: el.dataset.attrId || n.id, attrs: { [el.dataset.attr]: el.value || null } })));
  wireInspector(ectx, n, inspector);
  if (n.tag === "svg") pen.wireSvg(n, inspector);
  if (n.artboard) guides.wireGrid(n, inspector);
  const ab = inspector.querySelector("[data-autolayout]"); if (ab) ab.onclick = () => toggleAutoLayout(n.id);
  const rotIn = inspector.querySelector("[data-rot]"); if (rotIn) { rotIn.onchange = () => { const t = withRot(n.style.transform, parseFloat(rotIn.value) || 0); op("updateStyles", { updates: [{ nodeIds: [n.id], styles: { transform: t || null } }] }); }; rotIn.onkeydown = (e) => { if (e.key === "Enter") rotIn.blur(); e.stopPropagation(); }; }
  const cz = inspector.querySelector("[data-cropzoom]");
  if (cz) { let t; cz.oninput = () => { $("#zoomv").textContent = cz.value + "%"; clearTimeout(t); t = setTimeout(() => setCropZoom(n.id, cz.value / 100), 160); }; }
  const un = inspector.querySelector("[data-uncrop]"); if (un) un.onclick = () => op("uncropImage", { nodeId: n.id });
  const bk = inspector.querySelector("[data-bake]"); if (bk) bk.onclick = async () => { toast("Rendering the crop…"); try { await op("bakeCrop", { nodeId: n.id }); toast("Baked into one picture."); } catch {} };
  const nm = inspector.querySelector("[data-name]"); if (nm) nm.addEventListener("change", () => nm.value.trim() && op("rename", { items: [{ nodeId: n.id, name: nm.value.trim() }] }));
  wireFill(n); wireEffects(n);
  inspector.querySelectorAll("[data-ratio]").forEach((b) => (b.onclick = async () => {
    const r = Number(b.dataset.ratio), el = elFor(n.id);
    if (!r) return startCrop(n.id);
    await op("updateStyles", { updates: [{ nodeIds: [n.id], styles: { width: el.offsetWidth + "px", height: Math.round(el.offsetWidth / r) + "px", "object-fit": "cover" } }] });
  }));
  const cb = $("#crop-img"); if (cb) cb.onclick = () => startCrop(n.id);
  const sw = $("#swap-img"); if (sw) sw.onclick = () => pickImage((src) => op("setAttrs", { nodeId: sw.dataset.pic || n.id, attrs: { src } }));
  const raw = inspector.querySelector("[data-raw]");
  if (raw) {
    raw.addEventListener("keydown", (e) => e.stopPropagation());
    raw.addEventListener("change", () => {
      const next = {};
      for (const part of raw.value.split(/;(?![^(]*\))/)) { const i = part.indexOf(":"); if (i > 0) next[part.slice(0, i).trim()] = part.slice(i + 1).trim(); }
      const styles = {};
      for (const k of Object.keys(st)) if (!(k in next)) styles[k] = null;
      Object.assign(styles, next);
      setStyle(styles);
    });
  }
  if (key) { const again = inspector.querySelector(`[data-prop="${key}"]`); if (again) { again.focus(); if (caret && again.setSelectionRange) try { again.setSelectionRange(...caret); } catch {} } }
}
const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

// features that live in their own files get the editor's internals through one object
const ectx = {
  $, op, toast, esc, FONTS, pop, es,
  get state() { return state; }, get selection() { return selection; },
  select, nodeOf, find, elFor, insertTarget, insertHtml, pickImage, openMenu, confirmBox, fit, drawOverlay, isTextLeaf, isContainer, view: () => view,
  world, setTool, artboardOf, currentArtboard,
};
const assets = initAssets(ectx);
guides = initGuides(ectx);
pen = initPen(ectx);
initTips();
const ask = initAsk(ectx);
const exporter = initExport(ectx);
const history = initHistory(ectx);
$("#btn-history").onclick = () => history.open();
$("#btn-export-dlg").onclick = () => { closeMenus(); exporter.open(); };

// first load: fit once the first doc has arrived
let first = true;
// if nothing would be on screen (a new project, a view saved somewhere else, artboards moved away), fit instead
function ensureVisible() {
  const vr = viewport.getBoundingClientRect();
  if (!state.artboards.length || !vr.width) return;
  const seen = state.artboards.some((a) => { const el = elFor(a.id); if (!el) return false; const r = el.getBoundingClientRect(); return r.right > vr.left + 20 && r.left < vr.right - 20 && r.bottom > vr.top + 20 && r.top < vr.bottom - 20; });
  if (!seen) fit();
}
es.addEventListener("doc", () => {
  if (!first) return;
  first = false;
  let v = null; try { v = JSON.parse(localStorage.getItem("studio-view:" + project?.id)); } catch {}
  if (v) { view = v; applyView(); }
  setTimeout(() => (v ? ensureVisible() : fit()), 80);
});
