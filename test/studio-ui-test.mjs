// The studio around Claude, in the browser: home (hero, connection, templates, filters, settings and backups), the quick-action bar
// (Edit and Variations through Ask Claude, with a fake `claude`), notes, Claude's live highlights and the Keep / Undo bar, the notice
// when Claude works on another project, locking, links, picking a variation, the review panel, resize to formats, icons, and that
// a change to one artboard leaves the others' DOM alone. Run: node test/studio-ui-test.mjs
import puppeteer from "puppeteer-core";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "studio-ui-"));
const PORT = 4792, BASE = `http://127.0.0.1:${PORT}`;
try { (await import("node:child_process")).execSync(`lsof -ti tcp:${PORT} | xargs kill`, { stdio: "ignore" }); await new Promise((r) => setTimeout(r, 300)); } catch {}
const srv = spawn(process.execPath, [path.join(root, "server/server.js")], { env: { ...process.env, STUDIO_PORT: PORT, STUDIO_PROJECT: "", STUDIO_PROJECTS: tmp, STUDIO_NO_BACKUP: "1", STUDIO_CLAUDE_BIN: path.join(root, "test/fixtures/fake-claude.mjs") }, stdio: "ignore" });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
for (let i = 0; i < 40; i++) { try { await fetch(BASE + "/api/ping"); break; } catch { await sleep(150); } }
const op = async (name, args = {}, source, projectId) => { const r = await fetch(BASE + "/api/op", { method: "POST", body: JSON.stringify({ op: name, args, source, projectId }) }); const j = await r.json(); if (!r.ok) throw new Error(j.error); return j.result; };
const ok = (m) => console.log("  ✓", m);
const CHROME = ["/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge"].find(fs.existsSync);
const browser = await puppeteer.launch({ executablePath: CHROME, headless: true, defaultViewport: { width: 1440, height: 900 } });
const page = await browser.newPage();
const errors = [];
page.on("pageerror", (e) => errors.push(e.message));
page.on("console", (m) => m.type() === "error" && !/fonts\.g|net::ERR|Failed to load resource/.test(m.text()) && errors.push(m.text()));
const visible = (sel) => page.$eval(sel, (e) => { let x = e; while (x) { if (x.hidden || getComputedStyle(x).display === "none") return false; x = x.parentElement; } const b = e.getBoundingClientRect(); return b.width > 0 && b.height > 0; }).catch(() => false);
const node = (id) => op("node", { nodeId: id });
// a spot on an artboard's empty background (its bottom-right corner)
const corner = async (id) => page.mouse.click(...(await page.$eval(`[data-id="${id}"]`, (e) => { const b = e.getBoundingClientRect(); return [b.right - 6, b.bottom - 6]; })));
const center = async (sel) => page.$eval(sel, (e) => { const b = e.getBoundingClientRect(); return [b.x + b.width / 2, b.y + b.height / 2]; });

try {
  // ---- home ----
  await page.goto(BASE); await sleep(1000);
  assert.ok(await visible(".hero")); assert.match(await page.$eval(".hero h1", (e) => e.textContent), /Claude/);
  assert.ok(await page.$$eval("#try-list .try", (b) => b.length) >= 3, "prompt ideas to copy");
  assert.ok(await visible("#hero-status .pill, #hero-status .connect"), "connection status");
  ok("home: hero with Claude's connection status and prompt ideas");
  const welcome = (await op("projects"))[0].id;
  await op("createProject", { name: "Summer post", artboard: { name: "Post", width: 1080, height: 1080 }, open: false });
  await page.reload(); await sleep(900);
  const kinds = await page.$$eval("#kind-filter [data-kind]", (b) => b.map((x) => x.textContent));
  assert.deepEqual(kinds.sort(), ["All", "Email", "Social"]);
  await page.click('#kind-filter [data-kind="Social"]'); await sleep(400);
  assert.deepEqual(await page.$$eval(".pcard[data-pid] .pname", (c) => c.map((x) => x.textContent)), ["Summer post"]);
  await page.click('#kind-filter [data-kind="All"]'); await sleep(300);
  ok("projects can be filtered by kind (Email, Social…)");
  await page.click("#btn-settings"); await sleep(400);
  assert.ok(await visible("#settings .sbox"));
  await page.click('#settings [data-sa="backup"]'); await sleep(1200);
  assert.equal(fs.readdirSync(path.join(tmp, ".backups")).length, 1, "backup zip written");
  await page.keyboard.press("Escape"); await sleep(200);
  assert.equal(await visible("#settings .sbox"), false);
  ok("settings: Back up now writes a zip of every project");

  // ---- editor: a project with two artboards ----
  await op("openProject", { id: welcome });
  const ab = (await op("info")).artboards[0];
  const ab2 = await op("createArtboard", { name: "Second", width: 400, height: 300 });
  const [box] = await op("insert", { parentId: ab2.id, html: `<div layer-name="Box" style="position:absolute;left:40px;top:40px;width:120px;height:80px;background-color:#00ff00"></div>` });
  const [tile] = await op("insert", { parentId: ab2.id, html: `<span layer-name="Caption" style="position:absolute;left:40px;top:160px;font:20px sans-serif;color:#111">Hello there</span>` });
  await page.goto(BASE + "/#/edit"); await sleep(1200); await page.click("#btn-fit"); await sleep(300);

  // a change to one artboard leaves the other's DOM alone
  await page.evaluate((id) => { document.querySelector(`[data-abw="${id}"]`).__keep = 1; }, ab.id);
  await op("updateStyles", { updates: [{ nodeIds: [box.id], styles: { opacity: "0.8" } }] }); await sleep(300);
  assert.equal(await page.evaluate((id) => document.querySelector(`[data-abw="${id}"]`).__keep, ab.id), 1, "untouched artboard kept its DOM");
  assert.equal(await page.$eval(`[data-id="${box.id}"]`, (e) => e.style.opacity), "0.8");
  ok("only the artboard that changed is redrawn");

  // ---- quick actions on the selection ----
  await page.click(`[data-id="${box.id}"]`); await sleep(300);
  assert.ok(await visible("#selbar")); assert.match(await page.$eval("#selbar .sb-what", (e) => e.textContent), /Box/);
  await page.click('#selbar [data-sb="edit"]'); await sleep(200);
  await page.type("#sb-text", "make it red"); await page.keyboard.press("Enter");
  await page.waitForFunction(() => document.querySelector("#runbar") && !document.querySelector("#runbar").hidden, { timeout: 10000 });
  assert.equal((await node(box.id)).style["background-color"], "#ff0000");
  ok("Edit on the selection bar: Claude changes the selected layer (fake claude)");
  assert.match(await page.$eval("#runbar", (e) => e.textContent), /Claude made 2 changes/);
  await page.click('#runbar [data-rb="undo"]'); await sleep(500);
  assert.equal((await node(box.id)).style["background-color"], "#00ff00"); assert.equal(await visible("#runbar"), false);
  ok("the Keep / Undo bar appears when Claude pauses; Undo puts it back");

  // Claude in the chat (MCP): highlights, the chip, keep
  await op("updateStyles", { updates: [{ nodeIds: [tile.id], styles: { color: "#ff4f1f" } }] }, "mcp"); await sleep(150);
  assert.ok(await page.$(".ai-box"), "highlight on the layer Claude touched");
  assert.match(await page.$eval("#claude-chip", (e) => e.textContent), /Changing styles/);
  await page.waitForFunction(() => !document.querySelector("#runbar").hidden, { timeout: 5000 });
  await page.click('#runbar [data-rb="keep"]'); await sleep(300);
  assert.equal((await op("agentState")).status, "kept"); assert.equal(await visible("#runbar"), false);
  ok("Claude's edits from the chat: highlighted live, chip shows what it does, Keep closes the run");

  // Claude in another project
  const other = (await op("projects")).find((p) => p.name === "Summer post");
  const pab = (await op("info", {}, "mcp", other.id)).artboards[0];
  await op("updateStyles", { updates: [{ nodeIds: [pab.id], styles: { "background-color": "#111111" } }] }, "mcp", other.id); await sleep(300);
  assert.ok(await visible("#bg-note")); assert.match(await page.$eval("#bg-note", (e) => e.textContent), /Summer post/);
  await page.click("#bg-note [data-open]"); await sleep(800);
  assert.equal((await op("info")).projectId, other.id);
  await op("openProject", { id: welcome }); await sleep(800); await page.click("#btn-fit"); await sleep(300);
  ok("when Claude works on another project, a notice offers to open it");

  // ---- notes ----
  await page.click(`[data-id="${tile.id}"]`); await sleep(200);
  await page.keyboard.press("n"); await sleep(200);
  assert.ok(await visible("#note-text"));
  await page.type("#note-text", "Make this bigger"); await page.keyboard.press("Enter"); await sleep(500);
  const notes = await op("notes");
  assert.equal(notes.length, 1); assert.equal(notes[0].text, "Make this bigger"); assert.deepEqual(notes[0].nodeIds, [tile.id]);
  assert.ok(await visible(".note-pin")); assert.equal(await page.$eval("#notes-count", (e) => e.textContent), "1");
  await page.click(".note-pin"); await sleep(200);
  assert.match(await page.$eval("#note-pop", (e) => e.textContent), /Make this bigger/);
  await op("resolveNote", { id: notes[0].id, reply: "Now 40px." }, "mcp"); await sleep(400);
  assert.equal(await page.$eval("#notes-count", (e) => e.textContent), "");
  await page.click("#btn-notes"); await page.click('#notes-panel [data-nf="done"]'); await sleep(200);
  assert.match(await page.$eval("#notes-panel", (e) => e.textContent), /Now 40px/);
  await page.click('.ptab[data-ptab="layers"]');
  ok("notes: select → N pins a note, the pin opens it, Claude's reply shows in the Notes tab");

  // ---- lock and link ----
  await page.click(`.lrow[data-lid="${box.id}"] .lock`); await sleep(300);
  assert.ok((await node(box.id)).locked);
  await page.mouse.click(...(await center(`[data-id="${box.id}"]`))); await sleep(200);
  assert.deepEqual((await op("info")).selection, [ab2.id], "a click on a locked layer selects what holds it");
  await page.click(`.lrow[data-lid="${box.id}"] .lock`); await sleep(300);
  assert.ok(!(await node(box.id)).locked);
  ok("lock from the layers panel: the canvas click goes past it");
  await page.click(`[data-id="${tile.id}"]`); await sleep(300);
  await page.click("[data-link]"); await page.type("[data-link]", "https://example.com/x"); await page.keyboard.press("Enter"); await sleep(400);
  const lk = await node(tile.id);
  assert.equal(lk.tag, "a"); assert.equal(lk.attrs.href, "https://example.com/x");
  ok("the Link field turns a layer into a link");

  // ---- layers outside the artboards: dragged out they stay on the canvas; dragged onto an artboard they go into it
  const drag = async (sel, toX, toY) => { const [x, y] = await center(sel); await page.mouse.move(x, y); await page.mouse.down(); for (let i = 1; i <= 12; i++) await page.mouse.move(x + ((toX - x) * i) / 12, y + ((toY - y) * i) / 12); await page.mouse.up(); await sleep(600); };
  for (let i = 0; i < 2; i++) { await page.keyboard.down("Meta"); await page.keyboard.press("-"); await page.keyboard.up("Meta"); } await sleep(300); // room around the artboards
  await page.mouse.click(...(await center(`[data-id="${box.id}"]`))); await sleep(150);
  const abBox = await page.$eval(`[data-id="${ab2.id}"]`, (e) => { const b = e.getBoundingClientRect(), v = document.querySelector("#viewport").getBoundingClientRect(); return { right: Math.min(b.right + 90, v.right - 70), top: b.top }; });
  await drag(`[data-id="${box.id}"]`, abBox.right, abBox.top + 60);
  let info = await op("info");
  assert.ok(info.canvasLayers.some((c) => c.id === box.id), "the box is on the canvas now: " + JSON.stringify(info.canvasLayers));
  assert.ok(!info.artboards.some((a) => a.id === box.id), "and it isn't an artboard");
  assert.ok(await visible(`[data-id="${box.id}"]`), "still visible");
  assert.ok(!(await op("tree", { nodeId: ab2.id })).includes(box.id));
  const zipAll = await fetch(BASE + "/api/export?scope=all&format=html"); assert.ok(zipAll.ok);
  await page.mouse.click(...(await center(`[data-id="${box.id}"]`))); await sleep(150);
  assert.deepEqual((await op("info")).selection, [box.id], "it can be selected on the canvas");
  await drag(`[data-id="${box.id}"]`, ...(await page.$eval(`[data-id="${ab.id}"]`, (e) => { const b = e.getBoundingClientRect(); return [b.left + b.width / 2, b.top + 40]; })));
  info = await op("info");
  assert.ok(!info.canvasLayers.length, "back in an artboard"); assert.ok((await op("tree", { nodeId: ab.id })).includes(box.id), "in the artboard it was dropped on");
  assert.equal((await node(box.id)).style.position, "absolute");
  await op("undo"); await op("undo"); await sleep(400);
  assert.ok((await op("tree", { nodeId: ab2.id })).includes(box.id), "two undos put it back where it was");
  await page.click("#btn-fit"); await sleep(300);
  ok("drag a layer off an artboard: it stays on the canvas (not exported); drag it onto any artboard to put it in");

  // ---- variations from the bar (fake claude redesigns the copies) ----
  await corner(ab2.id); await sleep(300);
  assert.deepEqual((await op("info")).selection, [ab2.id]);
  await page.click('#selbar [data-sb="vary"]'); await sleep(200);
  await page.click('#selbar [data-count="2"]'); await page.click('#selbar [data-sb="vary-go"]');
  await page.waitForFunction(() => document.querySelectorAll(".vchip").length === 3, { timeout: 10000 });
  const set = (await op("info")).artboards.filter((a) => a.variant);
  assert.equal(set.length, 3);
  await page.waitForFunction(() => !document.querySelector("#runbar").hidden, { timeout: 10000 });
  const v1 = set.find((a) => a.variant.n === 1);
  await page.click(`.vchip[data-ab="${v1.id}"] [data-vk="pick"]`); await sleep(500);
  const after = (await op("info")).artboards;
  assert.ok(after.some((a) => a.id === v1.id && a.name === "Second" && !a.variant)); assert.equal(after.filter((a) => a.variant).length, 0);
  ok("Variations: copies appear side by side, Use this keeps one in the original's place");
  await page.click('#runbar [data-rb="keep"]').catch(() => {});

  // ---- review ----
  await corner(v1.id); await sleep(300);
  await page.click('#selbar [data-sb="review"]');
  await page.waitForFunction(() => document.querySelector("#review .rv-item, #review .rv-ok"), { timeout: 15000 });
  ok("Review lists problems of the selected artboard");
  await page.click("#review .x");

  // ---- resize to formats ----
  await page.click(`[data-title="${v1.id}"]`, { button: "right" }); await sleep(200);
  await page.evaluate(() => [...document.querySelectorAll("#ctx .mi")].find((b) => b.firstChild.textContent === "Resize to formats…").click()); await sleep(200);
  await page.click('#qdlg input[data-w="1080"][data-h="1920"]'); await page.click("#rz-go"); await sleep(600);
  assert.ok((await op("info")).artboards.some((a) => a.width === "1080px" && a.height === "1920px"));
  ok("Resize to formats makes a copy at the new size");

  // ---- icons and templates ----
  await corner(v1.id); await sleep(200);
  await page.click('.ptab[data-ptab="assets"]'); await sleep(400);
  await page.type("[data-icon-q]", "heart"); await sleep(600);
  await page.click('[data-icon="heart"]'); await sleep(400);
  assert.ok((await op("tree", { nodeId: v1.id })).includes("heart icon"));
  ok("the icon library in Assets inserts an icon");
  await page.click(`[data-title="${v1.id}"]`, { button: "right" }); await sleep(200);
  await page.evaluate(() => [...document.querySelectorAll("#ctx .mi")].find((b) => b.firstChild.textContent === "Save as template…").click()); await sleep(200);
  await page.$eval("#tp-name", (e) => (e.value = "Little card")); await page.click("#tp-go"); await sleep(500);
  await page.click("#btn-home"); await sleep(900);
  assert.ok(await visible("#tpl-wrap")); assert.match(await page.$eval("#tpl-grid", (e) => e.textContent), /Little card/);
  await page.click('#tpl-grid [data-tpl]'); await sleep(1200);
  assert.equal((await op("info")).projectName, "Little card"); assert.equal((await op("info")).artboards.length, 1);
  ok("Save as template, then the home screen starts a new project from it");
  await page.click("#btn-home"); await sleep(800);
  assert.match(await page.$eval("#activity", (e) => e.textContent), /Welcome email/);
  ok("home lists Claude's recent work");

  assert.deepEqual(errors, []); ok("no console errors");
  console.log("\nSTUDIO UI TESTS PASSED");
} catch (e) {
  console.error("\nFAILED:", e.stack?.split("\n").slice(0, 4).join("\n") || e.message); await page.screenshot({ path: path.join(os.tmpdir(), "studio-ui-fail.png") }).catch(() => {}); console.error("errors:", errors); process.exitCode = 1;
} finally { await browser.close(); srv.kill(); }
