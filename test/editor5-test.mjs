// Fifth editor suite: home screen and projects, project switching (also by Claude), menus, the bottom toolbar.
// Run: node test/editor5-test.mjs
import puppeteer from "puppeteer-core";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "studio-ed5-"));
const PORT = 4783, BASE = `http://127.0.0.1:${PORT}`;
// a projects folder (not one pinned project), like the real app; the first run seeds the demo
const srv = spawn(process.execPath, [path.join(root, "server/server.js")], { env: { ...process.env, STUDIO_PORT: PORT, STUDIO_PROJECT: "", STUDIO_PROJECTS: tmp }, stdio: "ignore" });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
for (let i = 0; i < 40; i++) { try { await fetch(BASE + "/api/ping"); break; } catch { await sleep(150); } }
const op = async (name, args = {}) => { const r = await fetch(BASE + "/api/op", { method: "POST", body: JSON.stringify({ op: name, args }) }); const j = await r.json(); if (!r.ok) throw new Error(j.error); return j.result; };
const ok = (m) => console.log("  ✓", m);
const CHROME = ["/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge"].find(fs.existsSync);
const browser = await puppeteer.launch({ executablePath: CHROME, headless: true, defaultViewport: { width: 1440, height: 900 } });
const page = await browser.newPage();
const errors = [];
page.on("pageerror", (e) => errors.push(e.message));
page.on("console", (m) => m.type() === "error" && !/fonts\.g|net::ERR/.test(m.text()) && errors.push(m.text()));
const visible = (sel) => page.$eval(sel, (e) => { let x = e; while (x) { if (x.hidden || getComputedStyle(x).display === "none") return false; x = x.parentElement; } const b = e.getBoundingClientRect(); return b.width > 0 && b.height > 0; }).catch(() => false);

try {
  await page.goto(BASE); await sleep(800);
  assert.ok(await visible("#home"), "home is the start screen");
  const cards = await page.$$eval(".pcard", (c) => c.map((x) => x.querySelector(".pname").textContent));
  assert.deepEqual(cards, ["Welcome email"]); ok("first run: home screen with the demo project");
  assert.ok(await page.$(".pcard iframe"), "live thumbnail");
  const thumbOk = await page.$eval(".pcard iframe", (f) => new Promise((r) => { const check = () => { try { r(f.contentDocument.body.children.length > 0); } catch { r(false); } }; f.contentDocument?.readyState === "complete" ? check() : f.onload = check; }));
  assert.ok(thumbOk, "thumbnail renders the first artboard"); ok("project cards show a live preview of the first artboard");

  // new from a preset
  await page.click('.newcard[data-new="1"]'); await sleep(900);
  assert.equal(await visible("#home"), false); assert.match(await page.evaluate(() => location.hash), /#\/edit/);
  let info = await op("info");
  assert.equal(info.projectName, "Instagram post"); assert.equal(info.artboards.length, 1); assert.equal(info.artboards[0].width, "1080px");
  assert.equal(await page.$eval("#proj-name", (e) => e.textContent), "Instagram post");
  assert.match(await page.title(), /Instagram post — Studio/);
  ok("New → Instagram post creates a project with a 1080×1080 artboard and opens it");

  // rename from the top bar
  await page.click("#proj-name"); await page.keyboard.down("Meta"); await page.keyboard.press("a"); await page.keyboard.up("Meta");
  await page.keyboard.type("Summer launch"); await page.keyboard.press("Enter"); await sleep(300);
  assert.equal((await op("info")).projectName, "Summer launch"); assert.equal(await page.$eval("#proj-name", (e) => e.textContent), "Summer launch");
  ok("click the project name to rename it");

  // bottom toolbar: draw into it
  await page.click('#toolbar [data-tool="rect"]');
  assert.equal(await page.$eval('#toolbar [data-tool="rect"]', (b) => b.classList.contains("on")), true);
  const ab = await page.$eval(".abw > [data-id]", (e) => { const b = e.getBoundingClientRect(); return { x: b.x, y: b.y, w: b.width, h: b.height }; });
  await page.mouse.move(ab.x + 40, ab.y + 40); await page.mouse.down(); await page.mouse.move(ab.x + 160, ab.y + 140, { steps: 5 }); await page.mouse.up(); await sleep(400);
  info = await op("info"); assert.equal(info.artboards[0].childCount, 1); ok("bottom toolbar tools draw on the canvas");

  // right-click menu
  const rect = await page.$eval(".abw > [data-id] > [data-id]", (e) => { const b = e.getBoundingClientRect(); return [b.x + b.width / 2, b.y + b.height / 2]; });
  await page.mouse.click(rect[0], rect[1], { button: "right" }); await sleep(150);
  assert.ok(await visible("#ctx"));
  const labels = await page.$$eval("#ctx .mi", (b) => b.map((x) => x.firstChild.textContent));
  for (const l of ["Copy", "Duplicate", "Delete", "Bring to front", "Group", "Hide", "Rename"]) assert.ok(labels.includes(l), "menu has " + l);
  await page.evaluate(() => [...document.querySelectorAll("#ctx .mi")].find((b) => b.firstChild.textContent === "Duplicate").click()); await sleep(400);
  assert.equal((await op("info")).artboards[0].childCount, 2); ok("right-click menu: Duplicate works");
  await page.mouse.click(rect[0], rect[1], { button: "right" }); await sleep(150);
  await page.evaluate(() => [...document.querySelectorAll("#ctx .mi")].find((b) => b.firstChild.textContent === "Hide").click()); await sleep(400);
  const kids = (await op("children", { nodeId: info.artboards[0].id }));
  assert.ok((await (await fetch(BASE + "/api/doc")).json()).state.artboards[0].children.some((c) => c.hidden)); ok("right-click menu: Hide");
  await page.keyboard.press("Escape");
  const vp = await page.$eval("#viewport", (e) => { const b = e.getBoundingClientRect(); return [b.x + 12, b.y + 12]; });
  await page.mouse.click(vp[0], vp[1], { button: "right" }); await sleep(150);
  const emptyLabels = await page.$$eval("#ctx .mi", (b) => b.map((x) => x.firstChild.textContent));
  assert.ok(emptyLabels.includes("New artboard…") && emptyLabels.includes("Zoom to fit")); ok("right-click on empty canvas: paste / new artboard / zoom");
  await page.keyboard.press("Escape"); assert.equal(await visible("#ctx"), false);

  // export + zoom menus
  await page.click("#btn-export"); await sleep(100);
  assert.ok(await visible("#export-menu")); assert.ok(await visible("#btn-png")); assert.ok(await visible("#btn-email"));
  await page.click("#btn-export"); assert.equal(await visible("#export-menu"), false); ok("Export menu: PNG / HTML / Email");
  await page.click("#zoom-label"); await sleep(100);
  await page.evaluate(() => [...document.querySelectorAll("#ctx .mi")].find((b) => b.firstChild.textContent === "100%").click()); await sleep(100);
  assert.equal(await page.$eval("#zoom-label", (e) => e.textContent), "100%"); ok("zoom menu");

  // Claude switches project: the window follows
  await op("openProject", { id: "welcome" }); await sleep(500);
  assert.equal(await page.$eval("#proj-name", (e) => e.textContent), "Welcome email");
  assert.ok(await page.$$eval(".abw", (a) => a.length) === 1 && (await page.$eval(".ab-title", (t) => t.textContent)) === "Welcome email");
  ok("opening a project from outside (Claude's open_project) switches the editor live");

  // home: open, duplicate, delete
  await page.click("#btn-home"); await sleep(600);
  assert.ok(await visible("#home"));
  let names = await page.$$eval(".pcard .pname", (c) => c.map((x) => x.textContent));
  assert.deepEqual(names.sort(), ["Summer launch", "Welcome email"]);
  assert.equal(await page.$eval(".pcard.current .pname", (e) => e.textContent), "Welcome email"); ok("home lists projects, newest first, marks the open one");
  await page.type("#home-search", "summ"); await sleep(300);
  assert.deepEqual(await page.$$eval(".pcard .pname", (c) => c.map((x) => x.textContent)), ["Summer launch"]); ok("search");
  await page.$eval("#home-search", (e) => { e.value = ""; e.dispatchEvent(new Event("input")); }); await sleep(300);
  const more = await page.$('.pcard[data-pid="summer-launch"] .more, .pcard[data-pid="instagram-post"] .more');
  await more.click(); await sleep(150);
  await page.evaluate(() => [...document.querySelectorAll("#ctx .mi")].find((b) => b.firstChild.textContent === "Duplicate").click()); await sleep(500);
  names = await page.$$eval(".pcard .pname", (c) => c.map((x) => x.textContent));
  assert.ok(names.includes("Summer launch copy")); ok("duplicate a project");
  const copyCard = await page.$$eval(".pcard", (c) => c.find((x) => x.querySelector(".pname").textContent === "Summer launch copy").dataset.pid);
  await page.click(`.pcard[data-pid="${copyCard}"] .more`); await sleep(150);
  await page.evaluate(() => [...document.querySelectorAll("#ctx .mi")].find((b) => b.firstChild.textContent === "Move to Trash").click()); await sleep(150);
  await page.click("#c-ok"); await sleep(500);
  names = await page.$$eval(".pcard .pname", (c) => c.map((x) => x.textContent));
  assert.ok(!names.includes("Summer launch copy")); assert.ok(fs.readdirSync(path.join(tmp, ".trash")).length === 1, "kept in .trash");
  ok("move a project to the trash (kept in .trash, not erased)");
  await page.click(`.pcard[data-pid="${await page.$$eval(".pcard", (c) => c.find((x) => x.querySelector(".pname").textContent === "Summer launch").dataset.pid)}"]`); await sleep(700);
  assert.equal((await op("info")).projectName, "Summer launch"); assert.equal(await visible("#home"), false); ok("click a card to open it");

  // trash view: restore, delete selected / all, with confirmation
  for (const n of ["A", "B", "C"]) { const r = await op("createProject", { name: "Trash " + n }); await op("deleteProject", { id: r.id }); }
  await op("openProject", { id: (await op("projects"))[0].id });
  await page.evaluate(() => (location.hash = "#/")); await sleep(500);
  await page.click("#btn-trash"); await sleep(400);
  assert.equal((await page.$$(".tcard")).length, 4, "4 trashed projects (incl. Summer launch copy)");
  await page.click("#trash-selall"); await sleep(100);
  assert.equal(await page.$$eval(".tcard.sel", (c) => c.length), 4); ok("select all in the trash");
  await page.click("#trash-selall"); await sleep(100);
  await page.click(".tcard:nth-child(1)"); await sleep(150); await page.click(".tcard:nth-child(2)"); await sleep(150);
  assert.equal(await page.$eval("#trash-sel", (e) => e.textContent), "2 selected"); ok("select several");
  await page.click("#trash-delsel"); await sleep(150);
  assert.ok(await visible("#c-ok"), "asks to confirm");
  await page.click("#c-no"); await sleep(100);
  assert.equal(fs.readdirSync(path.join(tmp, ".trash")).length, 4, "cancel keeps everything"); ok("cancel deletes nothing");
  await page.click("#trash-delsel"); await sleep(100); await page.click("#c-ok"); await sleep(500);
  assert.equal(fs.readdirSync(path.join(tmp, ".trash")).length, 2); ok("delete selected permanently");
  await page.click(".tcard:nth-child(1)"); await sleep(100); await page.click("#trash-restore"); await sleep(500);
  assert.equal(fs.readdirSync(path.join(tmp, ".trash")).length, 1); ok("restore from the trash");
  await page.click("#trash-empty"); await sleep(100); await page.click("#c-ok"); await sleep(500);
  assert.equal(fs.readdirSync(path.join(tmp, ".trash")).length, 0); ok("empty the trash");
  await page.click("#trash-back"); await sleep(400);
  assert.equal((await page.$$eval(".pcard .pname", (c) => c.map((x) => x.textContent))).filter((x) => x.startsWith("Trash ")).length, 1); ok("restored project is back");
  await page.click(`.pcard[data-pid="${(await op("projects")).find((p) => p.name === "Summer launch").id}"]`); await sleep(700);

  // the open project survives a restart
  assert.equal(fs.readFileSync(path.join(tmp, ".current"), "utf8"), (await op("info")).projectId); ok("the open project is remembered");

  assert.deepEqual(errors, []); ok("no console errors");
  console.log("\nEDITOR SUITE 5 PASSED");
} catch (e) {
  console.error("\nFAILED:", e.stack?.split("\n").slice(0, 4).join("\n") || e.message); await page.screenshot({ path: path.join(os.tmpdir(), "studio-editor5-fail.png") }).catch(() => {}); console.error("errors:", errors); process.exitCode = 1;
} finally { await browser.close(); srv.kill(); }
