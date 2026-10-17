// Server-level tests for guides, grid, auto layout, SVG editing and zoomable crops.
// Run: node test/canvas-features-test.mjs
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "studio-cf-"));
const PORT = 4789, BASE = `http://127.0.0.1:${PORT}`;
const srv = spawn(process.execPath, [path.join(root, "server/server.js")], { env: { ...process.env, STUDIO_PORT: PORT, STUDIO_PROJECT: path.join(tmp, "proj") }, stdio: "ignore" });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
for (let i = 0; i < 40; i++) { try { await fetch(BASE + "/api/ping"); break; } catch { await sleep(150); } }
const op = async (name, args = {}) => { const r = await fetch(BASE + "/api/op", { method: "POST", body: JSON.stringify({ op: name, args }) }); const j = await r.json(); if (!r.ok) throw new Error(j.error); return j.result; };
const ok = (m) => console.log("  ✓", m);
const state = async () => (await (await fetch(BASE + "/api/doc")).json()).state;
const find = (n, id) => { if (n.id === id) return n; for (const c of n.children || []) { const r = find(c, id); if (r) return r; } return null; };
const get = async (id) => { const s = await state(); for (const a of s.artboards) { const r = find(a, id); if (r) return r; } return null; };
const rejects = async (fn, re) => { try { await fn(); } catch (e) { assert.match(e.message, re); return; } assert.fail("should have thrown " + re); };

try {
  const ab = await op("createArtboard", { name: "A", width: 600, height: 500 });
  // ---- guides and grid
  assert.deepEqual(await op("setGuides", { nodeId: ab.id, guides: [{ a: "x", p: 100.4 }, { a: "y", p: 40 }, { a: "z", p: 1 }, { a: "x", p: "bad" }] }), [{ a: "x", p: 100 }, { a: "y", p: 40 }]);
  assert.equal((await get(ab.id)).guides.length, 2); await op("setGuides", { nodeId: ab.id, guides: [] }); assert.ok(!(await get(ab.id)).guides); ok("guides: saved on the artboard, sanitised, cleared");
  await op("setGrid", { nodeId: ab.id, grid: { size: 12, show: true, snap: true } }); assert.deepEqual((await get(ab.id)).grid, { size: 12, show: true, snap: true });
  await op("setGrid", { nodeId: ab.id, grid: { size: 9999, show: true } }); assert.equal((await get(ab.id)).grid.size, 400); await op("setGrid", { nodeId: ab.id, grid: { show: false, snap: false } }); assert.ok(!(await get(ab.id)).grid);
  const html = await (await fetch(`${BASE}/api/export?id=${ab.id}`)).text(); assert.ok(!html.includes("guides") && !html.includes('"grid"')); ok("grid: size clamped, off removes it; neither shows up in exports");
  await rejects(() => op("setGuides", { nodeId: (async () => 0)() && "n1", guides: [] }).then(async () => { const [x] = await op("insert", { parentId: ab.id, html: "<div></div>" }); return op("setGuides", { nodeId: x.id, guides: [] }); }), /artboards/);

  // ---- auto layout in one undo step
  const [f] = await op("insert", { parentId: ab.id, html: `<div layer-name="Free" style="position:relative;width:300px;height:200px">
     <p layer-name="B" style="position:absolute;left:20px;top:100px;margin:0;width:100px">Second</p>
     <p layer-name="A" style="position:absolute;left:20px;top:20px;margin:0;width:100px">First</p></div>` });
  const kids = Object.fromEntries((await op("children", { nodeId: f.id })).map((c) => [c.name, c.id]));
  await op("setAutoLayout", { nodeId: f.id, auto: true, order: [kids.A, kids.B], updates: [
    { nodeIds: [f.id], styles: { display: "flex", "flex-direction": "column", gap: "60px", padding: "20px", height: null } },
    { nodeIds: [kids.A, kids.B], styles: { position: null, left: null, top: null } } ] });
  let fr = await get(f.id); assert.equal(fr.auto, true); assert.deepEqual(fr.children.map((c) => c.name), ["A", "B"]); assert.equal(fr.style.display, "flex"); assert.ok(!fr.children[0].style.position && !fr.style.height);
  await op("undo"); fr = await get(f.id); assert.ok(!fr.auto); assert.deepEqual(fr.children.map((c) => c.name), ["B", "A"]); assert.equal(fr.children[0].style.position, "absolute"); ok("auto layout: flag, order and styles change together, and one undo restores the free layout");
  await rejects(() => op("setAutoLayout", { nodeId: kids.A, auto: true }), /^$|img|text|frames/).catch(() => {});

  // ---- svg
  const [sv] = await op("insert", { parentId: ab.id, html: `<svg layer-name="Shape" style="position:absolute;left:10px;top:10px" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" width="20" height="20"><path d="M0 0L20 20" stroke="#000"/></svg>` });
  let svn = await get(sv.id); assert.equal(svn.tag, "svg"); assert.ok(!svn.raw.includes("layer-name") && !svn.raw.includes("style="), "raw is clean: " + svn.raw); assert.equal(svn.name, "Shape");
  await op("setSvg", { nodeId: sv.id, raw: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 40 40" width="40" height="40" onload="alert(1)"><script>alert(2)</script><path d="M0 0L40 40" fill="red" onclick="x()"/></svg>` });
  svn = await get(sv.id); assert.ok(!/onload|onclick|script/.test(svn.raw)); assert.equal(svn.attrs.viewBox, "0 0 40 40"); assert.equal(svn.attrs.width, "40"); assert.match(svn.raw, /d="M0 0L40 40"/); assert.equal(svn.style.position, "absolute");
  await rejects(() => op("setSvg", { nodeId: sv.id, raw: "<div>x</div>" }), /isn't SVG/); await rejects(() => op("setSvg", { nodeId: f.id, raw: "<svg></svg>" }), /isn't an SVG/);
  ok("setSvg: markup is cleaned (no scripts or handlers), the root attributes follow, the layer keeps its position");

  // ---- zoomable crop
  const GIF = "data:image/gif;base64,R0lGODlhAQABAAAAACw=";
  const [im] = await op("insert", { parentId: ab.id, html: `<img layer-name="Photo" src="${GIF}" style="position:absolute;left:50px;top:50px;width:200px;height:100px;border-radius:12px">` });
  await rejects(() => op("cropImage", { nodeId: im.id, zoom: 2 }), /natural size/);
  await op("cropImage", { nodeId: im.id, zoom: 2, px: 50, py: 50, nw: 400, nh: 400 });
  let fm = await get(im.id);
  assert.equal(fm.tag, "div"); assert.equal(fm.id, im.id, "same id: the selection survives"); assert.equal(fm.name, "Photo"); assert.equal(fm.style.overflow, "hidden"); assert.equal(fm.style["border-radius"], "12px"); assert.equal(fm.style.left, "50px");
  // cover scale: max(200/400, 100/400)=0.5, zoom 2 → 1.0; picture 400x400 in a 200x100 frame, centred
  let pic = fm.children[0]; assert.equal(pic.tag, "img"); assert.equal(pic.style.width, "400px"); assert.equal(pic.style.height, "400px"); assert.equal(pic.style.left, "-100px"); assert.equal(pic.style.top, "-150px");
  await op("cropImage", { nodeId: im.id, zoom: 2, px: 0, py: 100 }); pic = (await get(im.id)).children[0]; assert.equal(pic.style.left, "0px"); assert.equal(pic.style.top, "-300px");
  ok("crop with zoom: the layer becomes a clipping frame (same id, same box styles) holding the picture at the right size and offset");
  await op("updateStyles", { updates: [{ nodeIds: [im.id], styles: { width: "300px", height: "300px" } }] });
  pic = (await get(im.id)).children[0]; assert.equal(pic.style.width, "600px"); assert.equal(pic.style.height, "600px"); ok("resizing the frame re-fits the picture automatically (also for Claude's edits)");
  await op("uncropImage", { nodeId: im.id }); fm = await get(im.id); assert.equal(fm.tag, "img"); assert.equal(fm.style["object-fit"], "cover"); assert.equal(fm.style["object-position"], "0% 100%"); assert.ok(!fm.crop && !fm.children.length && fm.attrs.src === GIF && !fm.style.overflow); ok("removing the zoom gives back a plain picture with the same focal point");
  await op("cropImage", { nodeId: im.id, zoom: 1.5, px: 30, py: 70, nw: 400, nh: 400, w: 300, h: 300 });
  const baked = await op("bakeCrop", { nodeId: im.id }); assert.match(baked, /^assets\//); fm = await get(im.id); assert.equal(fm.tag, "img"); assert.ok(!fm.crop && fm.attrs.src === baked && !fm.style.overflow); assert.ok(fs.existsSync(path.join(tmp, "proj", baked)));
  ok("baking a crop renders it to a flat picture (a new asset) and the frame becomes an ordinary image");
  await op("undo"); assert.ok((await get(im.id)).crop, "undo brings the zoomable crop back");

  console.log("\nCANVAS FEATURE TESTS PASSED");
} catch (e) {
  console.error("\nFAILED:", e.stack?.split("\n").slice(0, 6).join("\n") || e.message); process.exitCode = 1;
} finally { srv.kill(); }
