// Fourth editor suite: presets, present mode, gradients, solid fill, effects, image crop, copy/paste, box select, live reorder.
// Run: node test/editor4-test.mjs
import puppeteer from "puppeteer-core";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "studio-ed4-"));
const PORT = 4782, BASE = `http://127.0.0.1:${PORT}`;
const srv = spawn(process.execPath, [path.join(root, "server/server.js")], { env: { ...process.env, STUDIO_PORT: PORT, STUDIO_PROJECT: path.join(tmp, "proj") }, stdio: "ignore" });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
for (let i = 0; i < 40; i++) { try { await fetch(BASE + "/api/ping"); break; } catch { await sleep(150); } }
const op = async (name, args = {}) => { const r = await fetch(BASE + "/api/op", { method: "POST", body: JSON.stringify({ op: name, args }) }); const j = await r.json(); if (!r.ok) throw new Error(j.error); return j.result; };
const docState = async () => (await (await fetch(BASE + "/api/doc")).json()).state;
const ok = (m) => console.log("  ✓", m);
const CHROME = ["/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge"].find(fs.existsSync);
const browser = await puppeteer.launch({ executablePath: CHROME, headless: true, defaultViewport: { width: 1500, height: 900 } });
const page = await browser.newPage();
const errors = [];
page.on("pageerror", (e) => errors.push(e.message));
page.on("console", (m) => m.type() === "error" && !/fonts\.g|net::ERR/.test(m.text()) && errors.push(m.text()));
const byId = (id) => `[data-id="${id}"]`;
const rectOf = (id) => page.$eval(byId(id), (e) => { const b = e.getBoundingClientRect(); return { x: b.x, y: b.y, w: b.width, h: b.height }; });
const center = async (id) => { const r = await rectOf(id); return [r.x + r.w / 2, r.y + r.h / 2]; };
const node = (id) => op("node", { nodeId: id });

try {
  await page.goto(BASE + "/#/edit"); await sleep(300);

  // ---- presets
  await page.click("#btn-add-artboard"); await sleep(100);
  const opts = await page.$$eval("#p-preset optgroup", (g) => g.map((x) => x.label));
  for (const g of ["Social", "Ads", "Presentation", "Print"]) assert.ok(opts.includes(g), "preset group " + g);
  await page.select("#p-preset", await page.$eval("#p-preset", (s) => [...s.options].find((o) => o.textContent.startsWith("Instagram post")).value));
  assert.equal(await page.$eval("#p-name", (e) => e.value), "Instagram post", "name follows the preset");
  await page.click("#p-ok"); await sleep(500);
  const ig = (await docState()).artboards.find((a) => a.name === "Instagram post");
  assert.equal(ig.style.width, "1080px"); assert.equal(ig.style.height, "1080px"); ok("presets: Social / Ads / Presentation / Print; Instagram post is 1080×1080");

  // content
  const png = await page.evaluate(() => { const c = document.createElement("canvas"); c.width = 400; c.height = 200; const x = c.getContext("2d"); x.fillStyle = "#f00"; x.fillRect(0, 0, 200, 200); x.fillStyle = "#00f"; x.fillRect(200, 0, 200, 200); return c.toDataURL("image/png").split(",")[1]; });
  const src = (await (await fetch(BASE + "/api/upload?name=wide.png", { method: "POST", body: Buffer.from(png, "base64") })).json()).src;
  const created = await op("insert", { parentId: ig.id, html: `
    <div layer-name="Stack" style="display:flex;flex-direction:column;gap:20px;padding:60px">
      <div layer-name="One" style="height:120px;background-color:#eeeeee">One</div>
      <div layer-name="Two" style="height:120px;background-color:#dddddd">Two</div>
      <div layer-name="Three" style="height:120px;background-color:#cccccc">Three</div>
      <img layer-name="Photo" src="${src}" style="width:300px;height:300px">
    </div>` });
  await page.click("#btn-fit"); await sleep(300);
  const kids = async () => (await op("children", { nodeId: created[0].id }));
  const ids = Object.fromEntries((await kids()).map((c) => [c.name, c.id]));
  const z = (await page.evaluate(() => JSON.parse(localStorage.getItem("studio-view")))).z;

  // ---- gradient
  {
    await page.click(byId(ids.Two)); await sleep(150);
    await page.click('[data-fill="linear"]'); await sleep(300);
    let st = (await node(ids.Two)).style;
    assert.match(st["background-image"], /^linear-gradient\(135deg, #dddddd 0%, #7a2cff 100%\)$/);
    ok("Fill → Linear turns the colour into a gradient");
    const bar = await page.$eval(".gbar", (e) => { const b = e.getBoundingClientRect(); return { x: b.x, y: b.y, w: b.width, h: b.height }; });
    const stop = await page.$eval('.gstop[data-stop="1"]', (e) => { const b = e.getBoundingClientRect(); return [b.x + b.width / 2, b.y + b.height / 2]; });
    await page.mouse.move(...stop); await page.mouse.down(); await page.mouse.move(bar.x + bar.w * 0.6, stop[1], { steps: 5 }); await page.mouse.up(); await sleep(300);
    st = (await node(ids.Two)).style; assert.match(st["background-image"], /#7a2cff 6\d%/, st["background-image"]);
    ok("dragging a gradient stop moves it: " + st["background-image"]);
    await page.$eval("[data-gangle-n]", (e) => { e.value = "90"; e.dispatchEvent(new Event("change")); }); await sleep(300);
    assert.match((await node(ids.Two)).style["background-image"], /^linear-gradient\(90deg/); ok("angle");
    await page.click("[data-gadd]"); await sleep(300);
    assert.equal(((await node(ids.Two)).style["background-image"].match(/%/g) || []).length, 3); ok("add a stop");
    await page.click('[data-fill="radial"]'); await sleep(300);
    assert.match((await node(ids.Two)).style["background-image"], /^radial-gradient\(circle at center/); ok("radial");
    const painted = await page.$eval(byId(ids.Two), (e) => getComputedStyle(e).backgroundImage);
    assert.match(painted, /radial-gradient/); ok("canvas shows the gradient");
    await page.click('[data-fill="solid"]'); await sleep(300);
    st = (await node(ids.Two)).style; assert.ok(!st["background-image"]); ok("back to solid");
    await page.$eval("[data-fillt]", (e) => { e.value = "#123456"; e.dispatchEvent(new Event("change")); }); await sleep(300);
    assert.equal((await node(ids.Two)).style["background-color"], "#123456"); ok("solid colour");
  }

  // ---- effects
  {
    await page.$eval('[data-fx="blur"]', (e) => { e.value = "4"; e.dispatchEvent(new Event("input")); e.dispatchEvent(new Event("change")); }); await sleep(300);
    await page.$eval('[data-fx="brightness"]', (e) => { e.value = "130"; e.dispatchEvent(new Event("input")); e.dispatchEvent(new Event("change")); }); await sleep(300);
    assert.equal((await node(ids.Two)).style.filter, "blur(4px) brightness(130%)");
    await page.click("[data-fxreset]"); await sleep(300); assert.ok(!(await node(ids.Two)).style.filter);
    ok("effects sliders write a CSS filter (blur, brightness …) and reset clears it");
  }

  // ---- crop
  {
    await page.mouse.click(...(await center(ids.Photo)), { count: 2 }); await sleep(400);
    assert.ok(await page.$("#overlay .sel-box.crop"), "crop mode shows a dashed box");
    assert.equal((await node(ids.Photo)).style["object-fit"], "cover");
    const [x, y] = await center(ids.Photo);
    await page.mouse.move(x, y); await page.mouse.down(); await page.mouse.move(x + 60 * z, y, { steps: 6 }); await page.mouse.up(); await sleep(300);
    const pos = (await node(ids.Photo)).style["object-position"];
    assert.ok(pos && parseFloat(pos) < 50, "dragging right shows more of the left side: " + pos);
    const before = await rectOf(ids.Photo);
    assert.ok(Math.abs(before.w - 300 * z) < 2, "the crop box itself didn't move");
    await page.keyboard.press("Enter"); await sleep(150);
    assert.equal(await page.$("#overlay .sel-box.crop"), null); ok("double-click an image: drag repositions it inside its frame (" + pos + "), Enter leaves crop");
    await page.click('[data-ratio="1.7777777777777777"]'); await sleep(300);
    const p = (await node(ids.Photo)).style; assert.equal(p.width, "300px"); assert.equal(p.height, "169px"); ok("crop to 16:9");
  }

  // ---- copy / paste
  {
    await page.click(byId(ids.Three)); await sleep(150);
    await page.evaluate(() => {
      const dt = new DataTransfer();
      document.dispatchEvent(new ClipboardEvent("copy", { clipboardData: dt, bubbles: true }));
      window.__dt = dt;
    });
    const text = await page.evaluate(() => window.__dt.getData("text/plain"));
    assert.ok(text.startsWith("<!--studio-clip:") && text.includes("Three"));
    const n0 = (await kids()).length;
    await page.evaluate(() => document.dispatchEvent(new ClipboardEvent("paste", { clipboardData: window.__dt, bubbles: true }))); await sleep(400);
    const after = await kids();
    assert.equal(after.length, n0 + 1); assert.equal(after.filter((c) => c.name === "Three").length, 2);
    ok("⌘C / ⌘V copies a layer and pastes it next to the original");
  }

  // ---- box select
  {
    const ab = await rectOf(ig.id);
    const one = await rectOf(ids.One);
    // start on the artboard's own background (below the content) and drag up across the Stack frame
    const stack = await rectOf(created[0].id);
    await page.mouse.move(ab.x + 10, stack.y + stack.h + 20); await page.mouse.down(); await page.mouse.move(one.x + 50, one.y + one.h, { steps: 6 });
    assert.ok(await page.$("#overlay .marquee"), "selection box drawn");
    await page.mouse.up(); await sleep(200);
    const sel = await page.evaluate(() => [...document.querySelectorAll(".lrow.sel")].map((r) => r.dataset.lid));
    assert.ok(sel.includes(created[0].id), "the Stack frame (direct child of the artboard) is selected: " + sel);
    // empty canvas: selects artboards
    await page.mouse.move(ab.x - 40, ab.y - 40); await page.mouse.down(); await page.mouse.move(ab.x + 40, ab.y + 40, { steps: 5 }); await page.mouse.up(); await sleep(200);
    const sel2 = await page.evaluate(() => [...document.querySelectorAll(".lrow.sel")].map((r) => r.dataset.lid));
    assert.deepEqual(sel2, [ig.id]); ok("box select: inside an artboard picks its layers, on the empty canvas picks artboards");
  }

  // ---- present
  {
    await op("createArtboard", { name: "Slide 2", width: 1920, height: 1080 });
    await sleep(300);
    await page.click("#btn-present"); await sleep(300);
    assert.ok(await page.$("#present .stage > *"), "slide shown");
    const c1 = await page.$eval("#present .pc", (e) => e.textContent);
    await page.keyboard.press("ArrowRight"); await sleep(150);
    const c2 = await page.$eval("#present .pc", (e) => e.textContent);
    assert.notEqual(c1, c2); assert.match(c2, /2 \/ 2/);
    const fits = await page.$eval("#present .stage > *", (e) => { const b = e.getBoundingClientRect(); return b.width <= innerWidth + 1 && b.height <= innerHeight; });
    assert.ok(fits, "slide scaled to fit the screen");
    await page.keyboard.press("Escape"); await sleep(150);
    assert.equal(await page.$("#present"), null); ok("Present shows artboards full screen, arrows move between them, Esc leaves");
  }

  assert.deepEqual(errors, []); ok("no console errors");
  console.log("\nEDITOR SUITE 4 PASSED");
} catch (e) {
  console.error("\nFAILED:", e.stack?.split("\n").slice(0, 4).join("\n") || e.message); await page.screenshot({ path: path.join(os.tmpdir(), "studio-editor4-fail.png") }).catch(() => {}); console.error("errors:", errors); process.exitCode = 1;
} finally { await browser.close(); srv.kill(); }
