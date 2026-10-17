// End-to-end check of the MCP path: spawns mcp.js over stdio (which auto-starts the app server),
// then calls the tools like Claude would. Run: node test/mcp-test.mjs
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "studio-test-"));
const PORT = "4778";
// a server left over from a crashed run would hold old artboards: clear the port first
try { (await import("node:child_process")).execSync(`lsof -ti tcp:${PORT} | xargs kill`, { stdio: "ignore" }); await new Promise((r) => setTimeout(r, 300)); } catch {}

// a 64x64 orange->blue gradient PNG, no dependencies
function png() {
  const w = 64, h = 64, raw = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { const o = y * (w * 3 + 1); raw[o] = 0; raw.set([255 - x * 3, 80 + y, 30 + x * 3], o + 1 + x * 3); }
  const crc = (b) => { let c, t = []; for (let n = 0; n < 256; n++) { c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } let r = 0xffffffff; for (const x of b) r = t[(r ^ x) & 255] ^ (r >>> 8); return (r ^ 0xffffffff) >>> 0; };
  const chunk = (type, data) => { const len = Buffer.alloc(4); len.writeUInt32BE(data.length); const td = Buffer.concat([Buffer.from(type), data]); const c = Buffer.alloc(4); c.writeUInt32BE(crc(td)); return Buffer.concat([len, td, c]); };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", ihdr), chunk("IDAT", zlib.deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
}
const imgPath = path.join(tmp, "my photo.png"); // a space in the path on purpose
fs.writeFileSync(imgPath, png());

const client = new Client({ name: "test", version: "1" });
await client.connect(new StdioClientTransport({ command: process.execPath, args: [path.join(root, "server/mcp.js")], env: { ...process.env, STUDIO_PORT: PORT, STUDIO_PROJECT: path.join(tmp, "proj") } }));
const call = async (name, args = {}) => {
  const r = await client.callTool({ name, arguments: args });
  if (r.isError) throw new Error(`${name}: ${r.content[0].text}`);
  return r.content[0].type === "text" ? r.content[0].text : r.content[0];
};
const json = async (...a) => JSON.parse(await call(...a));
const ok = (m) => console.log("  ✓", m);

console.log("tools:", (await client.listTools()).tools.map((t) => t.name).join(", "));
assert.match(await call("get_guide"), /Workflow/); ok("get_guide");

let info = await json("get_basic_info");
assert.equal(info.artboards.length, 0); ok("get_basic_info (app server auto-started)");

const ab = await json("create_artboard", { name: "Welcome email", width: 600, backgroundColor: "#faf7f2" });
const ab2 = await json("create_artboard", { name: "Mobile", width: 390, height: 844 });
info = await json("get_basic_info");
assert.equal(info.artboards[0].height, "fit-content");
assert.ok(info.artboards[1].x > info.artboards[0].x + 600); ok("create_artboard x2, auto-placed, fit-content height");
{ const ig = await json("create_artboard", { name: "IG", preset: "instagram-post" }); const row = (await json("get_basic_info")).artboards.find((a) => a.id === ig.id); assert.equal(parseInt(row.width), 1080); assert.equal(parseInt(row.height), 1080); await call("delete_nodes", { nodeIds: [ig.id] }); ok("create_artboard preset: instagram-post → 1080×1080"); }
{ const pl = await json("list_projects"); assert.equal(pl.length, 1); assert.equal(pl[0].open, true); ok("list_projects"); }

const html = `
<div layer-name="Hero" style="display:flex;flex-direction:column;gap:20px;padding:40px 32px;">
  <h1 style="font-family:'Inter Tight',sans-serif;font-size:36px;margin:0;color:#111">Welcome to <b>Studio</b> <i>today</i></h1>
  <img src="${imgPath}" alt="hero" style="width:100%;height:200px;object-fit:cover;border-radius:12px">
  <div layer-name="Bg" style="height:60px;background-image:url(file://${imgPath});background-size:cover"></div>
  <a href="https://example.com" layer-name="CTA" style="display:inline-block;background:#ff4f1f;color:#fff;padding:14px 28px;border-radius:999px;font-family:Arial;text-decoration:none">Get started</a>
  <script>alert(1)</script><style>p{}</style>
</div>`;
const w = await json("write_html", { targetNodeId: ab.id, html });
const hero = w.created[0].id; ok("write_html -> " + JSON.stringify(w.created[0]));

const tree = await call("get_tree_summary", { nodeId: ab.id });
console.log(tree.split("\n").map((l) => "    " + l).join("\n"));
assert.ok(!/script|style/i.test(tree.replace(/\(.*\)/g, ""))); ok("script/style dropped");

const nodeInfo = await json("get_node_info", { nodeId: hero });
assert.ok(nodeInfo.html.includes('src="assets/my_photo.png"'), "image copied to assets");
assert.ok(nodeInfo.html.includes("url(assets/my_photo.png)"), "bg image localised");
assert.ok(nodeInfo.html.includes("Welcome to <b"), "inline spacing"); ok("image + background copied into assets/ (dedupe -> one file)");
assert.equal(fs.readdirSync(path.join(tmp, "proj/assets")).length, 1);

const shot = await call("get_screenshot", { nodeId: ab.id });
assert.equal(shot.type, "image"); fs.writeFileSync(path.join(tmp, "shot.png"), Buffer.from(shot.data, "base64"));
const shotNode = await call("get_screenshot", { nodeId: hero });
assert.equal(shotNode.type, "image"); ok(`get_screenshot (artboard ${Buffer.from(shot.data, "base64").length}B, node ${Buffer.from(shotNode.data, "base64").length}B)`);

// edits
const cta = (await json("get_children", { nodeId: hero })).find((c) => c.name === "CTA");
await call("update_styles", { updates: [{ nodeIds: [cta.id], styles: { backgroundColor: "#111111", "border-radius": null } }] });
await call("set_text_content", { nodeId: cta.id, text: "Join now" });
await call("update_styles", { updates: [{ nodeIds: [ab2.id], styles: { left: 1000, top: 40 } }] });
info = await json("get_basic_info");
assert.equal(info.artboards[1].x, 1000); ok("update_styles incl. artboard left/top, set_text_content");
const kids = await json("get_children", { nodeId: hero });
await call("move_nodes", { nodeId: cta.id, parentId: hero, index: 0 });
assert.equal((await json("get_children", { nodeId: hero }))[0].id, cta.id); ok("move_nodes reorder");
await assert.rejects(call("move_nodes", { nodeId: hero, parentId: cta.id }), /itself/); ok("move into itself rejected, doc untouched");
await assert.rejects(call("get_node_info", { nodeId: "nope" }), /No node with id "nope"/); ok("clear error for bad id");
for (let i = 0; i < 4; i++) await call("undo"); // move, artboard move, text, style
info = await json("get_basic_info"); assert.ok(info.artboards[1].x < 1000);
const cn = await json("get_node_info", { nodeId: cta.id }); assert.equal(cn.style.background, "#ff4f1f"); assert.ok(!cn.style["background-color"]); assert.match(cn.html, />Get started</); ok("undo x4 restored CTA style, text and position");

// export
const out = path.join(tmp, "out.html");
const e = JSON.parse(await call("export", { nodeId: ab.id, format: "html", outPath: out }));
const exported = fs.readFileSync(out, "utf8");
assert.ok(exported.startsWith("<!doctype html>") && exported.includes("<title>Welcome email</title>"));
assert.equal((exported.match(/data:image\/png;base64/g) || []).length, 2, "img + background embedded");
assert.ok(!exported.includes("assets/") && !exported.includes("data-node-id") && !/<script|class=/.test(exported));
assert.ok(exported.includes("fonts.googleapis.com") && exported.includes("Inter+Tight")); ok(`export html ${e.bytes}B, standalone`);
const emailOut = path.join(tmp, "out-email.html");
await call("export", { nodeId: ab.id, format: "email", fidelity: "tables-only", outPath: emailOut });
const em = fs.readFileSync(emailOut, "utf8");
assert.ok(em.includes("<table") && !/<div|display:flex/.test(em) && em.includes("data:image/png;base64")); ok("export email, tables only (tables, no flex, images embedded)");
const emailAuto = path.join(tmp, "out-email-auto.html");
const ea = JSON.parse(await call("export", { nodeId: ab.id, format: "email", outPath: emailAuto }));
const eAuto = fs.readFileSync(emailAuto, "utf8");
assert.ok(eAuto.includes("<table") && !/<div|display:flex/.test(eAuto) && eAuto.includes("data:image/jpeg;base64") && ea.notes && /image slices/.test(ea.notes[0])); ok("export email (auto): the background-image section becomes image slices, with a note");
const zipOut = path.join(tmp, "out-email.zip");
await call("export", { nodeId: ab.id, format: "email-zip", outPath: zipOut });
assert.equal(fs.readFileSync(zipOut).subarray(0, 2).toString(), "PK"); ok("export email-zip");
const emlOut = path.join(tmp, "out.eml");
await call("export", { nodeId: ab.id, format: "eml", outPath: emlOut });
assert.ok(fs.readFileSync(emlOut, "utf8").startsWith("X-Unsent: 1")); ok("export eml");
const pngOut = path.join(tmp, "out.png");
await call("export", { nodeId: ab.id, format: "png", outPath: pngOut });
assert.ok(fs.statSync(pngOut).size > 1000); ok("export png");

console.log("\nartifacts in", tmp);
fs.copyFileSync(path.join(tmp, "shot.png"), path.join(tmp, "..", "studio-test-shot.png"));
await client.close();
// the MCP server starts the app server detached on purpose; stop that one so the next run starts clean
const { execSync } = await import("node:child_process");
try { execSync(`lsof -ti tcp:${PORT} | xargs kill`, { stdio: "ignore" }); } catch {}
console.log("MCP TESTS PASSED");
