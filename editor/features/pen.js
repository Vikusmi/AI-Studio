// The pen tool (draw vector paths with straight and curved segments), point editing for any SVG path, and the SVG controls
// (fill, stroke, width). Paths are plain <svg><path d=…> layers, so they export and print like everything else.
import { parsePath, serializePath, buildSvg, bounds, clone, translate, nearestOnPath, splitSegment } from "./vector.js";

const NS = "http://www.w3.org/2000/svg";
const SHAPES = "path,rect,circle,ellipse,polygon,polyline,line";

export function initPen(ctx) {
  const { op, toast } = ctx;
  const vp = ctx.$("#viewport");
  const view = () => ctx.view();

  // ======================= drawing with the pen =======================
  let pts = [];                 // anchors in client (screen) coordinates, with absolute handle positions
  let dragging = -1, hover = null, closing = false;
  const active = () => pts.length > 0;
  const near = (a, b, d = 9) => Math.hypot(a.x - b.x, a.y - b.y) <= d;

  function pointerDown(e) {
    const p = { x: e.clientX, y: e.clientY, hin: null, hout: null };
    if (pts.length >= 2 && near(p, pts[0])) { closing = true; finish(true); return; }
    pts.push(p); dragging = pts.length - 1;
    ctx.drawOverlay();
  }
  function pointerMove(e) {
    if (dragging >= 0) {
      const a = pts[dragging], dx = e.clientX - a.x, dy = e.clientY - a.y;
      if (Math.hypot(dx, dy) > 3) { a.hout = { x: a.x + dx, y: a.y + dy }; a.hin = { x: a.x - dx, y: a.y - dy }; }
      hover = null;
    } else hover = { x: e.clientX, y: e.clientY };
    ctx.drawOverlay();
  }
  function pointerUp() { dragging = -1; ctx.drawOverlay(); }
  function hoverMove(e) { if (!active()) return; hover = { x: e.clientX, y: e.clientY }; ctx.drawOverlay(); }
  function cancel() { pts = []; dragging = -1; hover = null; closing = false; ctx.drawOverlay(); }

  async function finish(closed) {
    // a double-click adds a duplicate point: drop points that sit on top of the previous one
    const cleaned = pts.filter((p, i) => i === 0 || !near(p, pts[i - 1], 2.5));
    const list = cleaned.length >= 2 ? cleaned : [];
    const first = pts[0];
    pts = []; dragging = -1; hover = null;
    ctx.drawOverlay();
    ctx.setTool("select");
    if (list.length < 2) return toast("A path needs at least two points.");
    // the frame under the first point is where the path lives
    const hit = document.elementFromPoint(first.x, first.y);
    let el = hit && ctx.world.contains(hit) ? hit.closest("[data-id]") : null;
    while (el) { const nn = ctx.nodeOf(el.dataset.id); if (nn && ctx.isContainer(nn)) break; el = el.parentElement && el.parentElement.closest("[data-id]"); }
    if (!el) return toast("Draw inside an artboard.");
    const pr = el.getBoundingClientRect(), cs = getComputedStyle(el), z = view().z;
    const bl = parseFloat(cs.borderLeftWidth) || 0, bt = parseFloat(cs.borderTopWidth) || 0;
    const loc = (p) => (p ? { x: (p.x - pr.left) / z - bl, y: (p.y - pr.top) / z - bt } : null);
    const sub = [{ closed, pts: list.map((p) => ({ ...loc(p), hin: loc(p.hin), hout: loc(p.hout) })) }];
    const out = buildSvg(sub, { fill: closed ? "#d9d9d9" : "none", stroke: "#161616", strokeWidth: 2 });
    const html = out.raw.replace("<svg", `<svg layer-name="${closed ? "Shape" : "Path"}" style="position:absolute;left:${out.left}px;top:${out.top}px"`);
    try {
      if (cs.position === "static") await op("updateStyles", { updates: [{ nodeIds: [el.dataset.id], styles: { position: "relative" } }] });
      const r = await op("insert", { parentId: el.dataset.id, html });
      ctx.select([r[0].id]);
    } catch {}
  }

  // the unfinished path, drawn in the overlay
  function pathD(list, close) {
    if (!list.length) return "";
    let d = `M${list[0].x} ${list[0].y}`;
    const seg = (a, b) => (a.hout || b.hin ? `C${(a.hout || a).x} ${(a.hout || a).y} ${(b.hin || b).x} ${(b.hin || b).y} ${b.x} ${b.y}` : `L${b.x} ${b.y}`);
    for (let i = 1; i < list.length; i++) d += seg(list[i - 1], list[i]);
    if (close && list.length > 2) d += seg(list[list.length - 1], list[0]) + "Z";
    return d;
  }
  function drawPen(overlay) {
    if (!active()) return;
    const v = vp.getBoundingClientRect();
    const svg = document.createElementNS(NS, "svg");
    svg.setAttribute("class", "penprev");
    svg.setAttribute("width", v.width); svg.setAttribute("height", v.height);
    const off = (p) => ({ x: p.x - v.left, y: p.y - v.top, hin: p.hin && { x: p.hin.x - v.left, y: p.hin.y - v.top }, hout: p.hout && { x: p.hout.x - v.left, y: p.hout.y - v.top } });
    const list = pts.map(off);
    const preview = [...list];
    if (hover && dragging < 0) preview.push({ x: hover.x - v.left, y: hover.y - v.top });
    const path = document.createElementNS(NS, "path");
    path.setAttribute("d", pathD(preview, false)); path.setAttribute("class", "pp");
    svg.appendChild(path);
    for (const a of list) {
      for (const h of [a.hin, a.hout]) if (h) { const l = document.createElementNS(NS, "line"); l.setAttribute("x1", a.x); l.setAttribute("y1", a.y); l.setAttribute("x2", h.x); l.setAttribute("y2", h.y); l.setAttribute("class", "ph"); svg.appendChild(l); const c = document.createElementNS(NS, "circle"); c.setAttribute("cx", h.x); c.setAttribute("cy", h.y); c.setAttribute("r", 3); c.setAttribute("class", "pk"); svg.appendChild(c); }
    }
    list.forEach((a, i) => { const r = document.createElementNS(NS, "rect"); r.setAttribute("x", a.x - 4); r.setAttribute("y", a.y - 4); r.setAttribute("width", 8); r.setAttribute("height", 8); r.setAttribute("class", "pa" + (i === 0 && list.length > 2 && hover && near({ x: hover.x - v.left, y: hover.y - v.top }, a) ? " first" : "")); svg.appendChild(r); });
    overlay.appendChild(svg);
  }

  // ======================= editing the points of an svg =======================
  let edit = null;   // { id, pi (path index), sub: [...], sel: {s,i}|null, ctm info is read live }
  const svgOf = (id) => { const el = ctx.elFor(id); return el && el.tagName.toLowerCase() === "svg" ? el : null; };
  const pathEls = (svg) => [...svg.querySelectorAll("path")];

  function loadPath(id, pi) {
    const svg = svgOf(id); if (!svg) return false;
    const el = pathEls(svg)[pi]; if (!el) { toast("This graphic has no editable path."); return false; }
    const r = parsePath(el.getAttribute("d"));
    if (!r.ok) { toast("This path can't be edited point by point."); return false; }
    edit = { id, pi, sub: r.subpaths, sel: null, selSub: null };
    return true;
  }
  function editVector(id) {
    const n = ctx.nodeOf(id);
    if (!n || n.tag !== "svg") return toast("Select a path or shape to edit its points.");
    ctx.select([id]);          // first: changing the selection leaves any other edit
    if (!loadPath(id, 0)) return;
    ctx.drawOverlay();
  }
  function exitEdit() { if (!edit) return false; edit = null; ctx.drawOverlay(); return true; }
  const editing = () => !!edit;

  // local (path coordinate) <-> screen, through the path's own transform, so scaled / transformed icons edit correctly
  function ctm() {
    const svg = edit && svgOf(edit.id); if (!svg) return null;
    const el = pathEls(svg)[edit.pi]; if (!el) return null;
    const m = el.getScreenCTM(); return m;
  }
  const toScreen = (m, p) => ({ x: m.a * p.x + m.c * p.y + m.e, y: m.b * p.x + m.d * p.y + m.f });
  const toLocal = (m, x, y) => { const inv = m.inverse(); return { x: inv.a * x + inv.c * y + inv.e, y: inv.b * x + inv.d * y + inv.f }; };

  function drawEdit(overlay) {
    if (!edit) return;
    const m = ctm(); if (!m) { edit = null; return; }
    const v = vp.getBoundingClientRect();
    const svg = document.createElementNS(NS, "svg");
    svg.setAttribute("class", "penprev vec"); svg.setAttribute("width", v.width); svg.setAttribute("height", v.height);
    const wrap = document.createElement("div"); wrap.className = "vecpts";
    edit.sub.forEach((s, si) => s.pts.forEach((a, i) => {
      const sa = toScreen(m, a), ax = sa.x - v.left, ay = sa.y - v.top;
      const selected = edit.sel === i && edit.selSub === si;
      const addH = (h, k) => {
        if (!h || !selected) return;
        const sh = toScreen(m, h), hx = sh.x - v.left, hy = sh.y - v.top;
        const l = document.createElementNS(NS, "line"); l.setAttribute("x1", ax); l.setAttribute("y1", ay); l.setAttribute("x2", hx); l.setAttribute("y2", hy); l.setAttribute("class", "ph"); svg.appendChild(l);
        const d = document.createElement("div"); d.className = "vh"; d.dataset.s = si; d.dataset.i = i; d.dataset.k = k; d.style.left = hx + "px"; d.style.top = hy + "px"; wrap.appendChild(d);
      };
      addH(a.hin, "hin"); addH(a.hout, "hout");
      const d = document.createElement("div"); d.className = "vpt" + (selected ? " sel" : ""); d.dataset.s = si; d.dataset.i = i; d.style.left = ax + "px"; d.style.top = ay + "px"; wrap.appendChild(d);
    }));
    overlay.appendChild(svg); overlay.appendChild(wrap);
    // a small bar: what to do with the selected point
    const bar = document.createElement("div"); bar.className = "vecbar";
    const has = edit.sel !== null;
    bar.innerHTML = `<button data-vec="corner" ${has ? "" : "disabled"} title="Sharp corner (remove handles)">Corner</button><button data-vec="smooth" ${has ? "" : "disabled"} title="Smooth curve through this point">Smooth</button><button data-vec="delete" ${has ? "" : "disabled"} title="Delete point (⌫)">Delete</button><span class="muted">drag points · double-click the line to add one</span><button class="primary" data-vec="done">Done</button>`;
    overlay.appendChild(bar);
  }

  async function commit() {
    if (!edit) return;
    const n = ctx.nodeOf(edit.id); if (!n) return;
    const doc = new DOMParser().parseFromString(n.raw, "image/svg+xml");
    const paths = [...doc.querySelectorAll("path")];
    const p = paths[edit.pi]; if (!p) return;
    p.setAttribute("d", serializePath(edit.sub));
    try { await op("setSvg", { nodeId: edit.id, raw: new XMLSerializer().serializeToString(doc.documentElement) }); } catch {}
  }
  function liveUpdate() {
    const svg = edit && svgOf(edit.id); if (!svg) return;
    const el = pathEls(svg)[edit.pi]; if (el) el.setAttribute("d", serializePath(edit.sub));
  }

  function vecDown(e) {
    if (!edit) return false;
    const t = e.target;
    const bar = t.closest && t.closest("[data-vec]");
    if (bar) { e.preventDefault(); e.stopPropagation(); doBar(bar.dataset.vec); return true; }
    const pt = t.closest && t.closest(".vpt, .vh");
    if (!pt) return false;
    e.preventDefault(); e.stopPropagation();
    const si = +pt.dataset.s, i = +pt.dataset.i, isHandle = pt.classList.contains("vh");
    edit.selSub = si; edit.sel = i;
    const a = edit.sub[si].pts[i];
    const m = ctm();
    const startSmooth = a.hin && a.hout && Math.abs((a.hin.x - a.x) * (a.hout.y - a.y) - (a.hin.y - a.y) * (a.hout.x - a.x)) < 0.02 * (Math.hypot(a.hin.x - a.x, a.hin.y - a.y) * Math.hypot(a.hout.x - a.x, a.hout.y - a.y) + 1);
    const orig = JSON.parse(JSON.stringify(a));
    let moved = false;
    const mv = (ev) => {
      moved = true;
      const l = toLocal(ctm(), ev.clientX, ev.clientY);
      if (!isHandle) {
        const dx = l.x - orig.x, dy = l.y - orig.y;
        a.x = orig.x + dx; a.y = orig.y + dy;
        if (orig.hin) a.hin = { x: orig.hin.x + dx, y: orig.hin.y + dy };
        if (orig.hout) a.hout = { x: orig.hout.x + dx, y: orig.hout.y + dy };
      } else {
        const k = pt.dataset.k, other = k === "hin" ? "hout" : "hin";
        a[k] = { x: l.x, y: l.y };
        if (startSmooth && !ev.altKey && orig[other]) {
          // keep the curve smooth: the other handle mirrors the angle and keeps its own length
          const len = Math.hypot(orig[other].x - orig.x, orig[other].y - orig.y), vx = l.x - a.x, vy = l.y - a.y, vl = Math.hypot(vx, vy) || 1;
          a[other] = { x: a.x - (vx / vl) * len, y: a.y - (vy / vl) * len };
        }
      }
      liveUpdate(); ctx.drawOverlay();
    };
    const up = async () => { removeEventListener("pointermove", mv); removeEventListener("pointerup", up); if (moved) await commit(); ctx.drawOverlay(); };
    addEventListener("pointermove", mv); addEventListener("pointerup", up);
    ctx.drawOverlay();
    return true;
  }
  function doBar(k) {
    if (!edit) return;
    if (k === "done") return exitEdit();
    if (edit.sel === null) return;
    const s = edit.sub[edit.selSub], a = s.pts[edit.sel];
    if (k === "delete") {
      if (s.pts.length <= 2) return toast("A path needs at least two points.");
      s.pts.splice(edit.sel, 1); edit.sel = null; edit.selSub = null;
    } else if (k === "corner") { a.hin = null; a.hout = null; }
    else if (k === "smooth") {
      const n = s.pts.length, prev = s.pts[(edit.sel - 1 + n) % n], next = s.pts[(edit.sel + 1) % n];
      const dx = next.x - prev.x, dy = next.y - prev.y, dl = Math.hypot(dx, dy) || 1;
      const lp = Math.hypot(a.x - prev.x, a.y - prev.y) / 3, ln = Math.hypot(next.x - a.x, next.y - a.y) / 3;
      a.hin = { x: a.x - (dx / dl) * lp, y: a.y - (dy / dl) * lp }; a.hout = { x: a.x + (dx / dl) * ln, y: a.y + (dy / dl) * ln };
    }
    liveUpdate(); commit(); ctx.drawOverlay();
  }
  // double-click the outline: a new point lands there and the curve keeps its shape
  function vecDouble(e) {
    if (!edit) return false;
    const m = ctm(); if (!m) return false;
    const l = toLocal(m, e.clientX, e.clientY), scale = Math.hypot(m.a, m.b) || 1;
    const hit = nearestOnPath(edit.sub, l.x, l.y);
    if (!hit || hit.dist * scale > 10) return false;
    edit.sub = splitSegment(edit.sub, hit.s, hit.i, hit.t);
    edit.selSub = hit.s; edit.sel = hit.i + 1;
    liveUpdate(); commit(); ctx.drawOverlay();
    return true;
  }
  // clicking another path of the same graphic switches to it
  function vecPickPath(e) {
    if (!edit) return false;
    const svg = svgOf(edit.id); if (!svg) return false;
    const hit = document.elementFromPoint(e.clientX, e.clientY);
    if (!hit || !svg.contains(hit) || hit.tagName.toLowerCase() !== "path") return false;
    const i = pathEls(svg).indexOf(hit);
    if (i < 0 || i === edit.pi) return false;
    return loadPath(edit.id, i);
  }

  function onKey(e) {
    if (active()) {
      if (e.key === "Escape") { e.preventDefault(); cancel(); ctx.setTool("select"); return true; }
      if (e.key === "Enter") { e.preventDefault(); finish(false); return true; }
      if (e.key === "Backspace" || e.key === "Delete") { e.preventDefault(); pts.pop(); ctx.drawOverlay(); return true; }
    }
    if (edit) {
      if (e.key === "Escape" || e.key === "Enter") { e.preventDefault(); exitEdit(); return true; }
      if ((e.key === "Backspace" || e.key === "Delete") && edit.sel !== null) { e.preventDefault(); doBar("delete"); return true; }
    }
    return false;
  }

  // ======================= svg inspector =======================
  const paint = (v) => (v && v !== "none" && /^#|rgb|hsl/.test(v) ? v : null);
  function readSvg(n) {
    const doc = new DOMParser().parseFromString(n.raw || "", "image/svg+xml");
    const root = doc.documentElement, shape = root.querySelector(SHAPES);
    const get = (k) => (shape && shape.getAttribute(k)) || root.getAttribute(k) || "";
    return { fill: get("fill"), stroke: get("stroke"), sw: get("stroke-width"), cap: get("stroke-linecap"), join: get("stroke-linejoin"), count: root.querySelectorAll(SHAPES).length };
  }
  function svgControls(n) {
    if (n.tag !== "svg") return "";
    const s = readSvg(n);
    const hex = (v) => (/^#[0-9a-f]{6}$/i.test(v) ? v : "#000000");
    return `<div class="sec"><h4>Vector</h4><div class="grid2">
      <div class="f"><label>Fill</label><div class="colorrow"><input type="color" data-svgc="fill" value="${hex(s.fill)}"><input type="text" data-svgt="fill" value="${ctx.esc(s.fill)}" placeholder="none"></div></div>
      <div class="f"><label>Stroke</label><div class="colorrow"><input type="color" data-svgc="stroke" value="${hex(s.stroke)}"><input type="text" data-svgt="stroke" value="${ctx.esc(s.stroke)}" placeholder="none"></div></div>
      <div class="f"><label>Stroke width</label><input type="number" min="0" step="0.5" data-svgt="stroke-width" value="${ctx.esc(s.sw)}" placeholder="0"></div>
      <div class="f"><label>Ends / joins</label><select data-svgt="cap"><option value=""></option><option ${s.cap === "round" ? "selected" : ""}>round</option><option ${s.cap === "butt" ? "selected" : ""}>butt</option><option ${s.cap === "square" ? "selected" : ""}>square</option></select></div>
      <button class="full" data-svg-edit style="grid-column:1/-1">Edit points  ↵</button>
    </div></div>`;
  }
  async function applySvg(n, attrs) {
    const doc = new DOMParser().parseFromString(n.raw, "image/svg+xml");
    const root = doc.documentElement, shapes = [...root.querySelectorAll(SHAPES)];
    for (const el of shapes.length ? shapes : [root]) for (const [k, v] of Object.entries(attrs)) { if (v === "" || v === null) el.removeAttribute(k); else el.setAttribute(k, v); }
    try { await op("setSvg", { nodeId: n.id, raw: new XMLSerializer().serializeToString(root) }); } catch {}
  }
  function wireSvg(n, root) {
    if (n.tag !== "svg") return;
    root.querySelectorAll("[data-svgc]").forEach((el) => {
      let t; el.oninput = () => { clearTimeout(t); t = setTimeout(() => applySvg(n, { [el.dataset.svgc]: el.value }), 140); };
    });
    root.querySelectorAll("[data-svgt]").forEach((el) => {
      el.onchange = () => {
        const k = el.dataset.svgt;
        if (k === "cap") return applySvg(n, { "stroke-linecap": el.value, "stroke-linejoin": el.value });
        applySvg(n, { [k]: el.value.trim() });
      };
      el.onkeydown = (e) => { e.stopPropagation(); if (e.key === "Enter") el.blur(); };
    });
    const b = root.querySelector("[data-svg-edit]"); if (b) b.onclick = () => editVector(n.id);
  }

  function drawOverlay(overlay) { drawPen(overlay); drawEdit(overlay); }
  const editId = () => (edit ? edit.id : null);
  return { editId, active, pointerDown, pointerMove, pointerUp, hoverMove, cancel, finish, onKey, editVector, exitEdit, editing, vecDown, vecDouble, vecPickPath, drawOverlay, svgControls, wireSvg };
}
