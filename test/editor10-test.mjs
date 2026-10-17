// Tenth editor suite: the Ask Claude panel (with a fake claude).
import puppeteer from "puppeteer-core";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "studio-ed10-"));
const PORT = 4795, BASE = `http://127.0.0.1:${PORT}`;
const srv = spawn(process.execPath, [path.join(root, "server/server.js")], { env: { ...process.env, STUDIO_PORT: PORT, STUDIO_PROJECT: path.join(tmp, "proj"), STUDIO_CLAUDE_BIN: path.join(root, "test/fixtures/fake-claude.mjs") }, stdio: "ignore" });
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
const node = async (id) => (await op("node", { nodeId: id }));
try {
  await page.goto(BASE + "/#/edit");
  const ab = await op("createArtboard", { name: "A", width: 400, height: 300 });
  const [box] = await op("insert", { parentId: ab.id, html: `<div layer-name="Hero" style="width:100px;height:50px;background-color:#00ff00"></div>` });
  await sleep(500);
  await page.click("#btn-ask"); await sleep(300);
  assert.equal(await page.$eval("#ask", (e) => e.hidden), false); ok("the Ask button opens the panel");
  await page.click('#ask [data-chip="Shorter"]');
  assert.match(await page.$eval("#ask-text", (e) => e.value), /shorter/i); ok("quick chips fill the request");
  await page.click(`[data-id="${box.id}"]`); await page.click("#ask-text");
  await page.$eval("#ask-text", (e) => (e.value = "make it red"));
  await page.click("#ask-send");
  await page.waitForFunction(() => document.querySelector("#ask-undo") && !document.querySelector("#ask-undo").hidden, { timeout: 8000 });
  const logText = await page.$eval("#ask-log", (e) => e.innerText);
  assert.match(logText, /make it red/); assert.match(logText, /Changing styles/); assert.match(logText, /red/);
  assert.equal((await node(box.id)).style["background-color"], "#ff0000"); ok("a request streams into the panel and edits the canvas live");
  await page.click("#ask-undo"); await sleep(500);
  assert.equal((await node(box.id)).style["background-color"], "#00ff00"); ok("“Undo this run” restores the design");
  await page.keyboard.press("Escape"); await page.click("#ask-close");
  await page.keyboard.down("Meta"); await page.keyboard.press("k"); await page.keyboard.up("Meta"); await sleep(200);
  assert.equal(await page.$eval("#ask", (e) => e.hidden), false); ok("⌘K opens it");
  // export dialog
  await page.click("#ask-close");
  await page.keyboard.down("Meta"); await page.keyboard.down("Shift"); await page.keyboard.press("e"); await page.keyboard.up("Shift"); await page.keyboard.up("Meta"); await sleep(200);
  assert.ok(await page.$("#xdlg .xbox")); ok("⇧⌘E opens the export dialog");
  await page.click('#x-fmt [data-f="jpg"]'); assert.equal(await page.$eval("#x-q-f", (e) => e.style.display), ""); await page.click('#x-fmt [data-f="pdf"]');
  assert.equal(await page.$eval("#x-scale-f", (e) => e.style.display), "none"); await page.click('#x-fmt [data-f="slices"]');
  assert.equal(await page.$eval("#x-scope", (e) => e.disabled), true); ok("the dialog shows only the options that apply to each format");
  await page.keyboard.press("Escape"); await sleep(100); assert.equal(await page.$("#xdlg"), null);
  // version history dialog
  await page.click("#btn-history"); await sleep(300);
  await page.type("#h-name", "Milestone"); await page.click("#h-save"); await sleep(400);
  assert.match(await page.$eval("#h-list", (e) => e.innerText), /Milestone/); ok("history: save a named version");
  await op("updateStyles", { updates: [{ nodeIds: [box.id], styles: { width: "300px" } }] });
  await page.click('#h-list [data-act="restore"]'); await sleep(200); await page.click("#c-ok"); await sleep(600);
  assert.equal((await node(box.id)).style.width, "100px"); assert.equal(await page.$("#xdlg"), null); ok("history: restore from the dialog");
  // custom font upload from the Assets tab
  const FONT = "/System/Library/Fonts/Supplemental/Apple Chancery.ttf";
  await page.click('[data-ptab="assets"]'); await sleep(200);
  const [chooser] = await Promise.all([page.waitForFileChooser(), page.click("[data-add-font]")]);
  await chooser.accept([FONT]); await page.waitForSelector("#ft-ok"); await page.$eval("#ft-name", (e) => (e.value = "Chancery Test")); await page.click("#ft-ok"); await sleep(700);
  assert.match(await page.$eval("#assets", (e) => e.innerText), /Chancery Test/);
  await op("updateStyles", { updates: [{ nodeIds: [box.id], styles: { "font-family": "'Chancery Test'" } }] }); await sleep(400);
  assert.equal(await page.evaluate(() => document.fonts.check("20px 'Chancery Test'")), true); ok("fonts: upload from the Assets tab and use it on the canvas");
  assert.deepEqual(errors, []); console.log("\nEDITOR10 PASSED");
} catch (e) { console.error("\nFAILED:", e.stack?.split("\n").slice(0, 6).join("\n"), errors); process.exitCode = 1; }
finally { await browser.close(); srv.kill(); }
