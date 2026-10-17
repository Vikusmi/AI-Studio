// Export suite: sendable emails (hybrid slices, zip, .eml, fidelity modes, inherited text styles).
// Run: node test/export-test.mjs
import { spawn, execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "studio-exp-"));
const PORT = 4786, BASE = `http://127.0.0.1:${PORT}`;
const srv = spawn(process.execPath, [path.join(root, "server/server.js")], { env: { ...process.env, STUDIO_PORT: PORT, STUDIO_PROJECT: path.join(tmp, "proj") }, stdio: "ignore" });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
for (let i = 0; i < 40; i++) { try { await fetch(BASE + "/api/ping"); break; } catch { await sleep(150); } }
const op = async (name, args = {}) => { const r = await fetch(BASE + "/api/op", { method: "POST", body: JSON.stringify({ op: name, args }) }); const j = await r.json(); if (!r.ok) throw new Error(j.error); return j.result; };
const ok = (m) => console.log("  ✓", m);
const get = async (q) => { const r = await fetch(BASE + "/api/export?" + q); assert.equal(r.status, 200, q + " → " + r.status); return r; };

try {
  const ab = await op("createArtboard", { name: "Newsletter", width: 600, style: { "background-color": "#f4f3ee" } });
  await op("insert", { parentId: ab.id, html: `
   <div layer-name="Header" style="display:flex;justify-content:space-between;align-items:center;padding:20px 30px;background-color:#0c3d3d;font-family:Georgia,serif;color:#ffffff;font-size:15px;letter-spacing:0.05em"><span>STUDIO</span><span>Issue 04</span></div>
   <div layer-name="Collage" style="position:relative;height:300px;background-color:#ffd9a8">
     <div layer-name="Blob" style="position:absolute;left:380px;top:40px;width:160px;height:160px;border-radius:50%;background-color:#ff4f1f"></div>
     <p layer-name="Big" style="position:absolute;left:30px;top:60px;margin:0;font:700 44px Arial;color:#111">Collage headline</p>
     <a layer-name="Cta" href="https://example.com/shop" style="position:absolute;left:30px;top:200px;background-color:#111;color:#fff;padding:14px 34px;border-radius:30px;font:600 16px Arial;text-decoration:none">Shop now</a>
     <a layer-name="Cta2" href="https://example.com/more" style="position:absolute;left:230px;top:200px;background-color:#fff;color:#111;padding:14px 34px;border-radius:30px;font:600 16px Arial;text-decoration:none">Learn more</a>
   </div>
   <div layer-name="Body" style="display:flex;flex-direction:column;gap:12px;padding:30px;background-color:#ffffff"><p style="margin:0;font:16px Arial;color:#333333">Plain live text in the email, kept as real text.</p></div>` });
  await sleep(300);

  // ---- which sections would become slices (no rendering)
  let plan = await (await fetch(`${BASE}/api/email-plan?id=${ab.id}`)).json();
  assert.deepEqual(plan.sections.map((s) => s.name), ["Collage"]); ok("plan: only the section with free-placed layers needs slices");
  plan = await (await fetch(`${BASE}/api/email-plan?id=${ab.id}&raster=all`)).json(); assert.equal(plan.sections.length, 3);
  plan = await (await fetch(`${BASE}/api/email-plan?id=${ab.id}&raster=none`)).json(); assert.equal(plan.sections.length, 0); ok("plan: all / none modes");

  // ---- hybrid email
  let r = await get(`id=${ab.id}&format=email`);
  const warn = JSON.parse(decodeURIComponent(r.headers.get("x-email-warnings")));
  const html = await r.text();
  assert.match(warn[0], /1 section was turned into image slices/);
  assert.ok(html.includes("Plain live text in the email"), "live text stays text");
  assert.ok(!html.includes("Collage headline") || html.includes('alt="'), "collage text is in the picture (and alt text)");
  const links = [...html.matchAll(/<a href="([^"]+)"[^>]*><img/g)].map((m) => m[1]);
  assert.deepEqual(links.sort(), ["https://example.com/more", "https://example.com/shop"]); ok("hybrid: the collage became image slices, both buttons are still real links around their slice");
  assert.ok(/alt="[^"]*Shop now/.test(html) && /alt="[^"]*Collage headline/.test(html), "slices carry alt text");
  assert.ok(!/display:\s*flex/.test(html.replace(/<!--[\s\S]*?-->/g, "")) && !/<div/.test(html.replace(/<!--[\s\S]*?-->/g, "")), "no flex / divs in the result"); ok("no divs or flex; slices have alt text");
  assert.match(html, /font-family:Georgia,serif/); assert.match(html, /letter-spacing:0\.05em/);
  const headerCells = (html.match(/<td[^>]*font-family:Georgia,serif[^>]*>/g) || []).length; assert.ok(headerCells >= 2, "the container's font reaches its cells: " + headerCells); ok("a container's font, colour and spacing are repeated on its table cells (text no longer reverts to the default)");
  const imgs = [...html.matchAll(/<img src="data:image\/jpeg;base64,/g)].length; assert.ok(imgs >= 5, "slices inline as data: " + imgs);
  for (const m of html.matchAll(/<img[^>]*width="(\d+)" height="(\d+)"/g)) assert.ok(+m[1] > 0 && +m[2] > 0);

  // ---- zip
  r = await get(`id=${ab.id}&format=email-zip`);
  fs.writeFileSync(path.join(tmp, "e.zip"), Buffer.from(await r.arrayBuffer()));
  const list = execFileSync("unzip", ["-l", path.join(tmp, "e.zip")]).toString();
  assert.ok(list.includes("index.html") && /images\/slice-01\.jpg/.test(list)); execFileSync("unzip", ["-tq", path.join(tmp, "e.zip")]);
  const idx = execFileSync("unzip", ["-p", path.join(tmp, "e.zip"), "index.html"]).toString();
  assert.ok(/src="images\/slice-\d+\.jpg"/.test(idx) && !idx.includes("data:image"), "the zip's HTML points at images/");
  ok("zip: index.html + images/slice-NN.jpg, a valid archive; paths are relative so an ESP can host them");

  // ---- .eml
  r = await get(`id=${ab.id}&format=eml`);
  const eml = Buffer.from(await r.arrayBuffer()).toString("utf8");
  assert.match(eml, /^X-Unsent: 1/); assert.match(eml, /Subject: Newsletter/); assert.match(eml, /multipart\/related/);
  const cids = [...eml.matchAll(/^Content-ID: <([^>]+)>/gm)].map((m) => m[1]); assert.ok(cids.length >= 5, "inline image parts: " + cids.length);
  const body = Buffer.from(eml.split("Content-Transfer-Encoding: base64\r\n\r\n")[1].split("\r\n--")[0].replace(/\r\n/g, ""), "base64").toString();
  assert.ok(cids.every((c) => body.includes("cid:" + c)), "every image is referenced by cid"); assert.ok(!body.includes("data:image"));
  ok(".eml: an unsent draft with the HTML and every slice attached inline (cid)");

  // ---- fidelity modes
  r = await get(`id=${ab.id}&format=email&raster=none`);
  const none = await r.text();
  assert.ok(!JSON.parse(decodeURIComponent(r.headers.get("x-email-warnings"))).some((w) => /image slices/.test(w))); assert.ok(!none.includes("data:image/jpeg"));
  r = await get(`id=${ab.id}&format=email&raster=all`); const all = await r.text();
  assert.ok((all.match(/<img /g) || []).length > imgs - 1 && !all.includes("Plain live text in the email</") , "all-slices mode turns the live body into pictures too");
  ok("fidelity: Tables only keeps everything as tables; All slices pictures every section");

  // ---- a simple email stays 100% live
  const ab2 = await op("createArtboard", { name: "Simple", width: 600 });
  await op("insert", { parentId: ab2.id, html: `<div style="display:flex;flex-direction:column;gap:10px;padding:30px"><p style="margin:0;font:700 24px Arial">Hello</p><a href="https://x.test" style="background-color:#ff4400;color:#fff;padding:12px 28px;border-radius:8px;font:16px Arial;text-decoration:none;align-self:flex-start">Go</a></div>` });
  r = await get(`id=${ab2.id}&format=email`); const simple = await r.text();
  assert.deepEqual(JSON.parse(decodeURIComponent(r.headers.get("x-email-warnings"))), []); assert.ok(!simple.includes("<img")); assert.ok(simple.includes(">Hello<") && simple.includes("https://x.test"));
  ok("a simple email stays fully live: real text, a real button, no images, no warnings");

  // ---- repeated exports reuse the renders; changing the doc invalidates them
  const t0 = Date.now(); await get(`id=${ab.id}&format=email`); const dt = Date.now() - t0; assert.ok(dt < 1500, "cached export is fast: " + dt + "ms");
  await op("updateStyles", { updates: [{ nodeIds: [(await op("children", { nodeId: ab.id }))[1].id], styles: { "background-color": "#c0ffee" } }] });
  const h2 = await (await get(`id=${ab.id}&format=email`)).text(); assert.notEqual(h2.length, html.length);
  ok("renders are cached until the document changes");

  console.log("\nEXPORT TESTS PASSED");
} catch (e) {
  console.error("\nFAILED:", e.stack?.split("\n").slice(0, 5).join("\n") || e.message); process.exitCode = 1;
} finally { srv.kill(); }
