// Ninth editor suite: rulers + guides, layout grid, equal-spacing guides, auto layout, rotation, zoomable crop, pen tool + point editing.
// Run: node test/editor9-test.mjs
import puppeteer from "puppeteer-core";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "studio-ed9-"));
const PORT = 4790, BASE = `http://127.0.0.1:${PORT}`;
const srv = spawn(process.execPath, [path.join(root, "server/server.js")], { env: { ...process.env, STUDIO_PORT: PORT, STUDIO_PROJECT: path.join(tmp, "proj") }, stdio: "ignore" });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
for (let i = 0; i < 40; i++) { try { await fetch(BASE + "/api/ping"); break; } catch { await sleep(150); } }
const op = async (name, args = {}) => { const r = await fetch(BASE + "/api/op", { method: "POST", body: JSON.stringify({ op: name, args }) }); const j = await r.json(); if (!r.ok) throw new Error(j.error); return j.result; };
const ok = (m) => console.log("  ✓", m);
const CHROME = ["/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge"].find(fs.existsSync);
const browser = await puppeteer.launch({ executablePath: CHROME, headless: true, defaultViewport: { width: 1500, height: 950 } });
const page = await browser.newPage();
const errors = [];
page.on("pageerror", (e) => errors.push(e.message));
page.on("console", (m) => m.type() === "error" && !/fonts\.g|net::ERR/.test(m.text()) && errors.push(m.text()));
const byId = (id) => `[data-id="${id}"]`;
const rectOf = (id) => page.$eval(byId(id), (e) => { const b = e.getBoundingClientRect(); return { x: b.x, y: b.y, w: b.width, h: b.height }; });
const center = async (id) => { const r = await rectOf(id); return [r.x + r.w / 2, r.y + r.h / 2]; };
const state = async () => (await (await fetch(BASE + "/api/doc")).json()).state;
const find = (n, id) => { if (n.id === id) return n; for (const c of n.children || []) { const r = find(c, id); if (r) return r; } return null; };
const getNode = async (id) => { const s = await state(); for (const a of s.artboards) { const r = find(a, id); if (r) return r; } return null; };
const near = (a, b, t = 1.5) => Math.abs(a - b) <= t;
const zoomOf = async () => (await page.evaluate(() => JSON.parse(localStorage.getItem("studio-view")))).z;
const hold = async (key, fn) => { await page.keyboard.down(key); await fn(); await page.keyboard.up(key); };
const dragBy = async ([x, y], dx, dy, steps = 8) => { await page.mouse.move(x, y); await page.mouse.down(); await page.mouse.move(x + 6, y + 4, { steps: 2 }); await page.mouse.move(x + dx, y + dy, { steps }); };

try {
  await page.goto(BASE + "/#/edit");
  const ab = await op("createArtboard", { name: "Canvas", width: 700, height: 560, style: { "background-color": "#ffffff", position: "relative" } });
  const [free] = await op("insert", { parentId: ab.id, html: `
   <div layer-name="Boxes" style="position:absolute;left:20px;top:20px;width:260px;height:240px;background-color:#f0f0f0">
     <div layer-name="A" style="position:absolute;left:10px;top:10px;width:70px;height:40px;background-color:#0d8cff"></div>
     <div layer-name="B" style="position:absolute;left:10px;top:90px;width:70px;height:40px;background-color:#ff4f1f"></div>
     <div layer-name="C" style="position:absolute;left:10px;top:170px;width:70px;height:40px;background-color:#3a3"></div>
   </div>
   <div layer-name="Row" style="position:absolute;left:320px;top:30px;width:330px;height:60px">
     <div layer-name="R1" style="position:absolute;left:0;top:0;width:60px;height:60px;background-color:#222"></div>
     <div layer-name="R2" style="position:absolute;left:100px;top:0;width:60px;height:60px;background-color:#444"></div>
     <div layer-name="R3" style="position:absolute;left:240px;top:0;width:60px;height:60px;background-color:#888"></div>
   </div>
   <div layer-name="Mover" style="position:absolute;left:330px;top:150px;width:60px;height:60px;background-color:#c0ffee"></div>` });
  await page.waitForSelector(".abw"); await sleep(400);
  const top = Object.fromEntries((await op("children", { nodeId: ab.id })).map((c) => [c.name, c.id]));
  const inner = async (parent) => Object.fromEntries((await op("children", { nodeId: parent })).map((c) => [c.name, c.id]));
  await page.click("#btn-fit"); await sleep(250);

  // ---------- rulers + guides ----------
  assert.equal(await page.$eval(".ruler-t", (e) => e.hidden), true, "rulers are off by default");
  await page.keyboard.down("Meta"); await page.keyboard.down("Shift"); await page.keyboard.press("r"); await page.keyboard.up("Shift"); await page.keyboard.up("Meta"); await sleep(250);
  assert.equal(await page.$eval(".ruler-t", (e) => e.hidden), false); assert.equal(await page.$eval(".ruler-t", (e) => Math.round(e.getBoundingClientRect().height)), 20);
  assert.ok(await page.$eval(".ruler-t canvas", (c) => { const d = c.getContext("2d").getImageData(0, 0, c.width, c.height).data; for (let i = 0; i < d.length; i += 4) if (d[i] < 200) return true; return false; }), "ticks are drawn");
  ok("⇧⌘R shows rulers with tick marks along the top and left");
  const z = await zoomOf(), abr = await rectOf(ab.id);
  const vpR = await page.$eval("#viewport", (e) => { const b = e.getBoundingClientRect(); return { x: b.x, y: b.y }; });
  // drag a guide from the top ruler to y = 300 (artboard coordinates)
  const gy = abr.y + 300 * z;
  await page.mouse.move(abr.x + 100, vpR.y + 10); await page.mouse.down(); await page.mouse.move(abr.x + 100, gy, { steps: 8 }); await page.mouse.up(); await sleep(400);
  let g = (await getNode(ab.id)).guides; assert.deepEqual(g, [{ a: "y", p: 300 }], JSON.stringify(g));
  await page.mouse.move(vpR.x + 10, abr.y + 100); await page.mouse.down(); await page.mouse.move(abr.x + 500 * z, abr.y + 100, { steps: 8 }); await page.mouse.up(); await sleep(400);
  g = (await getNode(ab.id)).guides; assert.equal(g.length, 2); assert.ok(g.some((x) => x.a === "x" && Math.abs(x.p - 500) <= 1), JSON.stringify(g));
  ok("dragging from a ruler drops a guide; it is saved on the artboard");
  // snapping to the guide: drag Mover so its bottom approaches y=300
  const mv = await rectOf(top.Mover);
  await page.mouse.click(abr.x - 30, abr.y - 30); await sleep(100);
  await hold("Alt", async () => {}); // no-op, keeps focus
  await dragBy([mv.x + mv.w / 2, mv.y + mv.h / 2], 0, (300 - 210) * z + 3);
  assert.ok(await page.$$eval("#overlay .guide", (x) => x.length) >= 1, "a snap guide is shown");
  await page.mouse.up(); await sleep(450);
  const m1 = await getNode(top.Mover); assert.equal(parseInt(m1.style.top) + 60, 300, "the layer's bottom edge snapped onto the guide: top " + m1.style.top);
  ok("layers snap to guides");
  // drag the guide back into the ruler: it is removed
  const gScreen = abr.y + 300 * z;
  await page.mouse.move(abr.x + 640 * z, gScreen); await page.mouse.down(); await page.mouse.move(abr.x + 640 * z, vpR.y + 8, { steps: 8 }); await page.mouse.up(); await sleep(400);
  g = (await getNode(ab.id)).guides; assert.deepEqual(g.map((x) => x.a), ["x"]); ok("dragging a guide back onto the ruler deletes it");
  await page.click("#zoom-label"); await sleep(120);
  await page.evaluate(() => [...document.querySelectorAll("#ctx .mi")].find((b) => b.firstChild.textContent === "Clear guides").click()); await sleep(400);
  assert.ok(!(await getNode(ab.id)).guides); ok("View → Clear guides");
  await op("setGuides", { nodeId: ab.id, guides: [] }); await op("updateStyles", { updates: [{ nodeIds: [top.Mover], styles: { left: "330px", top: "150px" } }] }); await sleep(300); // a clean slate for the next tests
  await page.keyboard.down("Meta"); await page.keyboard.down("Shift"); await page.keyboard.press("r"); await page.keyboard.up("Shift"); await page.keyboard.up("Meta"); await sleep(200);
  assert.equal(await page.$eval(".ruler-t", (e) => e.hidden), true);

  // ---------- layout grid ----------
  await page.click(`.ab-title`); await sleep(250);
  assert.ok(await page.$('[data-grid="size"]'), "artboards have a Layout grid section");
  await page.$eval('[data-grid="size"]', (e) => { e.value = "20"; e.dispatchEvent(new Event("change")); }); await sleep(300);
  await page.$eval('[data-grid="snap"]', (e) => { e.click(); }); await sleep(400);
  assert.deepEqual((await getNode(ab.id)).grid, { size: 20, show: true, snap: true });
  assert.ok(await page.$eval(".guide-layer canvas", (c) => { const d = c.getContext("2d").getImageData(0, 0, c.width, c.height).data; for (let i = 3; i < d.length; i += 4) if (d[i] > 0) return true; return false; }), "the grid is drawn");
  const mv2 = await rectOf(top.Mover);
  await page.mouse.click(abr.x - 30, abr.y - 30);
  await dragBy([mv2.x + mv2.w / 2, mv2.y + mv2.h / 2], 33 * z, 28 * z); await page.mouse.up(); await sleep(450);
  const m2 = await getNode(top.Mover); const L = parseInt(m2.style.left), T = parseInt(m2.style.top);
  assert.ok(L % 20 === 0 || (L + 60) % 20 === 0, "left snapped to the grid: " + L); assert.ok(T % 20 === 0 || (T + 60) % 20 === 0, "top snapped to the grid: " + T);
  ok("the layout grid is drawn and layers snap to its lines (Snap to grid)");
  await op("undo"); await sleep(250);
  await op("setGrid", { nodeId: ab.id, grid: { show: false, snap: false } }); await sleep(200);

  // ---------- equal spacing ----------
  const rows = await inner(top.Row);
  const r1 = await rectOf(rows.R1), r3 = await rectOf(rows.R3);
  // R2 sits 40px right of R1 and 80 left of R3 (canvas units). Drag it to the middle (gaps equal) from 3px off
  await page.mouse.click(abr.x - 30, abr.y - 30);
  const r2 = await rectOf(rows.R2);
  const targetLeft = (r1.x + r1.w + r3.x) / 2 - r2.w / 2;               // exactly equal gaps
  await dragBy([r2.x + r2.w / 2, r2.y + r2.h / 2], targetLeft - r2.x + 3, 0);
  const labels = await page.$$eval("#overlay .dist-label", (x) => x.map((e) => e.textContent));
  assert.ok(labels.length >= 2 && labels[0] === labels[1], "two equal gap labels while dragging: " + labels);
  await page.mouse.up(); await sleep(450);
  const gapA = parseInt((await getNode(rows.R2)).style.left) - 60, gapB = 240 - (parseInt((await getNode(rows.R2)).style.left) + 60);
  assert.ok(Math.abs(gapA - gapB) <= 1, `gaps are equal after the drop: ${gapA} / ${gapB}`);
  ok("equal-spacing guides: the layer snaps to the middle of its neighbours and the matching gaps are labelled");
  await op("undo"); await sleep(250);

  // ---------- auto layout ----------
  const ids = await inner(top.Boxes);
  const before = { A: await rectOf(ids.A), B: await rectOf(ids.B), C: await rectOf(ids.C) };
  await page.mouse.click(abr.x - 30, abr.y - 30);
  await page.click(byId(top.Boxes)).catch(() => {});
  await page.mouse.click(before.A.x + before.A.w + 60 * z, before.A.y + 5); await sleep(250);   // the frame's own area
  assert.ok(await page.$("[data-autolayout]"), "frames have an Auto layout switch");
  await page.click("[data-autolayout]"); await sleep(600);
  let bx = await getNode(top.Boxes); assert.equal(bx.auto, true); assert.equal(bx.style.display, "flex"); assert.equal(bx.style["flex-direction"], "column"); assert.deepEqual(bx.children.map((c) => c.name), ["A", "B", "C"]);
  assert.ok(bx.children.every((c) => !c.style.position && !c.style.left), "children are in the flow now"); assert.ok(!bx.style.height, "the frame hugs its content");
  assert.match(bx.style.gap, /^(40|39|41)px$/, "gap measured from the layout: " + bx.style.gap);
  const after = { A: await rectOf(ids.A), B: await rectOf(ids.B), C: await rectOf(ids.C) };
  for (const k of ["A", "B", "C"]) assert.ok(near(after[k].x, before[k].x, 2) && near(after[k].y, before[k].y, 2.5), `${k} stays where it was: ${before[k].x},${before[k].y} → ${after[k].x},${after[k].y}`);
  ok("Add auto layout: the free arrangement becomes a column with the same gap and padding, layers keep their place");
  // dragging inside an auto-layout frame reorders (a drop line shows), it doesn't free-move
  const cC = await center(ids.C);
  await dragBy(cC, 0, -(80 * z) - 20, 10);
  assert.ok(await page.$("#overlay .drop-line"), "a drop line shows where it will land");
  await page.mouse.up(); await sleep(600);
  bx = await getNode(top.Boxes); assert.deepEqual(bx.children.map((c) => c.name), ["A", "C", "B"]); assert.ok(!bx.children[1].style.position, "still in the flow");
  ok("dragging a layer in an auto-layout frame reorders it (drop line), the frame re-lays itself out");
  await op("undo"); await sleep(300);
  // switching it off pins the children exactly where they are
  const pre = { A: await rectOf(ids.A), B: await rectOf(ids.B), C: await rectOf(ids.C) };
  await page.mouse.click(abr.x - 30, abr.y - 30); await page.mouse.click(pre.A.x + pre.A.w + 60 * z, pre.A.y + 5); await sleep(250);
  await page.click("[data-autolayout]"); await sleep(600);
  bx = await getNode(top.Boxes); assert.ok(!bx.auto); assert.ok(bx.children.every((c) => c.style.position === "absolute"));
  for (const k of ["A", "B", "C"]) { const r = await rectOf(ids[k]); assert.ok(near(r.x, pre[k].x, 1) && near(r.y, pre[k].y, 1), `${k} did not move when auto layout was switched off`); }
  ok("Auto layout off: the layers become free layers exactly where they were");
  await op("undo"); await op("undo"); await sleep(300);

  // ---------- rotation ----------
  await page.mouse.click(abr.x - 30, abr.y - 30);
  await page.click(byId(top.Mover)); await sleep(250);
  assert.ok(await page.$("#overlay .rot"), "a rotate handle sits above the selection");
  const mvr = await rectOf(top.Mover), cx = mvr.x + mvr.w / 2, cy = mvr.y + mvr.h / 2;
  const rotH = await page.$eval("#overlay .rot", (e) => { const b = e.getBoundingClientRect(); return [b.x + b.width / 2, b.y + b.height / 2]; });
  await page.mouse.move(...rotH); await page.mouse.down(); await page.mouse.move(cx + 80, cy, { steps: 8 }); await page.keyboard.down("Shift"); await page.mouse.move(cx + 80, cy + 1, { steps: 2 }); await page.mouse.up(); await page.keyboard.up("Shift"); await sleep(400);
  const tr = (await getNode(top.Mover)).style.transform; assert.match(tr, /^rotate\(90deg\)$/, "dragged a quarter turn, ⇧ snapped to 15°: " + tr);
  assert.equal(await page.$eval("[data-rot]", (e) => e.value), "90");
  await page.$eval("[data-rot]", (e) => { e.value = "-30"; e.dispatchEvent(new Event("change")); }); await sleep(400);
  assert.equal((await getNode(top.Mover)).style.transform, "rotate(-30deg)"); await page.$eval("[data-rot]", (e) => { e.value = "0"; e.dispatchEvent(new Event("change")); }); await sleep(400);
  assert.ok(!(await getNode(top.Mover)).style.transform); ok("rotate handle (⇧ snaps to 15°) and the Rotation field; 0° removes the transform");

  // ---------- image crop with zoom ----------
  const png = await page.evaluate(() => { const c = document.createElement("canvas"); c.width = 400; c.height = 300; const x = c.getContext("2d"); x.fillStyle = "#e22"; x.fillRect(0, 0, 200, 300); x.fillStyle = "#22e"; x.fillRect(200, 0, 200, 300); return c.toDataURL("image/png").split(",")[1]; });
  const src = (await (await fetch(BASE + "/api/upload?name=pic.png", { method: "POST", body: Buffer.from(png, "base64") })).json()).src;
  const [pic] = await op("insert", { parentId: ab.id, html: `<img layer-name="Photo" src="${src}" style="position:absolute;left:40px;top:300px;width:240px;height:160px;object-fit:cover">` }); await sleep(500);
  await page.mouse.click(abr.x - 30, abr.y - 30);
  await page.mouse.click(...(await center(pic.id)), { count: 2 }); await sleep(500);
  assert.ok(await page.$("#overlay .sel-box.crop"), "crop mode");
  await page.keyboard.down("Meta"); await page.mouse.wheel({ deltaY: -150 }); await page.keyboard.up("Meta"); await sleep(900);
  let pn = await getNode(pic.id); assert.equal(pn.tag, "div"); assert.ok(pn.crop && pn.crop.zoom > 1.5, "zoomed: " + JSON.stringify(pn.crop)); assert.equal(pn.style.overflow, "hidden"); assert.equal(pn.children[0].tag, "img");
  ok("zooming in crop mode (⌘ + scroll) turns the picture into a clipping frame holding the zoomed picture");
  const frameBefore = await rectOf(pic.id); const sx = frameBefore.x + frameBefore.w / 2, sy = frameBefore.y + frameBefore.h / 2;
  await dragBy([sx, sy], 30 * z, 0, 5); await page.mouse.up(); await sleep(500);
  const after2 = (await getNode(pic.id)).crop; assert.ok(after2.px < 50, "dragging right shows more of the left side: px " + after2.px);
  const fr2 = await rectOf(pic.id); assert.ok(near(fr2.w, frameBefore.w, 1) && near(fr2.h, frameBefore.h, 1), "the frame itself did not move or resize");
  ok("dragging in crop mode slides the zoomed picture inside its frame");
  await page.keyboard.press("Escape"); await sleep(200);
  assert.ok(await page.$("[data-cropzoom]"), "the inspector has a Zoom slider");
  await page.$eval("[data-cropzoom]", (e) => { e.value = "300"; e.dispatchEvent(new Event("input")); }); await sleep(900);
  assert.ok(Math.abs((await getNode(pic.id)).crop.zoom - 3) < 0.01); ok("the Zoom slider in the inspector");
  // resizing the frame keeps the picture fitted
  await page.$eval('[data-prop="width"]', (e) => { e.value = "300px"; e.dispatchEvent(new Event("change")); }); await sleep(500);
  pn = await getNode(pic.id); assert.ok(parseFloat(pn.children[0].style.width) >= 300, "picture re-fitted: " + pn.children[0].style.width); ok("resizing a crop frame re-fits its picture");
  await page.click("[data-bake]"); await sleep(3000);
  pn = await getNode(pic.id); assert.equal(pn.tag, "img"); assert.ok(!pn.crop && /^assets\//.test(pn.attrs.src)); ok("Bake crop: one flat picture");
  await op("undo"); await sleep(300); await page.click("[data-uncrop]"); await sleep(500);
  pn = await getNode(pic.id); assert.equal(pn.tag, "img"); assert.equal(pn.style["object-fit"], "cover"); ok("Remove zoom: back to a plain picture");

  // ---------- pen tool ----------
  await page.mouse.click(abr.x - 30, abr.y - 30);
  const pt = (x, y) => [abr.x + x * z, abr.y + y * z];
  await page.keyboard.press("p"); await sleep(150);
  assert.equal(await page.$eval('[data-tool="pen"]', (b) => b.classList.contains("on")), true, "P selects the pen");
  await page.mouse.click(...pt(300, 300)); await page.mouse.click(...pt(380, 300)); await page.mouse.move(...pt(380, 360)); await sleep(100);
  assert.ok(await page.$("#overlay .penprev .pp"), "the unfinished path is drawn");
  await page.mouse.click(...pt(380, 360)); await page.keyboard.press("Enter"); await sleep(600);
  let vec = (await (await fetch(BASE + "/api/doc")).json()).state.artboards[0].children.find((c) => c.tag === "svg");
  assert.ok(vec, "an svg layer was created"); assert.equal(vec.name, "Path"); assert.equal(vec.style.position, "absolute"); assert.match(vec.raw, /fill="none"/); assert.match(vec.raw, /d="M[\d. ]+L[\d. ]+L[\d. ]+"/);
  assert.equal(await page.$eval('[data-tool="select"]', (b) => b.classList.contains("on")), true, "the tool returns to Move"); ok("pen: click points, Enter finishes an open path (a selectable svg layer)");
  // a closed curve: press-drag on the 2nd point makes handles; clicking the first point closes
  await page.keyboard.press("p");
  await page.mouse.click(...pt(520, 300));
  await page.mouse.move(...pt(600, 300)); await page.mouse.down(); await page.mouse.move(...pt(620, 340), { steps: 5 }); await page.mouse.up();
  await page.mouse.click(...pt(560, 400)); await page.mouse.click(...pt(520, 300)); await sleep(700);
  const shapes = (await state()).artboards[0].children.filter((c) => c.tag === "svg"); assert.equal(shapes.length, 2);
  const shape = shapes[1]; assert.equal(shape.name, "Shape"); assert.match(shape.raw, /C/); assert.match(shape.raw, /Z/); assert.match(shape.raw, /fill="#d9d9d9"/);
  ok("pen: dragging makes curve handles, clicking the first point closes the shape (filled)");
  // inspector: fill / stroke
  assert.ok(await page.$("[data-svgc=\"fill\"]"), "Vector section in the inspector");
  await page.$eval('[data-svgt="fill"]', (e) => { e.value = "#ff0099"; e.dispatchEvent(new Event("change")); }); await sleep(500);
  await page.$eval('[data-svgt="stroke-width"]', (e) => { e.value = "5"; e.dispatchEvent(new Event("change")); }); await sleep(500);
  const raw2 = (await getNode(shape.id)).raw; assert.match(raw2, /fill="#ff0099"/); assert.match(raw2, /stroke-width="5"/); ok("Vector section: fill, stroke and stroke width");
  // point editing
  await page.keyboard.press("Enter"); await sleep(400);
  const nPts = await page.$$eval("#overlay .vpt", (x) => x.length); assert.equal(nPts, 3, "three anchors");
  const dBefore = (await getNode(shape.id)).raw.match(/ d="([^"]+)"/)[1];
  const a0 = await page.$eval("#overlay .vpt", (e) => { const b = e.getBoundingClientRect(); return [b.x + b.width / 2, b.y + b.height / 2]; });
  await dragBy(a0, 25, 15, 5); await page.mouse.up(); await sleep(600);
  const dAfter = (await getNode(shape.id)).raw.match(/ d="([^"]+)"/)[1]; assert.notEqual(dBefore, dAfter);
  ok("Enter edits points: drag an anchor and the path follows (saved as one undo step)");
  await op("undo"); await sleep(400); assert.equal((await getNode(shape.id)).raw.match(/ d="([^"]+)"/)[1], dBefore); ok("…and ⌘Z puts it back");
  // add a point by double-clicking the outline, delete a point
  const outline = await page.evaluate((id) => { const p = document.querySelector(`[data-id="${id}"] path`); const L = p.getTotalLength(); const pt = p.getPointAtLength(L * 0.62); const m = p.getScreenCTM(); return [m.a * pt.x + m.c * pt.y + m.e, m.b * pt.x + m.d * pt.y + m.f]; }, shape.id);
  await page.mouse.click(...outline, { count: 2 }); await sleep(600);
  assert.equal(await page.$$eval("#overlay .vpt", (x) => x.length), 4, "double-click on the outline adds an anchor");
  await page.keyboard.press("Delete"); await sleep(500);
  assert.equal(await page.$$eval("#overlay .vpt", (x) => x.length), 3, "Delete removes the selected anchor");
  ok("double-click the outline to add a point; Delete removes the selected point");
  await page.keyboard.press("Escape"); await sleep(200); assert.equal(await page.$$eval("#overlay .vpt", (x) => x.length), 0, "Esc leaves point editing");

  assert.deepEqual(errors, []); ok("no console errors");
  console.log("\nEDITOR SUITE 9 PASSED");
} catch (e) {
  console.error("\nFAILED:", e.stack?.split("\n").slice(0, 5).join("\n") || e.message); await page.screenshot({ path: path.join(os.tmpdir(), "studio-editor9-fail.png") }).catch(() => {}); console.error("errors:", errors); process.exitCode = 1;
} finally { await browser.close(); srv.kill(); }
