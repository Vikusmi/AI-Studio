// Unit tests for the path maths (no browser).
import assert from "node:assert/strict";
import { parsePath, serializePath, bounds, translate, buildSvg, nearestOnPath, splitSegment } from "../editor/features/vector.js";
const ok = (m) => console.log("  ✓", m);
const near = (a, b, t = 0.05) => Math.abs(a - b) <= t;

// straight lines, relative commands, H/V, close
let r = parsePath("M10 10 h20 v20 h-20 z");
assert.ok(r.ok); assert.equal(r.subpaths.length, 1); assert.equal(r.subpaths[0].closed, true); assert.equal(r.subpaths[0].pts.length, 4);
assert.deepEqual(r.subpaths[0].pts.map((p) => [p.x, p.y]), [[10, 10], [30, 10], [30, 30], [10, 30]]);
assert.equal(serializePath(r.subpaths), "M10 10L30 10L30 30L10 30Z"); ok("lines: absolute / relative / H / V / Z");

// explicit return to the start before Z is merged
r = parsePath("M0 0 L10 0 L10 10 L0 0 Z"); assert.equal(r.subpaths[0].pts.length, 3); ok("a closing line back to the start is the same point");

// cubic, smooth cubic, handles are absolute
r = parsePath("M0 0 C10 0 20 10 20 20 S30 40 40 40");
const p = r.subpaths[0].pts; assert.equal(p.length, 3);
assert.deepEqual(p[0].hout, { x: 10, y: 0 }); assert.deepEqual(p[1].hin, { x: 20, y: 10 }); assert.deepEqual(p[1].hout, { x: 20, y: 30 }); assert.deepEqual(p[2].hin, { x: 30, y: 40 });
ok("cubic and smooth-cubic (S reflects the previous handle)");

// quadratics become cubics with the same shape
r = parsePath("M0 0 Q10 20 20 0"); const q = r.subpaths[0].pts;
assert.ok(near(q[0].hout.x, 6.67, 0.01) && near(q[0].hout.y, 13.33, 0.01) && near(q[1].hin.x, 13.33, 0.01)); ok("quadratic curves are converted to cubics");

// a circle drawn with two arcs: bounds are the circle's, in four cubic segments or more
r = parsePath("M50 0 A50 50 0 1 1 50 100 A50 50 0 1 1 50 0 Z");
assert.ok(r.ok); const b = bounds(r.subpaths);
assert.ok(near(b.x, 0, 0.6) && near(b.y, 0, 0.6) && near(b.w, 100, 1) && near(b.h, 100, 1), JSON.stringify(b)); ok("arcs: a circle keeps its size (bounds ≈ 0,0,100,100)");
r = parsePath("M10 80 A25 25 0 0 0 60 80"); assert.ok(r.ok && r.subpaths[0].pts.length >= 3); const hb = bounds(r.subpaths); assert.ok(near(hb.h, 25, 0.5), "half circle height " + hb.h); ok("arc flags (large-arc / sweep) pick the right half");

// round trip is stable
const d = "M12 2C6.5 2 2 6.5 2 12s4.5 10 10 10 10-4.5 10-10S17.5 2 12 2zm0 4a1 1 0 100 2 1 1 0 000-2z";
r = parsePath(d); assert.ok(r.ok); assert.equal(r.subpaths.length, 2);
const again = parsePath(serializePath(r.subpaths)); assert.equal(JSON.stringify(bounds(again.subpaths)), JSON.stringify(bounds(r.subpaths))); ok("a real icon path (relative curves, arcs, multiple subpaths) survives parse → serialize → parse");
assert.equal(parsePath("M 1 2 foo").ok, false); assert.equal(parsePath("").ok, false); ok("garbage is rejected, not half-parsed");

// translate + buildSvg (pen output)
const tri = [{ closed: true, pts: [{ x: 100, y: 100, hin: null, hout: null }, { x: 160, y: 100, hin: null, hout: null }, { x: 130, y: 150, hin: null, hout: null }] }];
const out = buildSvg(tri, { fill: "#d9d9d9", stroke: "#111", strokeWidth: 2 });
assert.equal(out.left, 98); assert.equal(out.top, 98); assert.equal(out.w, 64); assert.equal(out.h, 54);
assert.match(out.raw, /viewBox="0 0 64 54"/); assert.match(out.raw, /d="M2 2L62 2L32 52Z"/); ok("pen output: the svg is cut to the shape (plus stroke padding) and positioned by left/top");
assert.deepEqual(translate(tri, 5, -5)[0].pts[0], { x: 105, y: 95, hin: null, hout: null }); ok("translate");
// double-click on the outline: nearest point + splitting keeps the shape
const curve = parsePath("M0 0 C0 50 100 50 100 0").subpaths;
const hit = nearestOnPath(curve, 50, 37); assert.ok(hit.dist < 2, "nearest point on the curve: " + JSON.stringify(hit));
const split = splitSegment(curve, hit.s, hit.i, hit.t);
assert.equal(split[0].pts.length, 3);
const b1 = bounds(curve), b2 = bounds(split); assert.ok(near(b1.h, b2.h, 0.1) && near(b1.w, b2.w, 0.1), "the curve is unchanged: " + JSON.stringify([b1, b2]));
const line = splitSegment(parsePath("M0 0 L100 0").subpaths, 0, 0, 0.25); assert.deepEqual([line[0].pts[1].x, line[0].pts[1].y], [25, 0]); ok("adding a point on the outline (curve and line) keeps the shape");
const closed = parsePath("M0 0 L100 0 L100 100 Z").subpaths; const cs = splitSegment(closed, 0, 2, 0.5); assert.equal(cs[0].pts.length, 4); assert.deepEqual([cs[0].pts[3].x, cs[0].pts[3].y], [50, 50]); ok("the closing segment can be split too");
console.log("\nVECTOR TESTS PASSED");
