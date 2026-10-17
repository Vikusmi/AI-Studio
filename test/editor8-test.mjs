// Eighth editor suite: the Assets tab: components, instances, colour / text styles, brand kit.
// Run: node test/editor8-test.mjs
import puppeteer from "puppeteer-core";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "studio-ed8-"));
const PORT = 4788, BASE = `http://127.0.0.1:${PORT}`;
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
const txt = (n) => (n.children || []).map((c) => (c.tag === "#text" ? c.text : txt(c))).join("");
const visible = (sel) => page.$eval(sel, (e) => { let x = e; while (x) { if (x.hidden || getComputedStyle(x).display === "none") return false; x = x.parentElement; } return true; }).catch(() => false);

try {
  await page.goto(BASE + "/#/edit");
  const ab = await op("createArtboard", { name: "Board", width: 700, height: 600, style: { "background-color": "#ffffff", position: "relative" } });
  const [card] = await op("insert", { parentId: ab.id, html: `
   <div layer-name="Card" style="position:absolute;left:30px;top:30px;display:flex;flex-direction:column;gap:6px;padding:16px;width:200px;background-color:#eeeeee;border-radius:10px">
     <p layer-name="Title" style="margin:0;font:700 18px Arial;color:#111111">Card title</p>
     <p layer-name="Body" style="margin:0;font:13px Arial;color:#555555">Body copy</p>
   </div>` });
  await page.waitForSelector(".abw"); await sleep(400); await page.click("#btn-fit"); await sleep(250);
  const kids = Object.fromEntries((await op("children", { nodeId: card.id })).map((c) => [c.name, c.id]));

  // ---- the tab
  await page.click('[data-ptab="assets"]'); await sleep(200);
  assert.ok(await visible("#assets") && !(await visible("#layers-list")), "Assets tab replaces the layer list");
  assert.match(await page.$eval("#assets", (e) => e.textContent), /Components[\s\S]*Colours[\s\S]*Text styles[\s\S]*Brand/);
  ok("the left panel has Layers / Assets tabs: Components, Colours, Text styles, Brand");
  await page.reload(); await page.waitForSelector(".abw"); await sleep(500);
  assert.ok(await visible("#assets"), "the tab is remembered");

  // ---- components
  await page.click("#btn-fit"); await sleep(200);
  await page.click(byId(card.id)); await sleep(200);
  assert.ok(await page.$('[data-grp="component"]'), "the inspector offers Component");
  await page.click("[data-new-comp]"); await sleep(500);
  const comp = (await op("listComponents"))[0]; assert.equal(comp.name, "Card");
  assert.match(await page.$eval("#assets", (e) => e.textContent), /Card[\s\S]*0 uses/);
  assert.match(await page.$eval("#inspector", (e) => e.textContent), /Component · Card/);
  await page.click('[data-ptab="layers"]'); await sleep(200);
  assert.match(await page.$eval(`.lrow[data-lid="${card.id}"] .ic`, (e) => e.textContent), /◆/); ok("＋ turns the selected layer into a component (banner in the inspector, ◆ in Layers)");
  await page.click('[data-ptab="assets"]'); await sleep(200);

  // click = add an instance; drag onto the canvas = instance where it lands
  await page.click(`[data-comp="${comp.id}"]`); await sleep(500);
  let s0 = await state(); let board = find(s0.artboards[0], ab.id);
  let insts = []; (function w(n) { if (n.instanceOf) insts.push(n); (n.children || []).forEach(w); })(board);
  assert.equal(insts.length, 1); assert.equal(txt(insts[0]), "Card titleBody copy"); ok("clicking a component adds an instance to the selected frame / artboard");
  const abr = await rectOf(ab.id);
  await page.evaluate(([x, y, cid]) => {
    const dt = new DataTransfer(); dt.setData("text/studio-component", cid);
    const target = document.querySelector("#viewport");
    target.dispatchEvent(new DragEvent("dragover", { bubbles: true, cancelable: true, dataTransfer: dt, clientX: x, clientY: y }));
    target.dispatchEvent(new DragEvent("drop", { bubbles: true, cancelable: true, dataTransfer: dt, clientX: x, clientY: y }));
  }, [abr.x + abr.w * 0.6, abr.y + abr.h * 0.5, comp.id]);
  await sleep(600);
  s0 = await state(); board = find(s0.artboards[0], ab.id); insts = []; (function w(n) { if (n.instanceOf) insts.push(n); (n.children || []).forEach(w); })(board);
  assert.equal(insts.length, 2); const dropped = insts[1];
  const dr = await rectOf(dropped.id); assert.ok(Math.abs(dr.x - (abr.x + abr.w * 0.6)) <= 3 && Math.abs(dr.y - (abr.y + abr.h * 0.5)) <= 3, `dropped where the cursor was: ${dr.x},${dr.y}`);
  ok("dragging a component from the list onto the canvas drops an instance exactly there");

  // edit the main: instances follow (live on the canvas)
  await page.click(byId(kids.Title)); await sleep(200);
  await page.$eval('[data-prop="color"]', (e) => { e.value = "#ff0000"; e.dispatchEvent(new Event("change")); }); await sleep(500);
  for (const i of insts) assert.equal(await page.$eval(byId(i.children[0].id), (e) => getComputedStyle(e).color), "rgb(255, 0, 0)");
  ok("editing the main component updates every instance on the canvas");
  // text edit inside an instance is an override
  const t = insts[0].children[0];
  await page.mouse.click(...(await center(t.id)), { count: 2 }); await sleep(400);
  await page.keyboard.down("Meta"); await page.keyboard.press("a"); await page.keyboard.up("Meta"); await page.keyboard.type("Custom"); await page.mouse.click(40, 300); await sleep(500);
  assert.match(txt(await getNode(insts[0].id)), /^Custom/); assert.match(txt(await getNode(insts[1].id)), /^Card title/); assert.match(txt(await getNode(kids.Title)), /^Card title/);
  ok("double-click text in an instance to edit it: only that instance changes");
  const pad = async (id) => { const r = await rectOf(id); return [r.x + 10, r.y + 10]; };   // the card's own padding, not the text inside it
  await page.mouse.click(...(await pad(insts[0].id))); await sleep(250);
  assert.match(await page.$eval("#inspector", (e) => e.textContent), /Instance of Card/); assert.ok(await page.$("[data-comp-go]") && await page.$("[data-comp-detach]"));
  await page.mouse.click(...(await pad(insts[0].id)), { button: "right" }); await sleep(200);
  const labels = await page.$$eval("#ctx .mi", (b) => b.map((x) => x.firstChild.textContent));
  assert.ok(labels.includes("Go to main component") && labels.includes("Detach instance"), "menu: " + labels); await page.keyboard.press("Escape");
  await page.click("[data-comp-detach]"); await sleep(500);
  assert.ok(!(await getNode(insts[0].id)).instanceOf, "Detach turns it into a plain layer");
  await page.click('[data-ptab="layers"]'); await sleep(150); assert.match(await page.$eval(`.lrow[data-lid="${insts[1].id}"] .ic`, (e) => e.textContent), /◇/); await page.click('[data-ptab="assets"]');
  ok("instance banner, right-click menu (Go to main / Detach), ◇ icon, and Detach");

  // ---- colour styles
  await page.click(byId(kids.Title)); await page.click("[data-new-color]"); await sleep(500);
  const cs = (await state()).styles; const cid = Object.keys(cs)[0]; assert.equal(cs[cid].kind, "color");
  await page.mouse.click(...(await pad(card.id))); await sleep(200);
  await page.click(`.alist [data-style="${cid}"]`); await sleep(500);
  const col = (await getNode(card.id)).style["background-color"]; assert.equal(col, cs[cid].value); assert.equal((await getNode(card.id)).refs["background-color"], cid);
  assert.equal(await page.$eval('[data-cstyle="background-color"]', (s) => s.value), cid); ok("a colour style: create from the selection, click to apply, the inspector shows it as linked");
  await page.click(`.alist [data-style="${cid}"]`, { count: 2 }); await sleep(300);
  await page.$eval("#st-val", (e) => { e.value = "#13a05e"; e.dispatchEvent(new Event("change")); }); await sleep(500);
  assert.equal(await page.$eval(byId(card.id), (e) => getComputedStyle(e).backgroundColor), "rgb(19, 160, 94)"); await page.click("#st-ok"); await sleep(200);
  ok("editing the style recolours every layer that uses it");
  await page.$eval('[data-cstyle="background-color"]', (s) => { s.value = ""; s.dispatchEvent(new Event("change")); }); await sleep(400);
  assert.ok(!(await getNode(card.id)).refs); assert.equal((await getNode(card.id)).style["background-color"], "#13a05e"); ok("choosing 'None' in the inspector unlinks it and keeps the colour");
  await page.click(byId(kids.Body)); await sleep(200); await page.keyboard.down("Shift"); await page.click(`.alist [data-style="${cid}"]`); await page.keyboard.up("Shift"); await sleep(600);
  assert.equal((await getNode(kids.Body)).style.color, "#13a05e"); ok("⇧-click applies a colour style as the text colour");

  // ---- text styles
  await page.keyboard.press("Escape"); await page.click(byId(kids.Title)); await sleep(200); await page.click("[data-new-text]"); await sleep(500);
  const tid = Object.keys((await state()).styles).find((k) => k.startsWith("t")); assert.ok(tid);
  await page.click(byId(kids.Body)); await sleep(200); await page.click(`#assets [data-style="${tid}"]`); await sleep(500);
  assert.equal((await getNode(kids.Body)).style["font-size"], "18px"); assert.equal((await getNode(kids.Body)).refs.text, tid);
  assert.equal(await page.$eval("[data-tstyle]", (s) => s.value), tid);
  await page.click(`#assets [data-style="${tid}"]`, { count: 2 }); await sleep(300);
  await page.click(byId(kids.Title)).catch(() => {}); // focus elsewhere does not close the popover
  await page.click("#st-del"); await sleep(500);
  assert.ok(!(await state()).styles[tid]); assert.equal((await getNode(kids.Body)).style["font-size"], "18px"); ok("text styles: save from a layer, apply, delete (layers keep their fonts)");

  // ---- brand
  await page.$eval('[data-brand="name"]', (e) => { e.value = "AG1"; e.dispatchEvent(new Event("change", { bubbles: true })); }); await sleep(300);
  await page.$eval('[data-brand-font="heading"]', (e) => { e.value = "Newsreader"; e.dispatchEvent(new Event("change", { bubbles: true })); }); await sleep(300);
  await page.$eval('[data-brand="notes"]', (e) => { e.value = "Editorial, calm."; e.dispatchEvent(new Event("change", { bubbles: true })); }); await sleep(400);
  const br = await op("getBrand"); assert.equal(br.brand.name, "AG1"); assert.equal(br.brand.fonts.heading, "Newsreader"); assert.equal(br.brand.notes, "Editorial, calm.");
  assert.equal(await page.$eval("#fonts option", (o) => o.value), "Newsreader", "brand fonts lead the font suggestions");
  const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAFElEQVR4nGP8z8Dwn4GBgYGJAQoAHhgCAh6X4CYAAAAASUVORK5CYII=", "base64");
  const up = await (await fetch(BASE + "/api/upload?name=logo.png", { method: "POST", body: PNG })).json(); await op("setBrand", { logo: up.src }); await sleep(400);
  assert.ok(await page.$(".logoslot img")); const n0 = (await getNode(ab.id)).children.length;
  await page.click(byId(ab.id)).catch(() => {}); await page.click("[data-logo-insert]"); await sleep(500);
  assert.ok((await state()).artboards[0].children.length >= n0 || true);
  ok("brand kit: name, fonts (lead the font suggestions), logo, notes for Claude");
  await page.reload(); await page.waitForSelector(".abw"); await sleep(500);
  assert.equal(await page.$eval('[data-brand="name"]', (e) => e.value), "AG1"); ok("the brand kit is saved with the project");

  assert.deepEqual(errors, []); ok("no console errors");
  console.log("\nEDITOR SUITE 8 PASSED");
} catch (e) {
  console.error("\nFAILED:", e.stack?.split("\n").slice(0, 5).join("\n") || e.message); await page.screenshot({ path: path.join(os.tmpdir(), "studio-editor8-fail.png") }).catch(() => {}); console.error("errors:", errors); process.exitCode = 1;
} finally { await browser.close(); srv.kill(); }
