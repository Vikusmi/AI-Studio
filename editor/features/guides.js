// Rulers, draggable guides and a layout grid. Guides and grid live on the artboard (so they save with the project and snap for
// everyone), but they are editor-only: they never appear in exports.

const NICE = [1, 2, 5, 10, 20, 25, 50, 100, 200, 250, 500, 1000, 2000, 5000, 10000];
const RUL = 20;

export function initGuides(ctx) {
  const { $, op } = ctx;
  const vp = $("#viewport");
  let rulers = false;
  try { rulers = localStorage.getItem("studio-rulers") === "on"; } catch {}

  // ---------- DOM ----------
  const mk = (cls) => { const d = document.createElement("div"); d.className = cls; return d; };
  const rt = mk("ruler ruler-t"), rl = mk("ruler ruler-l"), rc = mk("ruler-corner"), layer = mk("guide-layer");
  const ct = document.createElement("canvas"), cl = document.createElement("canvas"), cg = document.createElement("canvas");
  rt.appendChild(ct); rl.appendChild(cl); layer.appendChild(cg);
  vp.append(layer, rt, rl, rc);
  const lineEls = [];

  const view = () => ctx.view();
  const vr = () => vp.getBoundingClientRect();
  const abRect = (id) => { const el = ctx.elFor(id); return el ? el.getBoundingClientRect() : null; };
  const nodeAb = (id) => ctx.artboardOf(id);
  function activeArtboard() {
    const sel = ctx.selection[0];
    const a = sel && ctx.artboardOf(sel);
    if (a) return a;
    const v = vr(), cx = v.left + v.width / 2, cy = v.top + v.height / 2;
    let best = null, bd = Infinity;
    for (const ab of ctx.boards()) {
      const r = abRect(ab.id); if (!r) continue;
      const d = Math.hypot(Math.max(r.left - cx, 0, cx - r.right), Math.max(r.top - cy, 0, cy - r.bottom));
      if (d < bd) { bd = d; best = ab; }
    }
    return best || ctx.boards()[0] || null;
  }

  // ---------- drawing ----------
  const css = (n) => getComputedStyle(document.documentElement).getPropertyValue(n).trim();
  function size(c, w, h) {
    const d = devicePixelRatio || 1;
    if (c.width !== Math.round(w * d) || c.height !== Math.round(h * d)) { c.width = Math.round(w * d); c.height = Math.round(h * d); c.style.width = w + "px"; c.style.height = h + "px"; }
    const g = c.getContext("2d"); g.setTransform(d, 0, 0, d, 0, 0); g.clearRect(0, 0, w, h); return g;
  }
  function pickStep(z) { return NICE.find((n) => n * z >= 64) || 10000; }

  function drawRulers() {
    rt.hidden = rl.hidden = rc.hidden = !rulers;
    vp.classList.toggle("rulers-on", rulers);
    if (!rulers) return;
    const v = vr(), W = v.width, H = v.height, z = view().z;
    const ab = activeArtboard(), r = ab && abRect(ab.id);
    const ox = r ? r.left - v.left : 0, oy = r ? r.top - v.top : 0;
    const ink = css("--muted"), line = css("--line"), bg = css("--panel"), acc = css("--accent");
    const step = pickStep(z), minor = step >= 100 ? step / 10 : step >= 20 ? step / 5 : step;
    const gt = size(ct, W, RUL), gl = size(cl, RUL, H);
    for (const g of [gt, gl]) { g.fillStyle = bg; g.fillRect(0, 0, W, H); g.font = "9.5px -apple-system, sans-serif"; g.fillStyle = ink; g.strokeStyle = ink; g.lineWidth = 1; }
    // selection extent
    const selEl = ctx.selection[0] && ctx.elFor(ctx.selection[0]);
    if (selEl) {
      const s = selEl.getBoundingClientRect();
      gt.fillStyle = acc + "33"; gt.fillRect(s.left - v.left, 0, s.width, RUL);
      gl.fillStyle = acc + "33"; gl.fillRect(0, s.top - v.top, RUL, s.height);
      gt.fillStyle = ink; gl.fillStyle = ink;
    }
    const draw = (g, vertical, origin, length) => {
      const lo = Math.floor((0 - origin) / z / minor) * minor, hi = (length - origin) / z;
      for (let u = lo; u <= hi; u += minor) {
        const p = Math.round(origin + u * z) + 0.5, major = Math.abs(u % step) < 1e-6;
        g.beginPath();
        if (!vertical) { g.moveTo(p, major ? 6 : 14); g.lineTo(p, RUL); } else { g.moveTo(major ? 6 : 14, p); g.lineTo(RUL, p); }
        g.strokeStyle = major ? ink : line; g.stroke();
        if (major) { g.save(); if (!vertical) g.fillText(String(Math.round(u)), p + 3, 10); else { g.translate(10, p - 3); g.rotate(-Math.PI / 2); g.fillText(String(Math.round(u)), 0, 0); } g.restore(); }
      }
    };
    draw(gt, false, ox, W); draw(gl, true, oy, H);
    gt.strokeStyle = line; gt.beginPath(); gt.moveTo(0, RUL - 0.5); gt.lineTo(W, RUL - 0.5); gt.stroke();
    gl.strokeStyle = line; gl.beginPath(); gl.moveTo(RUL - 0.5, 0); gl.lineTo(RUL - 0.5, H); gl.stroke();
  }

  let drag = null;     // a guide being created / moved: { ab, a, p, existing }
  function guideScreen(ab, g) {
    const r = abRect(ab.id); if (!r) return null;
    const v = vr(), z = view().z;
    return g.a === "x" ? r.left - v.left + g.p * z : r.top - v.top + g.p * z;
  }
  function drawGuides() {
    const v = vr(), W = v.width, H = v.height, z = view().z;
    const g = size(cg, W, H);
    // layout grid
    for (const ab of ctx.boards()) {
      const gr = ab.grid; if (!gr || !gr.show) continue;
      const r = abRect(ab.id); if (!r) continue;
      const s = gr.size || 8; if (s * z < 3.5) continue;
      g.strokeStyle = "rgba(255,61,129,0.16)"; g.lineWidth = 1; g.beginPath();
      const x0 = r.left - v.left, y0 = r.top - v.top, w = r.width / z, h = r.height / z;
      for (let x = 0; x <= w + 0.01; x += s) { const px = Math.round(x0 + x * z) + 0.5; g.moveTo(px, Math.max(0, y0)); g.lineTo(px, Math.min(H, y0 + r.height)); }
      for (let y = 0; y <= h + 0.01; y += s) { const py = Math.round(y0 + y * z) + 0.5; g.moveTo(Math.max(0, x0), py); g.lineTo(Math.min(W, x0 + r.width), py); }
      g.stroke();
    }
    // guides
    g.lineWidth = 1;
    const lines = [];
    for (const ab of ctx.state.artboards) for (const gd of ab.guides || []) { if (drag && drag.existing && drag.ab.id === ab.id && drag.existing === gd) continue; lines.push([ab, gd]); }
    if (drag) lines.push([drag.ab, { a: drag.a, p: drag.p }]);
    g.strokeStyle = "#00b7ff"; g.fillStyle = "#00b7ff"; g.font = "10px -apple-system, sans-serif";
    for (const [ab, gd] of lines) {
      const p = guideScreen(ab, gd); if (p == null) continue;
      const q = Math.round(p) + 0.5;
      g.beginPath();
      if (gd.a === "x") { g.moveTo(q, rulers ? RUL : 0); g.lineTo(q, H); } else { g.moveTo(rulers ? RUL : 0, q); g.lineTo(W, q); }
      g.stroke();
      if (drag && gd.a === drag.a && gd.p === drag.p) { g.fillText(String(Math.round(gd.p)), gd.a === "x" ? q + 4 : 26, gd.a === "x" ? 34 : q - 4); }
    }
  }
  function draw() { drawRulers(); drawGuides(); }

  // ---------- dragging guides ----------
  function startGuide(e, ab, a, existing) {
    drag = { ab, a, existing, p: existing ? existing.p : 0 };
    const mv = (ev) => {
      const r = abRect(ab.id), z = view().z;
      drag.p = Math.round(a === "x" ? (ev.clientX - r.left) / z : (ev.clientY - r.top) / z);
      draw();
    };
    const up = async (ev) => {
      removeEventListener("pointermove", mv); removeEventListener("pointerup", up);
      const v = vr(), onRuler = ev.clientX < v.left + RUL || ev.clientY < v.top + RUL || ev.clientX > v.right || ev.clientY > v.bottom || ev.clientX < v.left || ev.clientY < v.top;
      const d = drag; drag = null;
      const cur = (d.ab.guides || []).filter((x) => x !== d.existing);
      const guides = onRuler ? cur : [...cur, { a: d.a, p: d.p }];
      const same = !onRuler && d.existing && d.existing.p === d.p;
      if (!same) { try { await op("setGuides", { nodeId: d.ab.id, guides }); } catch {} }
      draw();
    };
    addEventListener("pointermove", mv); addEventListener("pointerup", up);
    mv(e);
  }
  rt.addEventListener("pointerdown", (e) => { e.preventDefault(); e.stopPropagation(); const ab = activeArtboard(); if (ab) startGuide(e, ab, "y", null); });
  rl.addEventListener("pointerdown", (e) => { e.preventDefault(); e.stopPropagation(); const ab = activeArtboard(); if (ab) startGuide(e, ab, "x", null); });
  rc.addEventListener("pointerdown", (e) => e.stopPropagation());

  // pointerdown on the canvas: grab an existing guide if the pointer is right on it. Returns true when a guide drag started.
  function pointerDown(e) {
    const v = vr();
    if (e.clientX < v.left || e.clientY < v.top || e.target.closest("#toolbar, .menu, #pop, .ruler")) return false;
    for (const ab of ctx.state.artboards) for (const g of ab.guides || []) {
      const p = guideScreen(ab, g); if (p == null) continue;
      const d = g.a === "x" ? Math.abs(e.clientX - (v.left + p)) : Math.abs(e.clientY - (v.top + p));
      if (d <= 3) { startGuide(e, ab, g.a, g); return true; }
    }
    return false;
  }
  // hover feedback: the cursor says a guide can be grabbed
  vp.addEventListener("pointermove", (e) => {
    if (drag) return;
    const v = vr(); let hit = null;
    for (const ab of ctx.state.artboards) for (const g of ab.guides || []) {
      const p = guideScreen(ab, g); if (p == null) continue;
      if ((g.a === "x" ? Math.abs(e.clientX - (v.left + p)) : Math.abs(e.clientY - (v.top + p))) <= 3) hit = g.a;
    }
    vp.style.cursor = hit ? (hit === "x" ? "col-resize" : "row-resize") : "";
  });

  // ---------- snapping ----------
  // screen positions of the guides of one artboard (for the drag snap list)
  function guideTargets(abId) {
    const ab = ctx.state.artboards.find((a) => a.id === abId); const out = { x: [], y: [] };
    if (!ab) return out;
    const v = vr();
    for (const g of ab.guides || []) { const p = guideScreen(ab, g); if (p != null) out[g.a].push(v[g.a === "x" ? "left" : "top"] + p); }
    return out;
  }
  // pull the left/right and top/bottom edges of a screen rect onto the artboard's grid; returns screen-pixel nudges
  function gridSnap(abId, rect, T = 6) {
    const ab = ctx.state.artboards.find((a) => a.id === abId);
    if (!ab || !ab.grid || !ab.grid.snap) return null;
    const r = abRect(abId); if (!r) return null;
    const z = view().z, s = ab.grid.size || 8;
    const pull = (a, b, o) => {
      let best = null;
      for (const v of [a, b]) { const u = (v - o) / z, t = Math.round(u / s) * s, d = (t - u) * z; if (Math.abs(d) <= T && (best === null || Math.abs(d) < Math.abs(best))) best = d; }
      return best;
    };
    return { dx: pull(rect.left, rect.right, r.left), dy: pull(rect.top, rect.bottom, r.top) };
  }

  // ---------- inspector: the artboard's grid ----------
  function gridControls(n) {
    const g = n.grid || { size: 8, show: false, snap: false };
    return `<div class="sec"><h4>Layout grid</h4><div class="grid2">
      <label class="chk full"><input type="checkbox" data-grid="show" ${g.show ? "checked" : ""}> Show grid</label>
      <div class="f"><label>Cell size</label><input type="number" min="2" max="400" data-grid="size" value="${g.size || 8}"></div>
      <label class="chk"><input type="checkbox" data-grid="snap" ${g.snap ? "checked" : ""}> Snap to grid</label>
    </div></div>`;
  }
  function wireGrid(n, root) {
    root.querySelectorAll("[data-grid]").forEach((el) => (el.onchange = () => {
      const g = { size: 8, show: false, snap: false, ...(n.grid || {}) };
      const k = el.dataset.grid;
      g[k] = k === "size" ? Math.max(2, Math.min(400, parseInt(el.value, 10) || 8)) : el.checked;
      if (k === "snap" && g.snap) g.show = true;
      op("setGrid", { nodeId: n.id, grid: g });
    }));
  }

  function setRulers(on) { rulers = on; try { localStorage.setItem("studio-rulers", on ? "on" : "off"); } catch {} draw(); }
  window.addEventListener("resize", draw);
  draw();
  return { draw, pointerDown, guideTargets, gridSnap, gridControls, wireGrid, setRulers, rulersOn: () => rulers, clearGuides: (abId) => op("setGuides", { nodeId: abId, guides: [] }), activeArtboard };
}
