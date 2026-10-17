// Claude's side of the studio, over MCP like the chat uses it: every app operation has a tool, work on any project without opening it,
// runs of changes (version first, keep / undo), notes, links, locking, images, icons, formats, variations, templates, critique,
// brand from a website, zoomed screenshots, backups. Run: node test/agent-test.mjs
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "studio-agent-"));
const PORT = "4791", BASE = `http://127.0.0.1:${PORT}`;
try { (await import("node:child_process")).execSync(`lsof -ti tcp:${PORT} | xargs kill`, { stdio: "ignore" }); await new Promise((r) => setTimeout(r, 300)); } catch {}

// a small website with a brand, for brand_from_url
const site = http.createServer((req, res) => {
  if (req.url === "/site.css") { res.writeHead(200, { "content-type": "text/css" }); return res.end(`body{font-family:"Work Sans",sans-serif;color:#1a1a1a;background:#fafafa}h1,.hero-title{font-family:'Fraunces',serif;color:#e8452c}.btn{background:#e8452c;color:#fff}.btn:hover{background:#e8452c}a{color:#1f6feb}.badge{background:#1f6feb}.tag{background:#e8452c}`); }
  if (req.url === "/logo.png") { res.writeHead(200, { "content-type": "image/png" }); return res.end(fs.readFileSync(path.join(root, "projects/default/assets", fs.readdirSync(path.join(root, "projects/default/assets"))[0]))); }
  res.writeHead(200, { "content-type": "text/html" });
  res.end(`<!doctype html><html><head><title>Acme Coffee | Fresh beans</title><meta property="og:site_name" content="Acme Coffee"><meta name="description" content="Small-batch coffee roasted weekly."><link rel="stylesheet" href="/site.css"></head><body><img src="/logo.png" alt="Acme logo" class="site-logo"><h1>Coffee</h1></body></html>`);
});
await new Promise((r) => site.listen(0, "127.0.0.1", r));
const siteUrl = `http://127.0.0.1:${site.address().port}/`;

const client = new Client({ name: "test", version: "1" });
await client.connect(new StdioClientTransport({ command: process.execPath, args: [path.join(root, "server/mcp.js")], env: { ...process.env, STUDIO_PORT: PORT, STUDIO_PROJECT: "", STUDIO_PROJECTS: tmp, STUDIO_NO_BACKUP: "1" } }));
const raw = async (name, args = {}) => { const r = await client.callTool({ name, arguments: args }); if (r.isError) throw new Error(`${name}: ${r.content[0].text}`); return r; };
const call = async (name, args = {}) => (await raw(name, args)).content[0].text;
const json = async (...a) => JSON.parse(await call(...a));
// the editor's own path (you, not Claude)
const op = async (name, args = {}, projectId) => { const r = await fetch(BASE + "/api/op", { method: "POST", body: JSON.stringify({ op: name, args, projectId }) }); const j = await r.json(); if (!r.ok) throw new Error(j.error); return j.result; };
const pngSize = (b64) => { const b = Buffer.from(b64, "base64"); return [b.readUInt32BE(16), b.readUInt32BE(20)]; };
const ok = (m) => console.log("  ✓", m);

// the MCP server starts the app server by itself
for (let i = 0; i < 60; i++) { try { if ((await fetch(BASE + "/api/ping")).ok) break; } catch {} await new Promise((r) => setTimeout(r, 150)); }

try {
  // ---- every operation the app has is reachable by Claude ----
  const tools = (await client.listTools()).tools.map((t) => t.name);
  const src = fs.readFileSync(path.join(root, "server/mcp.js"), "utf8");
  const used = new Set([...src.matchAll(/op\("(\w+)"/g)].map((m) => m[1]));
  // editor-only plumbing: drawing helpers, the editor's own selection, home-screen and settings screens, Claude's run bar
  const INTERNAL = new Set(["selection", "setInner", "moveArtboard", "removeFont", "historyRename", "historyDelete", "renameComponent", "deleteComponent", "updateStyle", "detachStyle", "deleteStyle", "setGrid", "setSvg", "cropImage", "uncropImage", "bakeCrop", "purgeProjects", "updateNote", "reopenNote", "deleteNote", "clearDoneNotes", "renameTemplate", "deleteTemplate", "discardVariants", "agentState", "agentKeep", "agentUndo", "activity", "settings", "setSettings", "backupNow", "revealBackups", "connection", "restartServer", "rebuildApp", "ops", "hello"]);
  const missing = (await op("ops")).filter((o) => !used.has(o) && !INTERNAL.has(o));
  assert.deepEqual(missing, [], "operations without an MCP tool: " + missing.join(", "));
  for (const t of ["get_requests", "resolve_request", "leave_note", "critique", "place_image", "search_icons", "insert_icon", "make_variations", "pick_variation", "resize_to_formats", "save_template", "use_template", "list_templates", "brand_from_url", "set_link", "set_locked", "set_hidden", "list_versions", "save_version", "restore_version", "trash_project", "duplicate_project", "rename_project", "redo", "list_fonts"]) assert.ok(tools.includes(t), "tool " + t);
  ok(`${tools.length} tools; every app operation has one (or is editor plumbing)`);

  // ---- Claude connected ----
  await new Promise((r) => setTimeout(r, 300));
  const con = await op("connection");
  assert.ok(con.hello && con.hello.at > Date.now() - 60000, "the MCP server said hello"); assert.equal(con.stale, null);
  ok("the app knows Claude is connected, and the server runs the same code");

  // ---- projects in the background ----
  const open = (await json("get_basic_info")).projectId;
  const bg = await json("create_project", { name: "Background work", open: false });
  assert.equal((await json("get_basic_info")).projectId, open, "the user's window didn't move");
  const ab = await json("create_artboard", { name: "Post", preset: "instagram-post", projectId: bg.id });
  await call("write_html", { projectId: bg.id, targetNodeId: ab.id, html: `<div layer-name="Card" style="position:absolute;left:340px;top:340px;width:400px;height:400px;background:#ff4f1f"><span layer-name="Title" style="font:700 40px sans-serif;color:#fff">Hello</span></div>` });
  const bgInfo = await json("get_basic_info", { projectId: bg.id });
  assert.equal(bgInfo.artboards.length, 1); assert.equal(bgInfo.projectId, bg.id);
  assert.equal((await json("get_basic_info")).artboards.some((a) => a.name === "Post"), false, "the open project is untouched");
  const pic = (await raw("get_screenshot", { projectId: bg.id, nodeId: ab.id, scale: 0.5 })).content[0];
  assert.deepEqual(pngSize(pic.data), [540, 540]);
  ok("create_project open:false, then build and screenshot it by projectId while the user's project stays open");

  // ---- a run of Claude's changes: version first, then keep or undo ----
  let run = await op("agentState", {}, bg.id);
  assert.ok(run.open && run.ops >= 2 && run.source === "mcp", "an open run with Claude's changes");
  assert.ok(run.labels.includes("Adding layers"));
  const vers = await json("list_versions", { projectId: bg.id });
  assert.equal(vers.length, 0, "no version yet: the project was empty when the run started");
  await op("agentKeep", { projectId: bg.id });
  assert.equal((await op("agentState", {}, bg.id)).open, false);
  await call("update_styles", { projectId: bg.id, updates: [{ nodeIds: [ab.id], styles: { backgroundColor: "#111111" } }] });
  run = await op("agentState", {}, bg.id);
  assert.ok(run.open && run.ops === 1, "a new run");
  const v2 = await json("list_versions", { projectId: bg.id });
  assert.equal(v2[0].note, "Before Claude's changes"); ok("each run saves a version first (“Before Claude's changes”)");
  // before / after screenshots
  const before = (await raw("get_screenshot", { projectId: bg.id, nodeId: ab.id, state: "before", scale: 0.25 })).content[0];
  assert.deepEqual(pngSize(before.data), [270, 270]);
  await op("agentUndo", { projectId: bg.id });
  const st = (await json("get_node_info", { projectId: bg.id, nodeId: ab.id })).style;
  assert.equal(st["background-color"], "#ffffff", "undo put the background back");
  assert.equal((await op("agentState", {}, bg.id)).status, "undone");
  ok("get_screenshot state:'before', and Undo puts the project back to before the run");
  // you edit in between: undo asks first
  await call("update_styles", { projectId: bg.id, updates: [{ nodeIds: [ab.id], styles: { backgroundColor: "#222222" } }] });
  await op("updateStyles", { updates: [{ nodeIds: [ab.id], styles: { opacity: "0.9" } }] }, bg.id);
  assert.ok((await op("agentState", {}, bg.id)).mixed);
  await assert.rejects(op("agentUndo", { projectId: bg.id }), /edited since/);
  await op("agentUndo", { projectId: bg.id, force: true });
  assert.equal((await json("get_node_info", { projectId: bg.id, nodeId: ab.id })).style.opacity, undefined);
  ok("after your own edits, Undo refuses unless confirmed");
  const act = await op("activity");
  assert.ok(act.length >= 2 && act.some((a) => a.status === "undone") && act.some((a) => a.status === "kept"));
  ok("activity log: runs with their status");

  // ---- notes ----
  await call("open_project", { projectId: bg.id });
  const tree = await call("get_tree_summary", { nodeId: ab.id });
  const card = /(n\d+) Card/.exec(tree)[1], title = /(n\d+) Title/.exec(tree)[1];
  const note = await op("addNote", { nodeIds: [title], text: "Make this much bigger" });
  assert.equal(note.author, "you");
  assert.equal((await json("get_basic_info")).openNotes, 1);
  const req = await raw("get_requests");
  const reqs = JSON.parse(req.content[0].text);
  assert.equal(reqs[0].text, "Make this much bigger"); assert.equal(reqs[0].layers[0].name, "Title");
  assert.ok(req.content.some((c) => c.type === "image"), "with a picture of the layer");
  await call("update_styles", { updates: [{ nodeIds: [title], styles: { fontSize: "96px" } }] });
  await call("resolve_request", { id: note.id, reply: "Title is 96px now." });
  const done = (await op("notes")).find((n) => n.id === note.id);
  assert.equal(done.status, "done"); assert.equal(done.reply, "Title is 96px now.");
  assert.equal(await call("get_requests"), "No open notes.");
  const left = await json("leave_note", { nodeIds: [card], text: "Needs a real product photo" });
  assert.equal(left.author, "claude");
  ok("notes: you pin a request, get_requests shows it with a picture, resolve_request replies; leave_note for you");

  // ---- selection with pictures ----
  await op("selection", { ids: [card] });
  const sel = await raw("get_selection");
  assert.equal(JSON.parse(sel.content[0].text)[0].name, "Card"); assert.equal(sel.content[1].type, "image");
  ok("get_selection includes a picture of what you selected");

  // ---- links, locking, hiding ----
  await call("set_link", { nodeId: title, href: "https://example.com/shop" });
  let n = await json("get_node_info", { nodeId: title });
  assert.equal(n.tag, "a"); assert.equal(n.attrs.href, "https://example.com/shop");
  await call("set_link", { nodeId: title, href: null });
  assert.equal((await json("get_node_info", { nodeId: title })).tag, "span");
  const imgPath = path.join(tmp, "photo one.png");
  fs.copyFileSync(path.join(root, "projects/default/assets", fs.readdirSync(path.join(root, "projects/default/assets"))[0]), imgPath);
  const placed = await json("place_image", { src: imgPath, parentId: card, style: { width: "200px", height: "120px", objectFit: "cover" }, alt: "Photo" });
  await call("set_link", { nodeId: placed.id, href: "https://example.com/p" });
  n = await json("get_node_info", { nodeId: placed.id });
  assert.equal(n.link.href, "https://example.com/p"); assert.ok(n.link.own);
  assert.match((await json("get_node_info", { nodeId: card })).html, /<a href="https:\/\/example.com\/p"[^>]*><img/);
  await call("set_link", { nodeId: placed.id, href: null });
  assert.doesNotMatch((await json("get_node_info", { nodeId: card })).html, /<a /);
  ok("set_link on text and on an image (wrapped and unwrapped)");
  await call("set_locked", { nodeIds: [card], locked: true });
  assert.ok((await json("get_node_info", { nodeId: card })).locked);
  await call("set_hidden", { nodeIds: [card], hidden: true });
  assert.ok((await json("get_node_info", { nodeId: card })).hidden);
  await call("set_hidden", { nodeIds: [card], hidden: false }); await call("set_locked", { nodeIds: [card], locked: false });
  ok("set_locked, set_hidden");

  // ---- images and icons ----
  const swapped = await json("place_image", { src: "data:image/png;base64," + fs.readFileSync(imgPath).toString("base64"), replaceNodeId: placed.id, name: "swap" });
  assert.match(swapped.src, /^assets\/swap/);
  const icons = await json("search_icons", { query: "arrow right" });
  assert.ok(icons.slice(0, 3).some((i) => i.name === "arrow-right"), icons.map((i) => i.name).join(","));
  await assert.rejects(call("insert_icon", { name: "not-an-icon", parentId: card }), /No icon/);
  const ic = (await json("insert_icon", { name: "heart", parentId: card, size: 48, color: "#ff4f1f" })).created[0];
  const icn = await json("get_node_info", { nodeId: ic.id });
  assert.equal(icn.tag, "svg"); assert.equal(icn.style.width, "48px"); assert.equal(icn.style.color, "#ff4f1f");
  ok("place_image (file, data URL, swap) and the icon library (search_icons, insert_icon)");

  // ---- formats and variations ----
  const sized = (await json("resize_to_formats", { nodeId: ab.id, presets: ["story"], sizes: [{ width: 1200, height: 630, name: "Banner" }] })).created;
  assert.equal(sized.length, 2); assert.equal(sized[1].name, "Banner");
  const story = await json("get_children", { nodeId: sized[0].id });
  const storyCard = await json("get_node_info", { nodeId: story[0].id });
  assert.equal(storyCard.style.width, "400px", "scaled evenly (story is as wide)");
  assert.equal(storyCard.style.top, "760px", "kept its place relative to the frame (centred)");
  const banner = await json("get_node_info", { nodeId: (await json("get_children", { nodeId: sized[1].id }))[0].id });
  assert.equal(banner.style.width, "233.3px");
  ok("resize_to_formats: a post as a story and a banner");
  const v = await json("make_variations", { nodeId: title, count: 3 });
  assert.equal(v.copies.length, 3); assert.ok(v.copies.every((c) => c.focusId && c.focusId !== title));
  const infoV = await json("get_basic_info");
  assert.equal(infoV.artboards.filter((a) => a.variant && a.variant.set === v.set).length, 4);
  const origPos = infoV.artboards.find((a) => a.id === ab.id);
  await call("pick_variation", { nodeId: v.copies[1].id });
  const afterPick = await json("get_basic_info");
  const kept = afterPick.artboards.find((a) => a.id === v.copies[1].id);
  assert.ok(kept && !kept.variant && kept.x === origPos.x && kept.name === "Post");
  assert.ok(!afterPick.artboards.some((a) => a.id === ab.id || a.id === v.copies[0].id));
  ok("make_variations (with the focus layer in each copy) and pick_variation");

  // ---- templates ----
  const tpl = await json("save_template", { nodeId: kept.id, name: "Orange post" });
  assert.equal(tpl.kind, "Social");
  assert.equal((await json("list_templates"))[0].id, tpl.id);
  const fromTpl = await json("create_project", { name: "From template", open: false, template: tpl.id });
  const ti = await json("get_basic_info", { projectId: fromTpl.id });
  assert.equal(ti.artboards.length, 1); assert.equal(ti.artboards[0].name, "Orange post");
  assert.ok(fs.readdirSync(path.join(tmp, fromTpl.id, "assets")).some((f) => f.startsWith("swap")), "its image came along");
  const used2 = await json("use_template", { templateId: tpl.id });
  assert.ok((await json("get_basic_info")).artboards.some((a) => a.id === used2.id));
  ok("save_template, list_templates, create_project from a template, use_template");

  // ---- critique ----
  const bad = await json("create_artboard", { name: "Bad", width: 600, height: 400 });
  await call("write_html", { targetNodeId: bad.id, html: `<div style="position:relative;width:600px;height:400px;background:#ffffff">
    <span layer-name="Faint" style="position:absolute;left:20px;top:20px;font:16px sans-serif;color:#dddddd">Hard to read text here</span>
    <div layer-name="Squeezed" style="position:absolute;left:20px;top:80px;width:120px;white-space:nowrap;font:20px sans-serif;color:#111">This sentence is far too long for its box</div>
    <span layer-name="Tiny" style="position:absolute;left:20px;top:140px;font:8px sans-serif;color:#111">fine print</span>
    <a layer-name="Dead link" style="position:absolute;left:20px;top:200px;font:16px sans-serif;color:#111">Shop now</a>
    <span layer-name="Edge" style="position:absolute;left:520px;top:300px;font:20px sans-serif;color:#111;white-space:nowrap">Falls off the edge</span></div>` });
  const cr = await json("critique", { nodeId: bad.id });
  const kinds = new Set(cr.issues.map((i) => i.kind));
  for (const k of ["contrast", "overflow", "small-text", "empty-link", "cut-off"]) assert.ok(kinds.has(k), "critique finds " + k + ": " + [...kinds].join(","));
  assert.ok(cr.issues.find((i) => i.kind === "contrast").name === "Faint");
  assert.ok(cr.summary.high >= 1);
  ok(`critique finds contrast, overflow, small text, an empty link and cut-off text (${cr.issues.length} issues)`);

  // ---- brand from a website ----
  const b = await json("brand_from_url", { url: siteUrl });
  assert.equal(b.name, "Acme Coffee"); assert.equal(b.colors[0].value, "#e8452c"); assert.ok(b.colors.some((c) => c.value === "#1f6feb"));
  assert.equal(b.fonts.body, "Work Sans"); assert.equal(b.fonts.heading, "Fraunces"); assert.match(b.logo, /logo\.png$/);
  const applied = await json("brand_from_url", { url: siteUrl, apply: true, projectId: fromTpl.id });
  assert.equal(applied.brand.name, "Acme Coffee"); assert.match(applied.brand.logo, /^assets\/logo/); assert.ok(applied.colors.some((c) => c.name === "Primary"));
  ok("brand_from_url reads name, colours, fonts and logo; apply sets the brand kit (logo downloaded)");

  // ---- zoomed screenshots ----
  const keptTitle = /(n\d+) Title/.exec(await call("get_tree_summary", { nodeId: kept.id }))[1];
  const z = (await raw("get_screenshot", { nodeId: keptTitle, scale: 1 })).content[0], zp = (await raw("get_screenshot", { nodeId: keptTitle, pad: 10, scale: 1 })).content[0];
  assert.deepEqual(pngSize(zp.data), [pngSize(z.data)[0] + 20, pngSize(z.data)[1] + 20], "pad adds context around the layer");
  const reg = (await raw("get_screenshot", { nodeId: bad.id, region: { x: 0, y: 0, width: 100, height: 50 }, scale: 3 })).content[0];
  assert.deepEqual(pngSize(reg.data), [300, 150]);
  ok("get_screenshot with pad, region and scale");

  // ---- project tools ----
  const dup = await json("duplicate_project", { id: fromTpl.id, name: "Copy of it" });
  await call("rename_project", { id: dup.id, name: "Renamed copy" });
  assert.ok((await json("list_projects")).some((p) => p.id === dup.id && p.name === "Renamed copy"));
  await call("trash_project", { id: dup.id });
  assert.ok((await json("list_trash")).some((t) => t.id === dup.id));
  await call("restore_projects", { ids: [dup.id] });
  assert.ok((await json("list_projects")).some((p) => p.id === dup.id));
  ok("duplicate, rename, trash and restore projects");
  const sv = await json("save_version", { name: "Milestone" });
  assert.equal(sv.name, "Milestone");
  await call("delete_nodes", { nodeIds: [bad.id] });
  await call("restore_version", { id: sv.id });
  assert.ok((await json("get_basic_info")).artboards.some((a) => a.id === bad.id));
  ok("save_version and restore_version");

  // ---- backups ----
  const bk = await op("backupNow");
  assert.ok(fs.existsSync(bk.file) && bk.projects >= 3, JSON.stringify(bk));
  assert.equal((await op("settings")).backups, 1);
  ok(`backups: every project in one zip (${Math.round(bk.size / 1024)} KB)`);

  console.log("\nAGENT TESTS PASSED");
} catch (e) {
  console.error("\nFAILED:", e.stack?.split("\n").slice(0, 5).join("\n") || e.message); process.exitCode = 1;
} finally {
  await client.close().catch(() => {});
  site.close();
  try { (await import("node:child_process")).execSync(`lsof -ti tcp:${PORT} | xargs kill`, { stdio: "ignore" }); } catch {}
}
