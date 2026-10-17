// Layer order: the Layers panel lists the front-most layer first; ⌘] ⌘[ (and Shift) move one visible step, for one or several layers,
// as one undo step; the right-click menu and dragging in the panel agree with them.
import puppeteer from "puppeteer-core";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "studio-layers-"));
const PORT = 4801, BASE = `http://127.0.0.1:${PORT}`;
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
page.on("console", (m) => m.type() === "error" && !/fonts\.g|net::ERR|502/.test(m.text()) && errors.push(m.text()));
const names = async (abId) => { const s = (await (await fetch(BASE + "/api/doc")).json()).state; return s.artboards.find((a) => a.id === abId).children.filter((c) => c.tag !== "#text").map((c) => c.name); };
const panel = () => page.$$eval(".lrow:not(.art) .nm", (e) => e.map((x) => x.textContent));
const chord = async (code, key, shift) => { await page.keyboard.down("Meta"); if (shift) await page.keyboard.down("Shift"); await page.keyboard.down(code === "BracketRight" ? "]" : "["); await page.evaluate(() => {}); await page.keyboard.up(code === "BracketRight" ? "]" : "["); if (shift) await page.keyboard.up("Shift"); await page.keyboard.up("Meta"); await sleep(300); };
// a real keyboard sends "}" / "{" for Shift+] / Shift+[ : dispatch exactly that
const realShift = async (code) => { await page.evaluate((code) => dispatchEvent(new KeyboardEvent("keydown", { key: code === "BracketRight" ? "}" : "{", code, metaKey: true, shiftKey: true, bubbles: true, cancelable: true })), code); await sleep(300); };
try {
  await page.goto(BASE + "/#/edit");
  const ab = await op("createArtboard", { name: "A", width: 400, height: 300, style: { position: "relative" } });
  const ins = await op("insert", { parentId: ab.id, html: ["A", "B", "C", "D"].map((n, i) => `<div layer-name="${n}" style="position:absolute;left:${i * 20}px;top:${i * 20}px;width:80px;height:80px;background-color:#${["f00", "0f0", "00f", "ff0"][i]}"></div>`).join(" ") });
  const id = Object.fromEntries(ins.map((n, i) => ["ABCD"[i], n.id]));
  await sleep(600);
  assert.deepEqual(await names(ab.id), ["A", "B", "C", "D"]);
  assert.deepEqual(await panel(), ["D", "C", "B", "A"]); ok("the Layers panel lists the front-most layer first");
  await page.click(`.lrow[data-lid="${id.A}"] .nm`); await sleep(150);
  await chord("BracketRight"); assert.deepEqual(await names(ab.id), ["B", "A", "C", "D"]); assert.deepEqual(await panel(), ["D", "C", "A", "B"]); ok("⌘] brings forward one step, and its row moves up");
  await chord("BracketLeft"); assert.deepEqual(await names(ab.id), ["A", "B", "C", "D"]);
  await chord("BracketLeft"); assert.deepEqual(await names(ab.id), ["A", "B", "C", "D"]); ok("⌘[ sends back one step; at the back nothing changes");
  await realShift("BracketRight"); assert.deepEqual(await names(ab.id), ["B", "C", "D", "A"]);
  await realShift("BracketLeft"); assert.deepEqual(await names(ab.id), ["A", "B", "C", "D"]); ok("⇧⌘] / ⇧⌘[ work with a real keyboard (Shift types } and {)");
  // several layers at once, keeping their relative order, in one undo step
  await page.click(`.lrow[data-lid="${id.A}"] .nm`); await page.keyboard.down("Shift"); await page.click(`.lrow[data-lid="${id.C}"]`); await page.keyboard.up("Shift"); await sleep(150);
  await chord("BracketRight"); assert.deepEqual(await names(ab.id), ["B", "A", "D", "C"]);
  await realShift("BracketRight"); assert.deepEqual(await names(ab.id), ["B", "D", "A", "C"]);
  await op("undo"); await op("undo"); assert.deepEqual(await names(ab.id), ["A", "B", "C", "D"]); ok("several selected layers move together, one undo per step");
  // right-click menu
  await page.click(`.lrow[data-lid="${id.D}"] .nm`); await sleep(150);
  const b = await page.$eval(`[data-id="${id.D}"]`, (e) => { const r = e.getBoundingClientRect(); return [r.right - 10, r.bottom - 10]; });
  await page.mouse.click(b[0], b[1], { button: "right" }); await sleep(200);
  await page.evaluate(() => [...document.querySelectorAll("#ctx button")].find((x) => /^Send to back/.test(x.textContent)).click()); await sleep(300);
  assert.deepEqual(await names(ab.id), ["D", "A", "B", "C"]); ok("right-click → Send to back");
  // dragging in the panel: above a row = in front of it
  const dnd = (from, to, frac) => page.evaluate(([f, t, frac]) => { const a = document.querySelector(f), b = document.querySelector(t), dt = new DataTransfer(), r = b.getBoundingClientRect(), cy = r.top + r.height * frac;
    a.dispatchEvent(new DragEvent("dragstart", { bubbles: true, dataTransfer: dt })); b.dispatchEvent(new DragEvent("dragover", { bubbles: true, cancelable: true, dataTransfer: dt, clientY: cy, clientX: r.left + 20 })); b.dispatchEvent(new DragEvent("drop", { bubbles: true, cancelable: true, dataTransfer: dt, clientY: cy, clientX: r.left + 20 })); }, [from, to, frac]);
  await dnd(`.lrow[data-lid="${id.D}"]`, `.lrow[data-lid="${id.C}"]`, 0.1); await sleep(300);
  assert.deepEqual(await names(ab.id), ["A", "B", "C", "D"]); assert.deepEqual(await panel(), ["D", "C", "B", "A"]); ok("dropping a row above another puts the layer in front of it");
  await dnd(`.lrow[data-lid="${id.D}"]`, `.lrow[data-lid="${id.A}"]`, 0.9); await sleep(300);
  assert.deepEqual(await names(ab.id), ["D", "A", "B", "C"]); ok("dropping below a row puts it behind");
  await op("undo");
  // text pieces between layers never swallow a step
  const ab2 = await op("createArtboard", { name: "Mixed", width: 300, height: 200 });
  const m = await op("insert", { parentId: ab2.id, html: `<div layer-name="P">one</div> and <div layer-name="Q">two</div> <div layer-name="R">three</div>` });
  const mid = Object.fromEntries(m.map((n) => [n.name, n.id])); await sleep(300);
  await op("reorder", { nodeIds: [mid.P], to: "forward" }); assert.deepEqual(await names(ab2.id), ["Q", "P", "R"]);
  await op("reorder", { nodeIds: [mid.P], to: "front" }); assert.deepEqual(await names(ab2.id), ["Q", "R", "P"]); ok("loose text between layers doesn't swallow a step");
  assert.equal(await op("reorder", { nodeIds: [mid.P], to: "front" }), false);
  await assert.rejects(op("reorder", { nodeIds: [mid.P, id.A], to: "front" }), /same frame/); ok("layers from different frames are refused clearly");
  assert.deepEqual(errors, []); console.log("\nLAYERS PASSED");
} catch (e) { console.error("\nFAILED:", e.stack?.split("\n").slice(0, 6).join("\n"), errors); process.exitCode = 1; } finally { await browser.close(); srv.kill(); }
