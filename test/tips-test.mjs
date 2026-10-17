// Tooltips: every icon-only control has a label, and hovering shows it after a short delay.
import puppeteer from "puppeteer-core";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "studio-tips-"));
const PORT = 4800, BASE = `http://127.0.0.1:${PORT}`;
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
// buttons / controls a person sees that show only an icon (no letters) and carry no label
const unlabeled = () => page.evaluate(() => [...document.querySelectorAll("button, [role=button], .tool, .icon, [data-act], select, input[type=color]")].filter((el) => {
  const r = el.getBoundingClientRect(); if (!r.width || !r.height || el.closest("[hidden]")) return false;
  if (el.hasAttribute("title") || el.dataset.tip || el.getAttribute("aria-label")) return false;
  if (el.tagName === "SELECT" || el.tagName === "INPUT") return !el.closest("label,.f") ;
  return !/[\p{L}\p{N}]/u.test(el.textContent || "");
}).map((el) => (el.id ? "#" + el.id : el.className ? "." + String(el.className).split(" ")[0] : el.tagName) + " " + (el.outerHTML.slice(0, 90))));
try {
  await page.goto(BASE + "/#/edit");
  const ab = await op("createArtboard", { name: "A", width: 500, height: 300, style: { position: "relative" } });
  const [img, txt] = await op("insert", { parentId: ab.id, html: `<div layer-name="Box" style="width:100px;height:60px;background-color:#eee"></div><div layer-name="Words" style="font-size:20px">Hello</div>` });
  await sleep(600);
  let bad = await unlabeled(); console.log("  top-level unlabeled:", bad);
  await page.click(`[data-id="${img.id}"]`); await sleep(300); bad = bad.concat(await unlabeled());
  await page.click('[data-ptab="assets"]'); await sleep(300); bad = bad.concat(await unlabeled());
  await page.click(`[data-id="${txt.id}"]`); await sleep(300); bad = bad.concat(await unlabeled());
  await page.click("#btn-preview"); await sleep(700); bad = bad.concat(await unlabeled()); await page.keyboard.press("Escape"); await sleep(300);
  await page.click("#btn-ask"); await sleep(300); bad = bad.concat(await unlabeled()); await page.click("#ask-close");
  await page.click("#btn-history"); await sleep(300); bad = bad.concat(await unlabeled()); await page.keyboard.press("Escape"); await page.mouse.click(5, 500); await sleep(200);
  await page.click("#btn-home"); await sleep(700); bad = bad.concat(await unlabeled()); await page.evaluate(() => (location.hash = "#/edit")); await sleep(800);
  const uniq = [...new Set(bad)]; assert.deepEqual(uniq, [], "icon-only controls without a label:\n" + uniq.join("\n")); ok("every icon-only control has a label");
  // hover behaviour
  const hover = async (sel) => { const b = await page.$eval(sel, (e) => { const r = e.getBoundingClientRect(); return [r.x + r.width / 2, r.y + r.height / 2]; }); await page.mouse.move(0, 400); await sleep(60); await page.mouse.move(b[0], b[1]); };
  const tipText = () => page.$eval("#tip", (e) => (e.hidden ? "" : e.textContent));
  await page.mouse.move(700, 600); await sleep(1500); await hover("#btn-undo"); await sleep(150); assert.equal(await tipText(), "", "not instantly");
  await sleep(550); assert.match(await tipText(), /Undo/); ok("hovering an icon shows its name after a short delay");
  assert.equal(await page.$eval("#btn-undo", (e) => e.hasAttribute("title")), false); ok("the browser's own tooltip is replaced, not doubled");
  const r = await page.$eval("#tip", (e) => { const b = e.getBoundingClientRect(); return { l: b.left, r: b.right, t: b.top, b: b.bottom }; }); assert.ok(r.l >= 0 && r.r <= 1500 && r.b <= 950);
  await page.mouse.move(700, 600); await sleep(100); assert.equal(await tipText(), ""); ok("it goes away when the pointer leaves");
  await hover("#btn-fit"); await sleep(700); await page.mouse.down(); await sleep(50); assert.equal(await tipText(), ""); await page.mouse.up(); ok("and when you click");
  await hover("#btn-redo"); await sleep(300); assert.match(await tipText(), /Redo/); ok("moving along the toolbar shows the next tip quickly");
  // a control that appears later (inspector) gets one too
  await page.mouse.move(700, 600); await page.waitForSelector(`[data-id="${txt.id}"]`, { visible: true, timeout: 5000 }).catch(() => {}); await page.click(`[data-id="${txt.id}"]`); await sleep(300); const al = await page.$(".alignbar button"); if (al) { const b = await al.boundingBox(); await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2); await sleep(700); assert.notEqual(await tipText(), ""); ok("controls added later (inspector) show tips too"); }
  assert.deepEqual(errors, []); console.log("\nTIPS PASSED");
} catch (e) { console.error("\nFAILED:", e.message.slice(0, 2500), errors); process.exitCode = 1; } finally { await browser.close(); srv.kill(); }
