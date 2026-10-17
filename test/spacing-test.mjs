// Unit tests for the smart spacing guides (no browser).
import assert from "node:assert/strict";
import { spacingSnap } from "../editor/features/spacing.js";
const ok = (m) => console.log("  ✓", m);
const R = (l, t, w, h) => ({ l, t, r: l + w, b: t + h });

// moving box sits 3px off the middle of two neighbours: snap makes both gaps equal
let a = R(0, 0, 100, 50), b = R(300, 0, 100, 50), m = R(153, 0, 90, 50);   // gaps: 53 and 57
let s = spacingSnap(m, [a, b], "x");
assert.ok(s && Math.abs(s.shift - 2) < 1e-9, JSON.stringify(s)); assert.equal(s.gaps.length, 2); assert.equal(s.gaps[0].size, s.gaps[1].size); ok("centred between two neighbours: equal gaps (53/57 → 55/55)");
// too far: no snap
assert.equal(spacingSnap(R(170, 0, 90, 50), [a, b], "x"), null); ok("no snap when it is further than the tolerance");
// matching an existing gap between two other boxes (gap 40), pulling the mover to the same distance from its neighbour
a = R(0, 0, 60, 50); b = R(100, 0, 60, 50);   // existing gap 40
m = R(203, 0, 50, 50);                        // gap to b is 43
s = spacingSnap(m, [a, b], "x");
assert.ok(s && Math.abs(s.shift - -3) < 1e-9, JSON.stringify(s)); assert.ok(s.gaps.some((g) => g.ref), "the reference gap is shown too"); assert.equal(s.gaps.find((g) => !g.ref).size, 40); ok("matches the gap that already exists between two other layers (43 → 40)");
// only layers in the same row (they must overlap on the other axis) count
assert.equal(spacingSnap(R(103, 200, 50, 50), [R(0, 0, 100, 50), R(300, 0, 100, 50)], "x"), null); ok("layers in other rows are ignored");
// vertical works the same
s = spacingSnap(R(0, 153, 50, 90), [R(0, 0, 50, 100), R(0, 300, 50, 100)], "y");
assert.ok(s && Math.abs(s.shift - 2) < 1e-9); ok("vertical spacing");
// a single neighbour and nothing to compare with: nothing
assert.equal(spacingSnap(R(110, 0, 50, 50), [R(0, 0, 100, 50)], "x"), null); ok("one neighbour alone has no equal-spacing target");
console.log("\nSPACING TESTS PASSED");
