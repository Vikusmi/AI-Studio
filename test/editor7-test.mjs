// Seventh editor suite: dark mode, resizable / collapsible side panels, the Design vs Email-safe preview.
// Run: node test/editor7-test.mjs
import puppeteer from "puppeteer-core";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "studio-ed7-"));
const PORT = 4785, BASE = `http://127.0.0.1:${PORT}`;
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
const w = (sel) => page.$eval(sel, (e) => Math.round(e.getBoundingClientRect().width));
const bg = (sel) => page.$eval(sel, (e) => getComputedStyle(e).backgroundColor);
const theme = () => page.evaluate(() => document.documentElement.dataset.theme);
const near = (a, b, t = 2) => Math.abs(a - b) <= t;

try {
  await page.emulateMediaFeatures([{ name: "prefers-color-scheme", value: "light" }]);
  await page.goto(BASE + "/#/edit");
  const ab = await op("createArtboard", { name: "Mail", width: 600, style: { "background-color": "#ffffff" } });
  const [blk] = await op("insert", { parentId: ab.id, html: `
   <div layer-name="Card" style="display:flex;flex-direction:column;gap:12px;padding:30px;position:relative">
     <p layer-name="Title" style="margin:0;font:700 28px Arial">Hello there</p>
     <div layer-name="Sticker" style="position:absolute;right:20px;top:20px;width:60px;height:60px;background:#0d8cff;border-radius:50%"></div>
   </div>` });
  await page.waitForSelector(".abw"); await sleep(400);
  await page.click("#btn-fit"); await sleep(200);

  // ---- theme
  assert.equal(await theme(), "light"); assert.equal(await page.$eval("#btn-theme", (b) => (b.title || b.dataset.tip).includes("Auto")), true);
  const lightPanel = await bg("#layers"), lightBody = await bg("body");
  await page.click("#btn-theme"); await sleep(150);   // auto → light
  assert.equal(await theme(), "light"); assert.match(await page.$eval("#btn-theme", (b) => b.title || b.dataset.tip), /Light/);
  await page.click("#btn-theme"); await sleep(150);   // light → dark
  assert.equal(await theme(), "dark"); assert.match(await page.$eval("#btn-theme", (b) => b.title || b.dataset.tip), /Dark/);
  const darkPanel = await bg("#layers"), darkBody = await bg("body"), darkBtn = await bg("#btn-add-artboard"), darkInput = await bg("#inspector input, #inspector select, #inspector textarea").catch(() => null);
  assert.notEqual(lightPanel, darkPanel); assert.notEqual(lightBody, darkBody);
  const lum = (c) => { const m = c.match(/\d+/g).map(Number); return (m[0] * 299 + m[1] * 587 + m[2] * 114) / 1000; };
  assert.ok(lum(darkPanel) < 70 && lum(darkBody) < 70 && lum(darkBtn) < 90, `dark surfaces are dark: ${darkPanel} ${darkBody} ${darkBtn}`);
  ok("the theme button cycles Auto → Light → Dark and the whole UI changes (panels, top bar, buttons)");
  // the design on the canvas is not recoloured
  assert.equal(await page.$eval(".abw > [data-id]", (e) => getComputedStyle(e).backgroundColor), "rgb(255, 255, 255)"); ok("artboards keep their own colours in dark mode");
  await page.click(`[data-id="${(await op("children", { nodeId: blk.id }))[0].id}"]`); await sleep(200);
  assert.ok(lum(await bg("#inspector-panel")) < 70, "inspector is dark");
  for (const sel of ["#top", "#layers", "#inspector-panel", "#toolbar"]) assert.ok(lum(await bg(sel)) < 90, sel + " is dark: " + (await bg(sel)));
  await page.reload(); await page.waitForSelector(".abw"); await sleep(500);
  assert.equal(await theme(), "dark"); ok("the choice is remembered after a reload");
  await page.click("#btn-theme"); await sleep(150);   // dark → auto
  assert.match(await page.$eval("#btn-theme", (b) => b.title || b.dataset.tip), /Auto/);
  await page.emulateMediaFeatures([{ name: "prefers-color-scheme", value: "dark" }]); await sleep(200);
  assert.equal(await theme(), "dark", "auto follows the system when it goes dark");
  await page.emulateMediaFeatures([{ name: "prefers-color-scheme", value: "light" }]); await sleep(200);
  assert.equal(await theme(), "light"); ok("Auto follows the system theme live");
  await page.click("#btn-theme"); await sleep(100); await page.click("#btn-theme"); await sleep(100); // → light → dark for the rest
  assert.equal(await theme(), "dark");
  // home screen and menus in dark
  await page.click("#btn-home"); await sleep(500);
  assert.ok(lum(await bg("#home")) < 70, "home screen is dark"); assert.ok(lum(await bg(".pcard")) < 90, "project cards are dark");
  await page.click(".pcard"); await sleep(600);
  await page.mouse.click(700, 500, { button: "right" }); await sleep(150);
  assert.ok(lum(await bg("#ctx")) < 100, "context menu is dark: " + (await bg("#ctx"))); await page.keyboard.press("Escape");
  ok("home screen and right-click menus are dark too");
  await page.click("#btn-theme"); await sleep(100); // → auto (light) so the layout checks use the light theme again

  // ---- side panels
  assert.ok(near(await w("#layers"), 250 + 1) && near(await w("#inspector-panel"), 280 + 1), "default widths");
  const rz = await page.$eval("#rz-l", (e) => { const b = e.getBoundingClientRect(); return [b.x + b.width / 2, b.y + 200]; });
  await page.mouse.move(rz[0], rz[1]); await page.mouse.down(); await page.mouse.move(rz[0] + 40, rz[1], { steps: 4 }); await page.mouse.move(rz[0] + 90, rz[1], { steps: 4 }); await page.mouse.up(); await sleep(300);
  assert.ok(near(await w("#layers"), 340 + 1, 4), "layers panel dragged wider: " + await w("#layers"));
  const rr = await page.$eval("#rz-r", (e) => { const b = e.getBoundingClientRect(); return [b.x + b.width / 2, b.y + 200]; });
  await page.mouse.move(rr[0], rr[1]); await page.mouse.down(); await page.mouse.move(rr[0] - 100, rr[1], { steps: 6 }); await page.mouse.up(); await sleep(300);
  assert.ok(near(await w("#inspector-panel"), 380 + 1, 4), "design panel dragged wider: " + await w("#inspector-panel"));
  ok("drag the edge of the layers / design panel to resize it");
  await page.mouse.move(rz[0] + 90, rz[1]); await page.mouse.click(rz[0] + 90, rz[1], { count: 2 }); await sleep(300);
  assert.ok(near(await w("#layers"), 251, 3), "double-click on the edge resets the width: " + await w("#layers"));
  await page.reload(); await page.waitForSelector(".abw"); await sleep(500);
  assert.ok(near(await w("#inspector-panel"), 381, 4), "widths are remembered after a reload: " + await w("#inspector-panel"));
  ok("double-click the edge resets it; widths are remembered");

  // collapse to a thin rail
  const vp0 = await w("#viewport");
  await page.click('#layers .pcollapse'); await sleep(350);
  assert.ok(await page.$eval("#layers", (e) => e.classList.contains("collapsed"))); assert.ok(near(await w("#layers"), 35, 2), "rail width " + await w("#layers"));
  assert.ok((await w("#viewport")) > vp0 + 150, "the canvas gets the space");
  assert.equal(await page.$eval("#layers-list", (e) => getComputedStyle(e).display), "none");
  assert.ok(await page.$eval("#layers .prail", (e) => getComputedStyle(e).display !== "none"), "rail button visible");
  await page.click('#inspector-panel .pcollapse'); await sleep(350);
  assert.ok(near(await w("#inspector-panel"), 35, 2));
  ok("each panel collapses to a thin rail and the canvas takes the space");
  // selection overlay still lines up with the element after the layout changed
  await page.click(`[data-id="${(await op("children", { nodeId: blk.id }))[0].id}"]`); await sleep(250);
  const sel = await page.$eval("#overlay .sel-box", (e) => { const b = e.getBoundingClientRect(); return [b.x, b.y, b.width, b.height]; });
  const el = await page.$eval(`[data-id="${(await op("children", { nodeId: blk.id }))[0].id}"]`, (e) => { const b = e.getBoundingClientRect(); return [b.x, b.y, b.width, b.height]; });
  assert.ok(sel.every((v, i) => near(v, el[i], 2)), "selection box matches the element: " + sel + " vs " + el); ok("the selection box still lines up after the panels move");
  await page.click('#layers .prail'); await sleep(350);
  assert.ok(!(await page.$eval("#layers", (e) => e.classList.contains("collapsed")))); assert.ok(near(await w("#layers"), 251, 3));
  ok("the rail button brings the panel back at its old width");
  // dragging the edge far enough collapses it
  const rz2 = await page.$eval("#rz-l", (e) => { const b = e.getBoundingClientRect(); return [b.x + b.width / 2, b.y + 200]; });
  await page.mouse.move(rz2[0], rz2[1]); await page.mouse.down(); await page.mouse.move(rz2[0] - 100, rz2[1], { steps: 5 }); await page.mouse.move(rz2[0] - 200, rz2[1], { steps: 5 }); await page.mouse.up(); await sleep(350);
  assert.ok(await page.$eval("#layers", (e) => e.classList.contains("collapsed")), "dragging past the minimum collapses");
  await page.click('#layers .prail'); await sleep(300);
  // ⌘\ hides and shows both
  await page.keyboard.down("Meta"); await page.keyboard.press("Backslash"); await page.keyboard.up("Meta"); await sleep(350);
  assert.ok(near(await w("#layers"), 35, 2) && near(await w("#inspector-panel"), 35, 2), "⌘\\ collapses both");
  await page.keyboard.down("Meta"); await page.keyboard.press("Backslash"); await page.keyboard.up("Meta"); await sleep(350);
  assert.ok((await w("#layers")) > 150 && (await w("#inspector-panel")) > 200, "⌘\\ again brings both back");
  ok("⌘\\ hides and shows both side panels; dragging an edge past the minimum collapses it");
  await page.reload(); await page.waitForSelector(".abw"); await sleep(400);
  await page.click('#inspector-panel .pcollapse'); await sleep(300); await page.reload(); await page.waitForSelector(".abw"); await sleep(400);
  assert.ok(await page.$eval("#inspector-panel", (e) => e.classList.contains("collapsed")), "collapsed state is remembered"); await page.click('#inspector-panel .prail'); await sleep(300);

  // ---- preview: Design vs Email-safe
  await page.click("#btn-preview"); await sleep(1200);
  assert.ok(await page.$(".pv-desktop"));
  assert.equal(await page.$eval('[data-pvk="design"]', (b) => b.classList.contains("on")), true, "Design is the default");
  const html = (kind) => page.$eval(".pv-frame", (f) => f.contentDocument.documentElement.outerHTML);
  let h = await html();
  assert.ok(h.includes("position:absolute") && h.includes("Hello there"), "Design view is the artboard exactly as drawn (absolute layer kept)");
  const frame = await page.$eval(".pv-frame", (f) => { const b = f.getBoundingClientRect(); return [b.width, b.height, f.contentDocument.documentElement.scrollHeight]; });
  assert.ok(frame[1] > 100 && near(frame[1], frame[2], 3), "frame is as tall as the email: " + frame);
  assert.ok(await page.$eval(".pv-banner", (b) => !b.hidden && /Design view/.test(b.textContent) && /image slices/.test(b.textContent)), "design view says what the email export will do with free-placed layers");
  ok("Preview → Design: the artboard exactly as drawn, free-placed layers kept");
  await page.click('[data-pvk="email"]');
  await page.waitForFunction(() => !/Rendering/.test(document.querySelector(".pv-banner").textContent), { timeout: 30000 }); await sleep(600);
  h = await html();
  assert.ok(h.includes("<table") && !/display:\s*flex/.test(h.replace(/<!--[\s\S]*?-->/g, "")), "Email-safe view is the table-based markup");
  assert.ok(h.includes("data:image/jpeg"), "the free-placed section is shown as image slices");
  assert.ok(await page.$eval(".pv-banner", (b) => !b.hidden && /Email-safe view/.test(b.textContent)));
  ok("Preview → Email-safe: the table-based export, with a note on what email apps do");
  await page.click('[data-pvk="design"]'); await page.click('[data-pvm="mobile"]'); await sleep(1200);
  assert.ok(await page.$(".pv-phone")); const sc = await page.$eval(".pv-frame", (f) => f.style.transform); assert.match(sc, /scale\(0\.6/);
  assert.equal(await page.evaluate(() => localStorage.getItem("studio-pv-mode")), "mobile");
  ok("Mobile: a phone, the design scaled to its width; the device choice is remembered");
  // a wide artboard (Instagram) fits the desktop pane instead of being cut off
  const ig = await op("createArtboard", { name: "IG", width: 1080, height: 1080, style: { "background-color": "#ffcc00" } });
  await page.keyboard.press("Escape"); await sleep(200);
  await page.click("#btn-preview"); await sleep(800); await page.click('[data-pvm="desktop"]'); await page.select("#pv-ab", ig.id); await sleep(1500);
  const wide = await page.$eval(".pv-frame", (f) => ({ t: f.style.transform, w: f.style.width, pane: f.parentElement.clientWidth }));
  assert.equal(wide.w, "1080px"); assert.ok(parseFloat(wide.t.match(/scale\(([\d.]+)/)[1]) < 0.75, "scaled down to fit: " + wide.t);
  ok("a 1080px artboard is scaled to fit the mail window instead of being cut off");
  await page.keyboard.press("Escape");

  assert.deepEqual(errors, []); ok("no console errors");
  console.log("\nEDITOR SUITE 7 PASSED");
} catch (e) {
  console.error("\nFAILED:", e.stack?.split("\n").slice(0, 4).join("\n") || e.message); await page.screenshot({ path: path.join(os.tmpdir(), "studio-editor7-fail.png") }).catch(() => {}); console.error("errors:", errors); process.exitCode = 1;
} finally { await browser.close(); srv.kill(); }
