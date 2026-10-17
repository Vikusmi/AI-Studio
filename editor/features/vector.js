// SVG path maths for the pen tool and point editing. Pure functions, no DOM: usable in the editor and in tests.
// A path is a list of subpaths: { closed, pts: [{ x, y, hin: {x,y}|null, hout: {x,y}|null }] }  (handles are absolute positions)

const NUM = /[-+]?(?:\d*\.\d+|\d+\.?)(?:[eE][-+]?\d+)?/g;
const r2 = (v) => Math.round(v * 100) / 100;

function arcToCubics(x0, y0, rx, ry, phiDeg, fa, fs, x, y) {
  if (rx === 0 || ry === 0 || (x0 === x && y0 === y)) return [];
  rx = Math.abs(rx); ry = Math.abs(ry);
  const phi = (phiDeg * Math.PI) / 180, cp = Math.cos(phi), sp = Math.sin(phi);
  const dx = (x0 - x) / 2, dy = (y0 - y) / 2;
  const x1 = cp * dx + sp * dy, y1 = -sp * dx + cp * dy;
  const lam = (x1 * x1) / (rx * rx) + (y1 * y1) / (ry * ry);
  if (lam > 1) { const s = Math.sqrt(lam); rx *= s; ry *= s; }
  const sign = fa === fs ? -1 : 1;
  const num = rx * rx * ry * ry - rx * rx * y1 * y1 - ry * ry * x1 * x1;
  const den = rx * rx * y1 * y1 + ry * ry * x1 * x1;
  const co = sign * Math.sqrt(Math.max(0, num / den));
  const cxp = (co * rx * y1) / ry, cyp = (-co * ry * x1) / rx;
  const cx = cp * cxp - sp * cyp + (x0 + x) / 2, cy = sp * cxp + cp * cyp + (y0 + y) / 2;
  const ang = (ux, uy, vx, vy) => { const a = Math.atan2(ux * vy - uy * vx, ux * vx + uy * vy); return a; };
  let th1 = ang(1, 0, (x1 - cxp) / rx, (y1 - cyp) / ry);
  let dth = ang((x1 - cxp) / rx, (y1 - cyp) / ry, (-x1 - cxp) / rx, (-y1 - cyp) / ry);
  if (!fs && dth > 0) dth -= 2 * Math.PI; else if (fs && dth < 0) dth += 2 * Math.PI;
  const n = Math.max(1, Math.ceil(Math.abs(dth) / (Math.PI / 2) - 1e-9)), step = dth / n, t = (4 / 3) * Math.tan(step / 4);
  const out = [];
  let a = th1;
  for (let i = 0; i < n; i++) {
    const a2 = a + step, c1 = Math.cos(a), s1 = Math.sin(a), c2 = Math.cos(a2), s2 = Math.sin(a2);
    const p = (ex, ey) => ({ x: cp * rx * ex - sp * ry * ey + cx, y: sp * rx * ex + cp * ry * ey + cy });
    out.push({ c1: p(c1 - t * s1, s1 + t * c1), c2: p(c2 + t * s2, s2 - t * c2), p: p(c2, s2) });
    a = a2;
  }
  return out;
}

// returns { subpaths, ok:boolean }: ok is false if the string couldn't be understood
export function parsePath(d) {
  const toks = String(d || "").match(/[a-zA-Z]|[-+]?(?:\d*\.\d+|\d+\.?)(?:[eE][-+]?\d+)?/g) || [];
  const subs = [];
  let i = 0, cmd = "", cx = 0, cy = 0, sx = 0, sy = 0, last = null, lastCmd = "", cur = null;
  const num = () => { const t = toks[i++]; if (t === undefined || /^[a-zA-Z]$/.test(t)) throw new Error("bad path"); return parseFloat(t); };
  const flag = () => { const t = toks[i]; if (t && /^[01]/.test(t) && t.length > 1) { toks[i] = t.slice(1); return +t[0]; } i++; return +t; };
  const start = (x, y) => { cur = { closed: false, pts: [{ x, y, hin: null, hout: null }] }; subs.push(cur); cx = sx = x; cy = sy = y; };
  const lineTo = (x, y) => { cur.pts.push({ x, y, hin: null, hout: null }); cx = x; cy = y; };
  const cubic = (c1, c2, p) => { const prev = cur.pts[cur.pts.length - 1]; prev.hout = c1; cur.pts.push({ x: p.x, y: p.y, hin: c2, hout: null }); cx = p.x; cy = p.y; last = c2; };
  try {
    while (i < toks.length) {
      if (/^[a-zA-Z]$/.test(toks[i])) cmd = toks[i++];
      else if (!cmd) throw new Error("bad path");
      const rel = cmd === cmd.toLowerCase(), C = cmd.toUpperCase();
      const ox = rel ? cx : 0, oy = rel ? cy : 0;
      if (C === "Z") { if (cur) cur.closed = true; cx = sx; cy = sy; lastCmd = "Z"; cmd = "Z"; if (i < toks.length && !/^[a-zA-Z]$/.test(toks[i])) throw new Error("bad path"); continue; }
      if (C === "M") { const x = num() + ox, y = num() + oy; start(x, y); cmd = rel ? "l" : "L"; lastCmd = "M"; continue; }
      if (!cur) { if (cx === 0 && cy === 0 && !subs.length) start(0, 0); else { start(cx, cy); } }
      if (cur && cur.closed) start(cx, cy);   // drawing after Z begins a new subpath at the start point
      if (C === "L") { lineTo(num() + ox, num() + oy); }
      else if (C === "H") { lineTo(num() + ox, cy); }
      else if (C === "V") { lineTo(cx, num() + oy); }
      else if (C === "C") { const c1 = { x: num() + ox, y: num() + oy }, c2 = { x: num() + ox, y: num() + oy }, p = { x: num() + ox, y: num() + oy }; cubic(c1, c2, p); }
      else if (C === "S") {
        const c1 = lastCmd === "C" || lastCmd === "S" ? { x: 2 * cx - last.x, y: 2 * cy - last.y } : { x: cx, y: cy };
        const c2 = { x: num() + ox, y: num() + oy }, p = { x: num() + ox, y: num() + oy }; cubic(c1, c2, p);
      } else if (C === "Q" || C === "T") {
        let q;
        if (C === "Q") q = { x: num() + ox, y: num() + oy };
        else q = lastCmd === "Q" || lastCmd === "T" ? { x: 2 * cx - last.x, y: 2 * cy - last.y } : { x: cx, y: cy };
        const p = { x: num() + ox, y: num() + oy };
        cubic({ x: cx + (2 / 3) * (q.x - cx), y: cy + (2 / 3) * (q.y - cy) }, { x: p.x + (2 / 3) * (q.x - p.x), y: p.y + (2 / 3) * (q.y - p.y) }, p);
        last = q;
      } else if (C === "A") {
        const rx = num(), ry = num(), rot = num(), fa = flag(), fs = flag(), x = num() + ox, y = num() + oy;
        const segs = arcToCubics(cx, cy, rx, ry, rot, fa, fs, x, y);
        if (!segs.length) lineTo(x, y); else for (const s of segs) cubic(s.c1, s.c2, s.p);
        lastCmd = "A"; continue;
      } else throw new Error("bad path");
      lastCmd = C;
    }
  } catch { return { subpaths: [], ok: false }; }
  // an explicit return to the start before Z is the same point: merge it
  for (const s of subs) {
    if (s.closed && s.pts.length > 2) {
      const a = s.pts[0], b = s.pts[s.pts.length - 1];
      if (Math.abs(a.x - b.x) < 1e-6 && Math.abs(a.y - b.y) < 1e-6) { if (b.hin) a.hin = b.hin; s.pts.pop(); }
    }
  }
  return { subpaths: subs, ok: subs.length > 0 };
}

const P = (p) => `${r2(p.x)} ${r2(p.y)}`;
function seg(a, b) {
  return a.hout || b.hin ? `C${P(a.hout || a)} ${P(b.hin || b)} ${P(b)}` : `L${P(b)}`;
}
export function serializePath(subpaths) {
  return subpaths.map((s) => {
    if (!s.pts.length) return "";
    let d = `M${P(s.pts[0])}`;
    for (let i = 1; i < s.pts.length; i++) d += seg(s.pts[i - 1], s.pts[i]);
    if (s.closed && s.pts.length > 1) {
      const a = s.pts[s.pts.length - 1], b = s.pts[0];
      if (a.hout || b.hin) d += seg(a, b);
      d += "Z";
    }
    return d;
  }).join("");
}

const cubicAt = (p0, p1, p2, p3, t) => { const u = 1 - t; return u * u * u * p0 + 3 * u * u * t * p1 + 3 * u * t * t * p2 + t * t * t * p3; };
export function bounds(subpaths) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  const add = (x, y) => { x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y); };
  for (const s of subpaths) {
    const n = s.pts.length;
    for (let i = 0; i < n; i++) {
      const a = s.pts[i]; add(a.x, a.y);
      const b = s.pts[i + 1] || (s.closed ? s.pts[0] : null);
      if (!b || (!a.hout && !b.hin)) continue;
      const c1 = a.hout || a, c2 = b.hin || b;
      for (let k = 1; k < 24; k++) { const t = k / 24; add(cubicAt(a.x, c1.x, c2.x, b.x, t), cubicAt(a.y, c1.y, c2.y, b.y, t)); }
    }
  }
  if (!isFinite(x0)) return { x: 0, y: 0, w: 0, h: 0 };
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}
export function translate(subpaths, dx, dy) {
  const m = (p) => (p ? { x: p.x + dx, y: p.y + dy } : null);
  return subpaths.map((s) => ({ closed: s.closed, pts: s.pts.map((a) => ({ x: a.x + dx, y: a.y + dy, hin: m(a.hin), hout: m(a.hout) })) }));
}
export const clone = (subpaths) => translate(subpaths, 0, 0);

// a self-contained svg for a finished pen path (points in the parent's coordinates)
export function buildSvg(subpaths, { fill = "none", stroke = "#161616", strokeWidth = 2 } = {}) {
  const pad = Math.ceil(strokeWidth / 2) + 1;
  const b = bounds(subpaths);
  const left = Math.floor(b.x) - pad, top = Math.floor(b.y) - pad;
  const w = Math.max(2, Math.ceil(b.w) + pad * 2), h = Math.max(2, Math.ceil(b.h) + pad * 2);
  const local = translate(subpaths, -left, -top);
  const raw = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}" width="${w}" height="${h}"><path d="${serializePath(local)}" fill="${fill}" stroke="${stroke}" stroke-width="${strokeWidth}" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
  return { raw, left, top, w, h };
}

const lerp = (a, b, t) => ({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });
const segOf = (sp, i) => { const a = sp.pts[i], b = sp.pts[i + 1] || (sp.closed ? sp.pts[0] : null); return b ? [a, b] : null; };
function pointOn(a, b, t) {
  if (!a.hout && !b.hin) return lerp(a, b, t);
  const c1 = a.hout || a, c2 = b.hin || b;
  return { x: cubicAt(a.x, c1.x, c2.x, b.x, t), y: cubicAt(a.y, c1.y, c2.y, b.y, t) };
}
// the point of the outline closest to (x, y): { s: subpath, i: segment (starts at anchor i), t: 0..1, dist }
export function nearestOnPath(subpaths, x, y) {
  let best = null;
  subpaths.forEach((sp, s) => {
    for (let i = 0; i < sp.pts.length; i++) {
      const g = segOf(sp, i); if (!g) continue;
      for (let k = 1; k < 40; k++) {
        const t = k / 40, q = pointOn(g[0], g[1], t), d = Math.hypot(q.x - x, q.y - y);
        if (!best || d < best.dist) best = { s, i, t, dist: d };
      }
    }
  });
  return best;
}
// insert an anchor on segment i at parameter t without changing the curve's shape (de Casteljau)
export function splitSegment(subpaths, s, i, t) {
  const out = clone(subpaths), sp = out[s], g = segOf(sp, i);
  if (!g) return out;
  const [a, b] = g;
  let m;
  if (!a.hout && !b.hin) m = { ...lerp(a, b, t), hin: null, hout: null };
  else {
    const p1 = a.hout || a, p2 = b.hin || b;
    const q0 = lerp(a, p1, t), q1 = lerp(p1, p2, t), q2 = lerp(p2, b, t), r0 = lerp(q0, q1, t), r1 = lerp(q1, q2, t), mm = lerp(r0, r1, t);
    a.hout = q0; b.hin = q2; m = { ...mm, hin: r0, hout: r1 };
  }
  sp.pts.splice(i + 1, 0, m);
  return out;
}
