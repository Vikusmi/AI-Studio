// Third editor suite: free drag with centre guides, edge resize, draw tools, align/distribute, layer order, Alt measuring.
// Run: node test/editor3-test.mjs
import puppeteer from "puppeteer-core";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "studio-ed3-"));
const PORT = 4781, BASE = `http://127.0.0.1:${PORT}`;
const srv = spawn(process.execPath, [path.join(root, "server/server.js")], { env: { ...process.env, STUDIO_PORT: PORT, STUDIO_PROJECT: path.join(tmp, "proj") }, stdio: "ignore" });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
for (let i = 0; i < 40; i++) { try { await fetch(BASE + "/api/ping"); break; } catch { await sleep(150); } }
const op = async (name, args = {}) => { const r = await fetch(BASE + "/api/op", { method: "POST", body: JSON.stringify({ op: name, args }) }); const j = await r.json(); if (!r.ok) throw new Error(j.error); return j.result; };
const ok = (m) => console.log("  ✓", m);
const CHROME = ["/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge"].find(fs.existsSync);
const browser = await puppeteer.launch({ executablePath: CHROME, headless: true, defaultViewport: { width: 1500, height: 900 } });
const page = await browser.newPage();
const errors = [];
page.on("pageerror", (e) => errors.push(e.message));
page.on("console", (m) => m.type() === "error" && !/fonts\.g|net::ERR/.test(m.text()) && errors.push(m.text()));

try {
  await page.goto(BASE + "/#/edit");
  const ab = await op("createArtboard", { name: "Studio", width: 600, height: 700, style: { "background-color": "#ffffff" } });
  const [hero] = await op("insert", { parentId: ab.id, html: `
   <div layer-name="Hero" style="display:flex;flex-direction:column;gap:14px;padding:30px;position:relative;height:640px">
     <div layer-name="Card A" style="background:#eee;padding:20px;font:16px Arial;width:200px">Card A</div>
     <div layer-name="Card B" style="background:#ddd;padding:20px;font:16px Arial;width:200px">Card B</div>
     <div layer-name="Box" style="position:absolute;left:40px;top:400px;width:100px;height:60px;background:#0d8cff"></div>
     <div layer-name="Box2" style="position:absolute;left:220px;top:430px;width:100px;height:60px;background:#f33"></div>
     <div layer-name="Box3" style="position:absolute;left:500px;top:520px;width:50px;height:60px;background:#3a3"></div>
   </div>` });
  await page.waitForSelector(".abw"); await sleep(300);
  const ids = Object.fromEntries((await op("children", { nodeId: hero.id })).map((c) => [c.name, c.id]));
  const byId = (id) => `[data-id="${id}"]`;
  const rectOf = (id) => page.$eval(byId(id), (e) => { const b = e.getBoundingClientRect(); return { x: b.x, y: b.y, w: b.width, h: b.height }; });
  const node = (id) => op("node", { nodeId: id });
  const zoom = async () => (await page.evaluate(() => JSON.parse(localStorage.getItem("studio-view")))).z;
  await page.click("#btn-fit"); await sleep(250);
  const z = await zoom();
  assert.equal(await page.$eval("#btn-snap", (b) => b.classList.contains("on")), true, "snapping is on by default");
  assert.equal(await page.$('[data-mm]'), null, "there is no Free / Flow switch any more");

  // ---- free drag of a layout element by clicking inside it, with centre guides
  {
    const hero_r = await rectOf(hero.id), a = await rectOf(ids["Card A"]);
    const heroCx = hero_r.x + hero_r.w / 2;
    const sx = a.x + a.w / 2, sy = a.y + a.h / 2;
    const targetCx = heroCx + 3; // 3px off the centre: should snap
    await page.mouse.move(sx, sy); await page.mouse.down();
    await page.mouse.move(sx + 20, sy + 30, { steps: 4 });
    await page.mouse.move(targetCx, sy + 140 * z, { steps: 8 });
    const guides = await page.$$eval("#overlay .guide", (g) => g.length);
    assert.ok(guides >= 1, "a snapping guide is drawn while free-dragging");
    await page.mouse.up(); await sleep(300);
    const na = await node(ids["Card A"]);
    assert.equal(na.style.position, "absolute");
    const after = await rectOf(ids["Card A"]);
    assert.ok(Math.abs(after.x + after.w / 2 - heroCx) <= 1.5, `centred on the parent: ${after.x + after.w / 2} vs ${heroCx}`);
    ok("click inside a layout element and drag: it moves freely and snaps to the parent's centre with a guide");
    await op("undo"); await sleep(250);
  }

  // ---- edge resize: drag the blue edge (not a dot)
  {
    await page.click(byId(ids["Box"])); await sleep(150);
    const r = await rectOf(ids["Box"]);
    const edge = await page.$eval('#overlay .edge[data-h="e"]', (e) => { const b = e.getBoundingClientRect(); return [b.x + b.width / 2, b.y + b.height / 2]; });
    assert.ok(Math.abs(edge[0] - (r.x + r.w)) <= 1.5, "east edge sits on the selection line");
    await page.mouse.move(edge[0], edge[1]); await page.mouse.down(); await page.mouse.move(edge[0] + 20 * z, edge[1], { steps: 6 }); await page.mouse.up(); await sleep(250);
    assert.equal((await node(ids["Box"])).style.width, "120px");
    const top = await page.$eval('#overlay .edge[data-h="n"]', (e) => { const b = e.getBoundingClientRect(); return [b.x + b.width / 2, b.y + b.height / 2]; });
    await page.mouse.move(top[0], top[1]); await page.mouse.down(); await page.mouse.move(top[0], top[1] - 10 * z, { steps: 6 }); await page.mouse.up(); await sleep(250);
    const nb = await node(ids["Box"]); assert.equal(nb.style.height, "70px"); assert.equal(nb.style.top, "390px");
    ok("dragging the blue edge resizes (east: 100→120 wide, north: 60→70 tall and moves up)");
  }

  // ---- draw tools
  const heroPoint = async (fx, fy) => { const h = await rectOf(hero.id); return [h.x + fx * z, h.y + fy * z]; };
  const kids = async () => (await op("children", { nodeId: hero.id }));
  {
    await page.keyboard.press("r"); assert.equal(await page.$eval('[data-tool="rect"]', (b) => b.classList.contains("on")), true);
    const [x0, y0] = await heroPoint(300, 40), [x1, y1] = await heroPoint(420, 120);
    await page.mouse.move(x0, y0); await page.mouse.down(); await page.mouse.move(x1, y1, { steps: 8 });
    assert.ok(await page.$("#overlay .draw-box"), "preview box while drawing");
    await page.mouse.up(); await sleep(400);
    const before = Object.values(ids);
    const created = (await kids()).find((c) => !before.includes(c.id)); assert.ok(created, "rectangle created");
    const nr = await node(created.id);
    assert.equal(nr.name, "Rectangle"); assert.equal(nr.style.position, "absolute"); assert.ok(Math.abs(parseInt(nr.style.width) - 120) <= 2 && Math.abs(parseInt(nr.style.height) - 80) <= 2, nr.style.width + "x" + nr.style.height);
    assert.ok(Math.abs(parseInt(nr.style.left) - 300) <= 2 && Math.abs(parseInt(nr.style.top) - 40) <= 2, nr.style.left + "," + nr.style.top);
    assert.equal(await page.$eval('[data-tool="select"]', (b) => b.classList.contains("on")), true, "tool returns to Move");
    ok("R then drag draws a rectangle at the dragged position and size");
    ids.Rect = created.id;
  }
  {
    await page.keyboard.press("o");
    const [x0, y0] = await heroPoint(300, 160), [x1, y1] = await heroPoint(400, 260);
    await page.mouse.move(x0, y0); await page.mouse.down(); await page.mouse.move(x1, y1, { steps: 6 }); await page.mouse.up(); await sleep(400);
    const o = (await kids()).find((c) => c.name === "Ellipse"); assert.ok(o); assert.equal((await node(o.id)).style["border-radius"], "50%"); ok("O draws an oval");
  }
  {
    await page.keyboard.press("t");
    const [x0, y0] = await heroPoint(300, 300);
    await page.mouse.click(x0, y0); await sleep(450);
    assert.ok(await page.evaluate(() => document.activeElement && document.activeElement.isContentEditable), "text box is in edit mode");
    await page.keyboard.type("Hello studio"); await page.mouse.click(1000, 800); await sleep(300);
    const t = (await kids()).find((c) => c.name === "Text"); assert.ok(t);
    assert.ok((await node(t.id)).html.includes("Hello studio")); ok("T then click makes a text box you can type into straight away");
  }
  {
    await page.keyboard.press("f");
    const [x0, y0] = await heroPoint(40, 520), [x1, y1] = await heroPoint(260, 620);
    await page.mouse.move(x0, y0); await page.mouse.down(); await page.mouse.move(x1, y1, { steps: 6 }); await page.mouse.up(); await sleep(400);
    const f = (await kids()).find((c) => c.name === "Frame"); assert.ok(f); assert.match((await node(f.id)).style.display, /flex/); ok("F draws an auto-layout frame");
    await page.keyboard.press("r"); await page.keyboard.press("Escape");
    assert.equal(await page.$eval('[data-tool="select"]', (b) => b.classList.contains("on")), true); ok("Escape cancels the tool");
  }

  // ---- align + distribute
  {
    await page.click(byId(ids["Box"])); await page.keyboard.down("Shift"); await page.click(byId(ids["Box2"])); await page.click(byId(ids["Box3"])); await page.keyboard.up("Shift"); await sleep(200);
    await page.click('[data-align-act="top"]'); await sleep(300);
    const tops = await Promise.all(["Box", "Box2", "Box3"].map(async (k) => (await rectOf(ids[k])).y));
    assert.ok(tops.every((t) => Math.abs(t - tops[0]) <= 1), "tops aligned " + tops);
    ok("align top lines up three selected elements");
    await page.click('[data-align-act="distH"]'); await sleep(300);
    const rs = (await Promise.all(["Box", "Box2", "Box3"].map((k) => rectOf(ids[k])))).sort((a, b) => a.x - b.x);
    const g1 = rs[1].x - (rs[0].x + rs[0].w), g2 = rs[2].x - (rs[1].x + rs[1].w);
    assert.ok(Math.abs(g1 - g2) <= 1.5, `equal gaps ${g1} / ${g2}`); ok("distribute horizontally makes the gaps equal");
  }
  {
    await page.click(byId(ids["Card B"])); await sleep(150);
    await page.click('[data-align-act="hcenter"]'); await sleep(350);
    const h = await rectOf(hero.id), c = await rectOf(ids["Card B"]);
    assert.ok(Math.abs(c.x + c.w / 2 - (h.x + h.w / 2)) <= 1.5, "centred in parent");
    assert.equal((await node(ids["Card B"])).style.position, "absolute");
    ok("align centre on a layout element centres it in its parent");
  }

  // ---- layer order
  {
    await page.click(byId(ids["Box"])); await sleep(150);
    const idx = async () => (await kids()).findIndex((c) => c.id === ids["Box"]);
    const i0 = await idx();
    await page.keyboard.down("Meta"); await page.keyboard.press("]"); await page.keyboard.up("Meta"); await sleep(300);
    assert.equal(await idx(), i0 + 1);
    await page.keyboard.down("Meta"); await page.keyboard.down("Shift"); await page.keyboard.press("]"); await page.keyboard.up("Shift"); await page.keyboard.up("Meta"); await sleep(300);
    assert.equal(await idx(), (await kids()).length - 1);
    await page.keyboard.down("Meta"); await page.keyboard.press("["); await page.keyboard.up("Meta"); await sleep(300);
    assert.equal(await idx(), (await kids()).length - 2);
    ok("⌘] / ⌘⇧] / ⌘[ change the layer order");
  }

  // ---- Alt measuring
  {
    await page.click(byId(ids["Box"])); await sleep(150);
    const [cx, cy] = await page.$eval(byId(ids["Box3"]), (e) => { const b = e.getBoundingClientRect(); return [b.x + b.width / 2, b.y + b.height / 2]; });
    await page.mouse.move(cx, cy); await sleep(100);
    assert.equal(await page.$$eval("#overlay .dist-label", (x) => x.length), 0, "no distances without Alt");
    await page.keyboard.down("Alt"); await sleep(200);
    const labels = await page.$$eval("#overlay .dist-label", (x) => x.map((e) => e.textContent));
    const a = await rectOf(ids["Box"]), b = await rectOf(ids["Box3"]);
    const gap = Math.round((b.x - (a.x + a.w)) / z);
    assert.ok(labels.some((l) => Math.abs(Number(l) - gap) <= 1), `gap ${gap} among ${labels}`);
    await page.keyboard.up("Alt"); await sleep(150);
    assert.equal(await page.$$eval("#overlay .dist-label", (x) => x.length), 0, "distances disappear on release");
    ok("holding Alt over another element shows the pixel distance");
  }

  // ---- the snap switch
  {
    await page.click("#btn-snap");
    assert.equal(await page.$eval("#btn-snap", (b) => b.classList.contains("on")), false);
    assert.equal(await page.evaluate(() => localStorage.getItem("studio-snap")), "off");
    // with snapping off, a layer dragged 3px from the parent's centre is not pulled in
    const hr = await rectOf(hero.id), a = await rectOf(ids["Box2"]);
    const cx = a.x + a.w / 2, cy = a.y + a.h / 2, targetCx = hr.x + hr.w / 2 + 3;
    await page.mouse.move(cx, cy); await page.mouse.down(); await page.mouse.move(cx + 8, cy + 4, { steps: 2 }); await page.mouse.move(targetCx, cy, { steps: 6 });
    assert.equal(await page.$$eval("#overlay .guide", (g) => g.length), 0, "no guides while snapping is off");
    await page.mouse.up(); await sleep(250);
    await page.click("#btn-snap"); await sleep(100);
    assert.equal(await page.evaluate(() => localStorage.getItem("studio-snap")), "on");
    await op("undo"); await sleep(200);
    ok("the Snap switch turns the guides off and on, and remembers it");
  }
  assert.deepEqual(errors, []); ok("no console errors");
  console.log("\nEDITOR SUITE 3 PASSED");
} catch (e) {
  console.error("\nFAILED:", e.stack?.split("\n").slice(0, 4).join("\n") || e.message); await page.screenshot({ path: path.join(os.tmpdir(), "studio-editor3-fail.png") }).catch(() => {}); console.error("errors:", errors); process.exitCode = 1;
} finally { await browser.close(); srv.kill(); }
