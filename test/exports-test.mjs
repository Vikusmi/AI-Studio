// Exports: PNG/JPG/WebP at several scales, PDF (one page per artboard, exact sizes), slices, all-artboards zips.
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
import zlib from "node:zlib";
import { fileURLToPath } from "node:url";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "studio-exp-"));
const PORT = 4796, BASE = `http://127.0.0.1:${PORT}`;
const srv = spawn(process.execPath, [path.join(root, "server/server.js")], { env: { ...process.env, STUDIO_PORT: PORT, STUDIO_PROJECT: path.join(tmp, "proj") }, stdio: "ignore" });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
for (let i = 0; i < 40; i++) { try { await fetch(BASE + "/api/ping"); break; } catch { await sleep(150); } }
const op = async (name, args = {}) => { const r = await fetch(BASE + "/api/op", { method: "POST", body: JSON.stringify({ op: name, args }) }); const j = await r.json(); if (!r.ok) throw new Error(j.error); return j.result; };
const get = async (q) => { const r = await fetch(BASE + "/api/export?" + q); if (!r.ok) throw new Error((await r.json()).error); return { buf: Buffer.from(await r.arrayBuffer()), type: r.headers.get("content-type"), cd: r.headers.get("content-disposition") }; };
const ok = (m) => console.log("  ✓", m);
const pngSize = (b) => ({ w: b.readUInt32BE(16), h: b.readUInt32BE(20) });
// list names in a stored zip
const zipNames = (b) => { const out = []; for (let i = 0; i < b.length - 4; i++) if (b.readUInt32LE(i) === 0x04034b50) { const n = b.readUInt16LE(i + 26), e = b.readUInt16LE(i + 28), sz = b.readUInt32LE(i + 18); out.push({ name: b.toString("utf8", i + 30, i + 30 + n), data: b.subarray(i + 30 + n + e, i + 30 + n + e + sz) }); i += 30 + n + e + sz - 1; } return out; };
try {
  const a1 = await op("createArtboard", { name: "Wide", width: 400, height: 200, style: { "background-color": "#fff" } });
  const a2 = await op("createArtboard", { name: "Tall", width: 300, height: 500, style: { "background-color": "#eee" } });
  await op("insert", { parentId: a1.id, html: `<div layer-name="Top" style="height:100px;background-color:#f00"></div><div layer-name="Bottom" style="height:100px;background-color:#00f"></div>` });
  await op("insert", { parentId: a2.id, html: `<div style="height:80px;background-color:#0a0"></div>` });
  for (const sc of [1, 2, 3]) { const r = await get(`id=${a1.id}&format=png&scale=${sc}`); assert.deepEqual(pngSize(r.buf), { w: 400 * sc, h: 200 * sc }); }
  ok("PNG at 1×, 2× and 3× has exactly the right pixel size");
  const j = await get(`id=${a1.id}&format=jpg&scale=2&quality=60`); assert.equal(j.type, "image/jpeg"); assert.equal(j.buf[0], 0xff); assert.match(j.cd, /wide\.jpg/);
  const jhi = await get(`id=${a1.id}&format=jpg&scale=2&quality=95`); assert.ok(jhi.buf.length >= j.buf.length);
  const w = await get(`id=${a1.id}&format=webp&scale=1`); assert.equal(w.type, "image/webp"); assert.equal(w.buf.toString("latin1", 8, 12), "WEBP"); ok("JPG (with quality) and WebP");
  const pdf = await get(`id=${a1.id}&format=pdf`); assert.equal(pdf.buf.toString("latin1", 0, 5), "%PDF-"); assert.equal((pdf.buf.toString("latin1").match(/\/Type\s*\/Page\b/g) || []).length, 1);
  const pdfAll = await get(`scope=all&format=pdf`); const txt = pdfAll.buf.toString("latin1");
  assert.equal((txt.match(/\/Type\s*\/Page\b/g) || []).length, 2, "one page per artboard");
  const boxes = [...txt.matchAll(/\/MediaBox\s*\[\s*0 0 ([\d.]+) ([\d.]+)\s*\]/g)].map((m) => [Math.round(m[1] / 0.75), Math.round(m[2] / 0.75)]);
  assert.deepEqual(boxes, [[400, 200], [300, 500]], "each page is exactly its artboard's size"); ok("PDF: one page per artboard, each exactly artboard-sized");
  const z = zipNames((await get(`scope=all&format=png&scale=1`)).buf); assert.deepEqual(z.map((f) => f.name).sort(), ["tall.png", "wide.png"]); assert.deepEqual(pngSize(z.find((f) => f.name === "tall.png").data), { w: 300, h: 500 }); ok("all artboards as one zip of images");
  const s = zipNames((await get(`id=${a1.id}&format=slices&scale=1`)).buf); assert.equal(s.length, 2); assert.match(s[0].name, /^01-top\.png$/); assert.deepEqual(pngSize(s[0].data), { w: 400, h: 100 }); ok("slices: every top-level section as its own image");
  const hz = zipNames((await get(`scope=all&format=html`)).buf); assert.equal(hz.length, 2); ok("all artboards as HTML files in a zip");
  console.log("\nEXPORTS PASSED");
} catch (e) { console.error("\nFAILED:", e.stack?.split("\n").slice(0, 6).join("\n")); process.exitCode = 1; } finally { srv.kill(); }
