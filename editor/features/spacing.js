// Smart spacing guides: while a layer is dragged, pull it to positions where the gaps to its neighbours are equal,
// or equal to a gap that already exists between two other layers. Pure geometry: rects are { l, t, r, b } in any one unit.

const axes = {
  x: { lo: "l", hi: "r", clo: "t", chi: "b" },
  y: { lo: "t", hi: "b", clo: "l", chi: "r" },
};
const overlap = (a, b, k) => Math.min(a[k.chi], b[k.chi]) - Math.max(a[k.clo], b[k.clo]);

// r: the moving rect at its proposed spot. others: the rects it can relate to. T: how far (in the same unit) a snap may pull.
// returns null, or { shift, gaps: [{ from, to, size, ref? }] } where gaps are the spans to draw (from..to along the axis, at the cross position `at`)
export function spacingSnap(r, others, axis, T = 6) {
  const k = axes[axis];
  const row = others.filter((o) => overlap(r, o, k) > 1).sort((a, b) => a[k.lo] - b[k.lo]);
  if (row.length < 1) return null;
  const before = row.filter((o) => o[k.hi] <= r[k.lo] + 0.5), after = row.filter((o) => o[k.lo] >= r[k.hi] - 0.5);
  const L = before.length ? before.reduce((a, b) => (b[k.hi] > a[k.hi] ? b : a)) : null;
  const R = after.length ? after.reduce((a, b) => (b[k.lo] < a[k.lo] ? b : a)) : null;
  // gaps that already exist between neighbouring rects of the row
  const refs = [];
  for (let i = 0; i + 1 < row.length; i++) { const g = row[i + 1][k.lo] - row[i][k.hi]; if (g >= 1) refs.push({ size: g, a: row[i], b: row[i + 1] }); }
  const cands = [];
  if (L && R) { const gl = r[k.lo] - L[k.hi], gr = R[k.lo] - r[k.hi], shift = (gr - gl) / 2; if (Math.abs(shift) <= T && gl + shift >= 1) cands.push({ shift, equal: true }); }
  for (const g of refs) {
    if (L) { const shift = L[k.hi] + g.size - r[k.lo]; if (Math.abs(shift) <= T && g.a !== L) cands.push({ shift, ref: g }); }
    if (R) { const shift = R[k.lo] - g.size - r[k.hi]; if (Math.abs(shift) <= T && g.b !== R) cands.push({ shift, ref: g, right: true }); }
  }
  if (!cands.length) return null;
  const best = cands.reduce((a, b) => (Math.abs(b.shift) < Math.abs(a.shift) ? b : a));
  const lo = r[k.lo] + best.shift, hi = r[k.hi] + best.shift;
  const gaps = [];
  const mid = (a) => (Math.max(r[k.clo], a[k.clo]) + Math.min(r[k.chi], a[k.chi])) / 2;
  if (L && (best.equal || !best.right)) gaps.push({ from: L[k.hi], to: lo, size: lo - L[k.hi], at: mid(L) });
  if (R && (best.equal || best.right)) gaps.push({ from: hi, to: R[k.lo], size: R[k.lo] - hi, at: mid(R) });
  if (best.ref) gaps.push({ from: best.ref.a[k.hi], to: best.ref.b[k.lo], size: best.ref.size, at: (best.ref.a[k.clo] + best.ref.a[k.chi]) / 2, ref: true });
  return { shift: best.shift, gaps };
}
