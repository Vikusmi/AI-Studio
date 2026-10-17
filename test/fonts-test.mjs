// Custom fonts (upload, render, export, undo) and the offline Google Fonts cache.
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "studio-font-"));
const PORT = 4798, BASE = `http://127.0.0.1:${PORT}`;
const srv = spawn(process.execPath, [path.join(root, "server/server.js")], { env: { ...process.env, STUDIO_PORT: PORT, STUDIO_PROJECT: path.join(tmp, "proj"), STUDIO_FONTS_CACHE: path.join(tmp, "fc") }, stdio: "ignore" });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
for (let i = 0; i < 40; i++) { try { await fetch(BASE + "/api/ping"); break; } catch { await sleep(150); } }
const op = async (name, args = {}) => { const r = await fetch(BASE + "/api/op", { method: "POST", body: JSON.stringify({ op: name, args }) }); const j = await r.json(); if (!r.ok) throw new Error(j.error); return j.result; };
const ok = (m) => console.log("  ✓", m);
const FONT = ["/System/Library/Fonts/Supplemental/Apple Chancery.ttf", "/System/Library/Fonts/Supplemental/Andale Mono.ttf"].find(fs.existsSync);
const up = (q, body) => fetch(BASE + "/api/font?" + new URLSearchParams(q), { method: "POST", body }).then(async (r) => ({ status: r.status, ...(await r.json()) }));
try {
  assert.ok(FONT, "needs a system .ttf for this test");
  const ab = await op("createArtboard", { name: "T", width: 500, height: 120, style: { "background-color": "#fff" } });
  const [t] = await op("insert", { parentId: ab.id, html: `<div layer-name="Line" style="font-family:'Mine Sans';font-size:40px;color:#000;white-space:nowrap">Quick wafting zephyrs</div>` });
  const shot = async () => Buffer.from(await (await fetch(`${BASE}/api/screenshot?id=${t.id}&scale=1`)).arrayBuffer());
  const before = await shot();
  assert.equal((await up({ family: "Mine Sans", name: "x.exe" }, fs.readFileSync(FONT))).status, 400);
  assert.equal((await up({ family: "Mine Sans", name: "x.ttf" }, Buffer.from("not a font at all, just text".repeat(5)))).status, 400);
  assert.equal((await up({ family: " ", name: "x.ttf" }, fs.readFileSync(FONT))).status, 400); ok("only real font files with a name are accepted");
  const r = await up({ family: "Mine Sans", weight: "400", name: "Mine.ttf" }, fs.readFileSync(FONT)); assert.equal(r.status, 200); assert.match(r.font.file, /^assets\/font-Mine_Sans-400\.ttf$/);
  assert.deepEqual((await op("listFonts")).map((f) => f.family), ["Mine Sans"]); ok("a font file is stored in the project's assets");
  const after = await shot(); assert.ok(!after.equals(before), "text now renders in the uploaded font"); ok("the font is used when rendering");
  const html = await (await fetch(`${BASE}/api/export?id=${ab.id}`)).text();
  assert.match(html, /@font-face\{font-family:"Mine Sans";src:url\(data:font\/ttf;base64,/); assert.ok(!/family=Mine\+Sans/.test(html)); ok("HTML export embeds the font and doesn't ask Google for it");
  const pdf = (await (await fetch(`${BASE}/api/export?id=${ab.id}&format=pdf`)).arrayBuffer()); assert.match(Buffer.from(pdf).toString("latin1"), /Apple-?Chancery/); ok("PDF contains the font");
  await op("removeFont", { family: "Mine Sans" }); assert.deepEqual(await op("listFonts"), []); assert.ok(!(await (await fetch(`${BASE}/api/export?id=${ab.id}`)).text()).includes("@font-face"));
  await op("undo"); assert.equal((await op("listFonts")).length, 1); ok("remove, and ⌘Z brings it back");
  // Google Fonts cache (needs the network once)
  let live = true; try { await fetch("https://fonts.googleapis.com/", { signal: AbortSignal.timeout(4000) }); } catch { live = false; }
  if (!live) console.log("  - (offline: Google Fonts cache check skipped)");
  else {
    const q = "?family=Inter:wght@400;700&display=swap";
    const css = await (await fetch(BASE + "/fonts/css2" + q)).text(); assert.match(css, /@font-face/); assert.ok(!/url\(https:/.test(css), "font files are served locally");
    const u = decodeURIComponent(/\/fonts\/file\?u=([^)'"]+)/.exec(css)[1]); const f1 = Buffer.from(await (await fetch(BASE + "/fonts/file?u=" + encodeURIComponent(u))).arrayBuffer()); assert.ok(f1.length > 1000);
    assert.ok(fs.readdirSync(path.join(tmp, "fc")).length >= 2); ok("Google Fonts are fetched once and cached on disk");
    const mixed = await fetch(BASE + "/fonts/css2?family=Arial&family=Inter:wght@400;700&display=swap"); assert.equal(mixed.status, 200); assert.match(await mixed.text(), /font-family: 'Inter'/); ok("a family Google doesn't have (Arial) no longer takes the others down");
    assert.equal((await fetch(BASE + "/fonts/file?u=" + encodeURIComponent("https://evil.example/x.woff2"))).status, 502); ok("only Google's font host is proxied");
  }
  console.log("\nFONTS PASSED");
} catch (e) { console.error("\nFAILED:", e.stack?.split("\n").slice(0, 6).join("\n")); process.exitCode = 1; } finally { srv.kill(); }
