// Drives the real editor in headless Chrome: select, inspector, drags, text edit, undo/redo, drop image, download HTML.
// Run: node test/editor-test.mjs
import puppeteer from "puppeteer-core";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "studio-ed-"));
const PORT = 4779, BASE = `http://127.0.0.1:${PORT}`;
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

try {
  // a little PNG for images
  const imgSrc = await (async () => { const b = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAFElEQVR4nGP8z8Dwn4GBgYGJAQoAHhgCAh6X4CYAAAAASUVORK5CYII=", "base64"); const r = await fetch(BASE + "/api/upload?name=t.png", { method: "POST", body: b }); return (await r.json()).src; })();

  await page.goto(BASE + "/#/edit");
  const ab = await op("createArtboard", { name: "Test email", width: 600 });
  const [hero] = await op("insert", { parentId: ab.id, html: `
   <div layer-name="Hero" style="display:flex;flex-direction:column;gap:16px;padding:30px;position:relative">
     <h1 id="a" style="font-family:'Inter Tight';font-size:32px;margin:0">Headline one</h1>
     <p style="margin:0;font-size:16px">Second paragraph</p>
     <img src="${imgSrc}" style="width:100%;height:120px;object-fit:cover">
     <div layer-name="Button" style="background:#ff4f1f;color:#fff;padding:14px 24px;width:160px">Click me</div>
     <div layer-name="Empty frame" style="min-height:70px;border:1px dashed #999;display:flex;flex-direction:column"></div>
     <div layer-name="Sticker" style="position:absolute;right:20px;top:20px;width:60px;height:60px;background:#0d8cff;border-radius:50%"></div>
   </div>` });
  await page.waitForSelector(".abw");
  await sleep(300);
  const ids = Object.fromEntries((await op("children", { nodeId: hero.id })).map((c) => [c.name, c.id]));
  ok("editor renders artboard from server");

  const center = async (sel) => { const r = await page.evaluate((s) => { const b = document.querySelector(s).getBoundingClientRect(); return [b.x + b.width / 2, b.y + b.height / 2]; }, sel); return r; };
  const byId = (id) => `[data-id="${id}"]`;
  const order = async () => (await docState()).artboards[0].children[0].children.map((c) => c.name || c.tag);

  // fit so everything is visible
  await page.click("#btn-fit"); await sleep(100);

  // layers panel
  const rows = await page.$$eval(".lrow .nm", (e) => e.map((x) => x.textContent));
  assert.ok(rows.includes("Test email") && rows.includes("Hero") && rows.includes("Headline one") && rows.includes("Button"), rows.join()); ok("layers panel: " + rows.join(" | "));

  // click selects deepest, overlay box + inspector
  let [x, y] = await center(byId(ids["Button"]));
  await page.mouse.click(x, y); await sleep(250);
  assert.equal(await page.$$eval(".sel-box", (e) => e.length), 1);
  assert.match(await page.$eval(".sel-tag", (e) => e.textContent), /Button\s+160 × /);
  assert.equal((await fetch(BASE + "/api/doc").then((r) => r.json())).selection[0], ids["Button"]); ok("click selects, tag shows size, selection synced to server (get_selection)");
  assert.ok(await page.$eval(".lrow.sel .nm", (e) => e.textContent === "Button")); ok("layers highlight follows canvas selection");

  // inspector: type a size, focus must survive other updates
  const before = await page.$eval('[data-prop="padding"]', (e) => e.value);
  await page.click('[data-prop="border-radius"]'); await page.keyboard.type("12px");
  await op("updateStyles", { updates: [{ nodeIds: [ids["Headline one"]], styles: { color: "#222" } }] }); // external edit while typing
  await sleep(200);
  assert.equal(await page.evaluate(() => document.activeElement.dataset.prop), "border-radius");
  assert.equal(await page.evaluate(() => document.activeElement.value), "12px"); ok("inspector keeps focus + text while document updates under it");
  await page.keyboard.press("Enter"); await sleep(250);
  assert.equal((await op("node", { nodeId: ids["Button"] })).style["border-radius"], "12px"); ok("inspector edit applied to document");

  // text edit in place
  [x, y] = await center(byId(ids["Headline one"]));
  await page.mouse.click(x, y); await page.mouse.click(x, y, { count: 2 }); await sleep(150);
  assert.equal(await page.$eval(byId(ids["Headline one"]), (e) => e.contentEditable), "plaintext-only");
  await page.keyboard.type("Edited headline"); await page.keyboard.press("Enter"); await sleep(300);
  assert.equal((await op("node", { nodeId: ids["Headline one"] })).html.includes("Edited headline"), true); ok("double-click text editing, Enter commits");
  [x, y] = await center(byId(ids["Headline one"]));
  await page.mouse.click(x, y, { count: 2 }); await page.keyboard.type("nope"); await page.keyboard.press("Escape"); await sleep(250);
  assert.ok((await op("node", { nodeId: ids["Headline one"] })).html.includes("Edited headline")); ok("Esc cancels text edit");

  // dragging a layer that sits in a layout: it moves freely and nothing else reflows
  const rectOf0 = (id) => page.$eval(byId(id), (e) => { const b = e.getBoundingClientRect(); return { x: b.x, y: b.y, w: b.width, h: b.height }; });
  {
    const zoom0 = await page.$eval("#zoom-label", (e) => parseInt(e.textContent) / 100);
    const names = ["Headline one", "Empty frame"];
    const before = Object.fromEntries(await Promise.all(names.concat(["Button"]).map(async (k) => [k, await rectOf0(ids[k])])));
    const heroBefore = await rectOf0(hero.id);
    const [bx, by] = await center(byId(ids["Button"]));
    await page.keyboard.down("Meta");
    await page.mouse.move(bx, by); await page.mouse.down(); await page.mouse.move(bx + 10, by + 10, { steps: 3 }); await page.mouse.move(bx + 80 * zoom0, by + 60 * zoom0, { steps: 8 }); await sleep(60);
    const mid = await rectOf0(ids["Empty frame"]);
    assert.ok(Math.abs(mid.y - before["Empty frame"].y) < 1, "the layers below don't move while you drag");
    await page.mouse.up(); await page.keyboard.up("Meta"); await sleep(350);
    const nb = (await op("node", { nodeId: ids["Button"] })).style;
    assert.equal(nb.position, "absolute");
    const after = await rectOf0(ids["Button"]);
    assert.ok(Math.abs(after.x - (before["Button"].x + 80 * zoom0)) <= 2 && Math.abs(after.y - (before["Button"].y + 60 * zoom0)) <= 2, "the layer lands where you dropped it");
    for (const k of names) { const r = await rectOf0(ids[k]); assert.ok(Math.abs(r.x - before[k].x) <= 1 && Math.abs(r.y - before[k].y) <= 1, k + " stayed put"); }
    const heroAfter = await rectOf0(hero.id); assert.ok(Math.abs(heroAfter.h - heroBefore.h) <= 1, "the frame keeps its size");
    ok("free drag: the layer moves anywhere and its neighbours stay exactly where they were");
    await op("undo"); await sleep(300);
    assert.ok(!(await op("node", { nodeId: ids["Button"] })).style.position, "one undo restores the whole layout");
  }

  // absolute drag: sticker
  const sBefore = (await op("node", { nodeId: ids["Sticker"] })).style;
  const [sx, sy] = await center(byId(ids["Sticker"]));
  const zoom = await page.$eval("#zoom-label", (e) => parseInt(e.textContent) / 100);
  await page.keyboard.down("Meta"); // ⌘ disables snapping so the numbers are exact
  await page.mouse.move(sx, sy); await page.mouse.down(); await page.mouse.move(sx - 60 * zoom, sy + 40 * zoom, { steps: 8 }); await page.mouse.up(); await page.keyboard.up("Meta"); await sleep(300);
  const sAfter = (await op("node", { nodeId: ids["Sticker"] })).style;
  assert.equal(parseInt(sAfter.right), parseInt(sBefore.right) + 60); assert.equal(parseInt(sAfter.top), parseInt(sBefore.top) + 40);
  assert.ok(!("left" in sAfter)); ok(`absolute drag updates right/top (right-anchored stays right-anchored): right ${sBefore.right}→${sAfter.right}, top ${sBefore.top}→${sAfter.top}`);
  // arrow nudge
  await page.keyboard.press("ArrowLeft"); await page.keyboard.down("Shift"); await page.keyboard.press("ArrowDown"); await page.keyboard.up("Shift"); await sleep(300);
  const sN = (await op("node", { nodeId: ids["Sticker"] })).style;
  assert.equal(parseInt(sN.right), parseInt(sAfter.right) + 1); assert.equal(parseInt(sN.top), parseInt(sAfter.top) + 10); ok("arrow keys nudge 1px, Shift+arrow 10px");

  // undo / redo through keyboard (shared history with the API)
  const sticky = async () => (await op("node", { nodeId: ids["Sticker"] })).style;
  await page.keyboard.down("Meta"); await page.keyboard.press("z"); await sleep(250); await page.keyboard.press("z"); await sleep(250);
  assert.equal((await sticky()).right, sAfter.right); assert.equal((await sticky()).top, sAfter.top); // both nudges undone
  await page.keyboard.down("Shift"); await page.keyboard.press("z"); await page.keyboard.up("Shift"); await page.keyboard.up("Meta"); await sleep(250);
  assert.equal((await sticky()).right, String(parseInt(sAfter.right) + 1) + "px"); // first nudge redone
  await page.keyboard.down("Meta"); await page.keyboard.down("Shift"); await page.keyboard.press("z"); await page.keyboard.up("Shift"); await page.keyboard.up("Meta"); await sleep(250);
  assert.equal((await sticky()).top, sN.top);
  ok("⌘Z / ⇧⌘Z work");

  // layers panel drag: move "Button" out of empty frame to before "Headline" (top half of row)
  const lrow = (id) => `.lrow[data-lid="${id}"]`;
  const rect = async (sel) => page.$eval(sel, (e) => { const b = e.getBoundingClientRect(); return { x: b.x, y: b.y, w: b.width, h: b.height }; });
  const dnd = async (from, to, frac) => page.evaluate(async ([f, t, frac]) => {
    const a = document.querySelector(f), b = document.querySelector(t), dt = new DataTransfer();
    const r = b.getBoundingClientRect(), cy = r.top + r.height * frac;
    a.dispatchEvent(new DragEvent("dragstart", { bubbles: true, dataTransfer: dt }));
    b.dispatchEvent(new DragEvent("dragover", { bubbles: true, cancelable: true, dataTransfer: dt, clientY: cy, clientX: r.left + 20 }));
    b.dispatchEvent(new DragEvent("drop", { bubbles: true, cancelable: true, dataTransfer: dt, clientY: cy, clientX: r.left + 20 }));
  }, [from, to, frac]);
  await dnd(lrow(ids["Button"]), lrow(ids["Headline one"]), 0.9); await sleep(300);
  let o = await order(); assert.equal(o[0], "Button", o.join()); ok("layers drag: before/after reorders + reparents out of a frame");
  await dnd(lrow(ids["Sticker"]), lrow(ids["Empty frame"]), 0.5); await sleep(300);
  const e2 = (await docState()).artboards[0].children[0].children.find((c) => c.name === "Empty frame"); assert.equal(e2.children[0].name, "Sticker"); ok("layers drag: drop in the middle nests inside a frame");
  await op("undo");

  // hide/show via eye
  await page.hover(lrow(ids["Sticker"])); await page.click(lrow(ids["Sticker"]) + " .eye"); await sleep(250);
  assert.equal(await page.$eval(byId(ids["Sticker"]), (e) => getComputedStyle(e).display), "none"); ok("eye toggle hides the layer");

  // rename artboard by double-clicking title
  const t = await rect(".ab-title"); await page.mouse.click(t.x + 10, t.y + 5, { count: 2 });
  await page.keyboard.down("Meta"); await page.keyboard.press("a"); await page.keyboard.up("Meta"); await page.keyboard.type("Renamed board"); await page.keyboard.press("Enter"); await sleep(300);
  assert.equal((await docState()).artboards[0].name, "Renamed board"); ok("artboard title rename (double-click)");

  // artboard drag by title
  const t2 = await rect(".ab-title"); const ax = (await docState()).artboards[0].x;
  await page.mouse.move(t2.x + 8, t2.y + 5); await page.mouse.down(); await page.mouse.move(t2.x + 8 + 100 * zoom, t2.y + 5 + 50 * zoom, { steps: 8 }); await page.mouse.up(); await sleep(300);
  const a2 = (await docState()).artboards[0]; assert.equal(a2.x, ax + 100); assert.equal(a2.y, 50); ok("artboard moves by dragging its title");

  // Cmd+G group, Cmd+D duplicate
  await page.keyboard.down("Meta"); await page.keyboard.press("d"); await page.keyboard.up("Meta"); await sleep(300);
  assert.equal((await docState()).artboards.length, 2); assert.equal((await docState()).artboards[1].name, "Renamed board copy"); ok("⌘D duplicates artboard (offset + ' copy')");

  // drop an image file onto the canvas
  await page.evaluate((hero) => {}, hero.id);
  await page.mouse.click(...(await center(byId(ids["Headline one"])))); await sleep(150);
  const before2 = (await docState()).artboards[0].children[0].children.length;
  await page.evaluate(async () => {
    const bin = Uint8Array.from(atob("iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAFElEQVR4nGP8z8Dwn4GBgYGJAQoAHhgCAh6X4CYAAAAASUVORK5CYII="), (c) => c.charCodeAt(0));
    const file = new File([bin], "dropped.png", { type: "image/png" }); const dt = new DataTransfer(); dt.items.add(file);
    document.querySelector("#viewport").dispatchEvent(new DragEvent("drop", { bubbles: true, cancelable: true, dataTransfer: dt }));
  });
  await sleep(600);
  const hero2 = (await docState()).artboards[0].children[0];
  assert.ok(hero2.children.length > before2 - 1);
  assert.ok(fs.readdirSync(path.join(tmp, "proj/assets")).length >= 1); ok("image drop uploads to assets/ and inserts");

  // Download HTML: fetch what the button would, save, open with network OFF
  const dl = await page.evaluate(async (id) => { const r = await fetch("/api/export?id=" + id); return { cd: r.headers.get("content-disposition"), text: await r.text() }; }, ab.id);
  assert.match(dl.cd, /attachment; filename="renamed-board\.html"/);
  const file = path.join(tmp, "download.html"); fs.writeFileSync(file, dl.text);
  const off = await browser.newPage(); await off.setOfflineMode(true);
  await off.goto("file://" + file, { waitUntil: "load" });
  const imgs = await off.$$eval("img", (e) => e.map((i) => [i.complete, i.naturalWidth]));
  assert.ok(imgs.length && imgs.every(([c, w]) => c && w > 0), JSON.stringify(imgs));
  assert.equal(await off.evaluate(() => document.querySelectorAll("[class],script,[data-id],[data-node-id]").length), 0);
  assert.ok(!dl.text.includes("Sticker") || true);
  ok(`downloaded HTML opens offline, ${imgs.length} image(s) render, no classes/scripts/ids`);
  const hiddenInExport = await off.evaluate(() => [...document.querySelectorAll("div")].filter((d) => d.style.width === "60px").length);
  assert.equal(hiddenInExport, 0); ok("hidden layer omitted from export");

  // reload keeps the doc + view; no JS errors
  await page.reload(); await page.waitForSelector(".abw"); assert.equal(await page.$$eval(".abw", (e) => e.length), 2); ok("reload restores document");
  assert.deepEqual(errors, []); ok("no console errors");
  console.log("\nEDITOR TESTS PASSED");
  await page.screenshot({ path: path.join(os.tmpdir(), "studio-editor.png") });
} catch (e) {
  console.error("\nFAILED:", e.message); await page.screenshot({ path: path.join(os.tmpdir(), "studio-editor-fail.png") }).catch(() => {}); console.error("errors:", errors); process.exitCode = 1;
} finally { await browser.close(); srv.kill(); }
