// Cutting a rendered block into image slices so that every link stays a real link in an email.
// Image maps are unreliable (Gmail drops them), so the picture is cut into rows and cells and each link gets its own <a><img>.
const merge = (iv) => { iv.sort((a, b) => a[0] - b[0]); const out = []; for (const x of iv) { const l = out[out.length - 1]; if (l && x[0] <= l[1]) l[1] = Math.max(l[1], x[1]); else out.push([...x]); } return out; };

// links: [{x,y,w,h,href}] in css px relative to the block; returns rows: [{y,h,cells:[{x,w,href?}]}]
export function planSlices(W, H, links) {
  W = Math.round(W); H = Math.round(H);
  const ls = links.map((l) => ({ href: l.href, x0: Math.max(0, Math.floor(l.x)), y0: Math.max(0, Math.floor(l.y)), x1: Math.min(W, Math.ceil(l.x + l.w)), y1: Math.min(H, Math.ceil(l.y + l.h)) }))
    .filter((l) => l.x1 - l.x0 >= 4 && l.y1 - l.y0 >= 4 && l.href && !/^#/.test(l.href));
  const bands = merge(ls.map((l) => [l.y0, l.y1]));
  const rows = [];
  let y = 0;
  const full = (y0, y1) => { if (y1 - y0 >= 1) rows.push({ y: y0, h: y1 - y0, cells: [{ x: 0, w: W }] }); };
  for (const b of bands) {
    full(y, b[0]);
    const inBand = ls.filter((l) => l.y0 < b[1] && l.y1 > b[0]).sort((a, c) => a.x0 - c.x0);
    // overlapping links in one band: the first wins
    const cols = []; let x = 0;
    for (const l of inBand) {
      if (l.x0 < x) continue;
      if (l.x0 > x) cols.push({ x, w: l.x0 - x });
      cols.push({ x: l.x0, w: l.x1 - l.x0, href: l.href }); x = l.x1;
    }
    if (x < W) cols.push({ x, w: W - x });
    rows.push({ y: b[0], h: b[1] - b[0], cells: cols });
    y = b[1];
  }
  full(y, H);
  return rows;
}
