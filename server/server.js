// Local app server: serves the editor, keeps the document, and exposes the operations over HTTP.
// The MCP server (mcp.js) and the editor both call /api/op, so Claude and you edit the same document.
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { Doc } from "./doc.js";
import { fontsCss, fontsFile } from "./fonts.js";
import { screenshot, closeBrowser } from "./shot.js";
import { buildEmail, buildEmailZip, buildEml, buildImage, buildImagesZip, buildPdf, buildSlices, buildHtmlZip, fileBase } from "./exporters.js";
import { rasterPlan } from "./email.js";
import { createAsk } from "./ask.js";
import { listVersions, saveVersion, restoreVersion, renameVersion, deleteVersion, autoSnapshot } from "./history.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
export const PORT = Number(process.env.STUDIO_PORT || 4777);
// Projects live in one folder, one sub-folder each (doc.json + assets/ + meta.json).
// STUDIO_PROJECT pins one project (tests); otherwise the app and Claude share ~/Library/Application Support/Studio/projects.
const explicit = process.env.STUDIO_PROJECT ? path.resolve(process.env.STUDIO_PROJECT) : null;
const projectsRoot = path.resolve(process.env.STUDIO_PROJECTS || (explicit ? path.dirname(explicit) : path.join(os.homedir(), "Library", "Application Support", "Studio", "projects")));
fs.mkdirSync(projectsRoot, { recursive: true });
const seed = path.join(root, "projects", "default");
const isProject = (d) => fs.existsSync(path.join(projectsRoot, d, "doc.json")) || fs.existsSync(path.join(projectsRoot, d, "meta.json"));
const listIds = () => fs.readdirSync(projectsRoot, { withFileTypes: true }).filter((d) => d.isDirectory() && !d.name.startsWith(".") && isProject(d.name)).map((d) => d.name);
if (!explicit && !listIds().length && fs.existsSync(seed)) {
  // first run: start with the demo project
  fs.cpSync(seed, path.join(projectsRoot, "welcome"), { recursive: true });
  fs.writeFileSync(path.join(projectsRoot, "welcome", "meta.json"), JSON.stringify({ name: "Welcome email" }));
}
const currentFile = path.join(projectsRoot, ".current");
let projectId = explicit ? path.basename(explicit) : (fs.existsSync(currentFile) && fs.readFileSync(currentFile, "utf8").trim()) || listIds()[0] || "untitled";
if (!explicit && !isProject(projectId)) projectId = listIds()[0] || "untitled";
let projectDir = path.join(projectsRoot, projectId);
let doc = new Doc(projectDir);


// the open project always counts as a project, even before its first save
setTimeout(() => { if (!isProject(projectId)) writeMeta(projectId, {}); });
function readMeta(id) {
  try { return JSON.parse(fs.readFileSync(path.join(projectsRoot, id, "meta.json"), "utf8")); } catch { return {}; }
}
function writeMeta(id, m) { fs.writeFileSync(path.join(projectsRoot, id, "meta.json"), JSON.stringify({ ...readMeta(id), ...m })); }
const projectName = (id) => readMeta(id).name || (id === "default" ? "Welcome email" : null) || id.replace(/[-_]+/g, " ").replace(/^\w/, (c) => c.toUpperCase());
function slug(name) {
  const base = (name || "untitled").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40) || "untitled";
  let id = base, i = 2;
  while (fs.existsSync(path.join(projectsRoot, id))) id = `${base}-${i++}`;
  return id;
}
function projectList() {
  return listIds().map((id) => {
    const dir = path.join(projectsRoot, id), f = path.join(dir, "doc.json");
    let st = { artboards: [] };
    if (id === projectId) st = doc.state;
    else try { st = JSON.parse(fs.readFileSync(f, "utf8")); } catch {}
    const mtime = Math.max(fs.existsSync(f) ? fs.statSync(f).mtimeMs : 0, fs.existsSync(path.join(dir, "meta.json")) ? fs.statSync(path.join(dir, "meta.json")).mtimeMs : 0);
    const cover = st.artboards[0];
    return { id, name: projectName(id), updated: mtime, artboards: st.artboards.length, current: id === projectId, cover: cover ? { width: parseInt(cover.style.width, 10) || 600, height: parseInt(cover.style.height, 10) || 0 } : null };
  }).sort((a, b) => b.updated - a.updated);
}
// trash entries are "<project id>-<deleted at ms>" folders under .trash
const trashRoot = path.join(projectsRoot, ".trash");
function trashList() {
  if (!fs.existsSync(trashRoot)) return [];
  return fs.readdirSync(trashRoot, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => {
    const m = /^(.*)-(\d{10,})$/.exec(d.name), id = m ? m[1] : d.name, dir = path.join(trashRoot, d.name);
    let meta = {}, st = { artboards: [] };
    try { meta = JSON.parse(fs.readFileSync(path.join(dir, "meta.json"), "utf8")); } catch {}
    try { st = JSON.parse(fs.readFileSync(path.join(dir, "doc.json"), "utf8")); } catch {}
    return { entry: d.name, id, name: meta.name || id.replace(/[-_]+/g, " ").replace(/^\w/, (c) => c.toUpperCase()), deleted: m ? +m[2] : fs.statSync(dir).mtimeMs, artboards: st.artboards.length };
  }).sort((a, b) => b.deleted - a.deleted);
}
function trashEntries(entries) {
  const all = trashList(), list = [];
  for (const en of entries || []) { const e = all.find((x) => x.entry === en); if (!e) throw new Error(`Not in the trash: "${en}".`); list.push(e); }
  return list;
}
function openProject(id) {
  if (!isProject(id)) throw new Error(`No project "${id}".`);
  if (id === projectId) return;
  clearTimeout(doc._save); doc.save();
  projectId = id; projectDir = path.join(projectsRoot, id);
  doc = new Doc(projectDir);
  attach(doc);
  if (!explicit) fs.writeFileSync(currentFile, id);
  writeMeta(id, { opened: Date.now() });
  doc.changed();
}
function createProject({ name = "Untitled", artboard } = {}) {
  const id = slug(name);
  fs.mkdirSync(path.join(projectsRoot, id, "assets"), { recursive: true });
  fs.writeFileSync(path.join(projectsRoot, id, "doc.json"), JSON.stringify({ nextId: 1, artboards: [] }));
  writeMeta(id, { name });
  openProject(id);
  if (artboard) doc.createArtboard(artboard);
  doc.undoStack = []; doc.redoStack = []; doc.changed();
  return { id, name };
}

const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".woff2": "font/woff2",
  ".woff": "font/woff",
  ".ttf": "font/ttf",
  ".otf": "font/otf",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".svg": "image/svg+xml",
  ".avif": "image/avif",
};

// All operations, by name. Each takes an args object and returns JSON-able data.
const ops = {
  info: () => ({
    project: projectDir,
    projectId,
    projectName: projectName(projectId),
    url: `http://127.0.0.1:${PORT}`,
    version: doc.version,
    selection: doc.selection,
    artboards: doc.state.artboards.map((a) => ({ id: a.id, name: a.name, width: a.style.width, height: a.style.height, x: a.x, y: a.y, childCount: a.children.length })),
  }),
  tree: ({ nodeId, depth = 4 }) => {
    if (nodeId) return doc.summary(doc.need(nodeId).node, 0, depth);
    return doc.state.artboards.map((a) => doc.summary(a, 0, depth)).join("\n") || "(no artboards yet)";
  },
  children: ({ nodeId }) => (nodeId ? doc.need(nodeId).node.children || [] : doc.state.artboards).map((n) => doc.brief(n)),
  node: ({ nodeId }) => {
    const n = doc.need(nodeId).node;
    const ab = doc.artboardOf(nodeId);
    return { id: n.id, name: doc.label(n), tag: n.tag, style: n.style, attrs: n.attrs, text: n.tag === "#text" ? n.text : undefined, artboard: ab && ab.id, html: doc.toHtml(n) };
  },
  createArtboard: (a) => doc.createArtboard(a),
  insert: (a) => doc.insert(a),
  updateStyles: ({ updates }) => doc.updateStyles(updates),
  setAttrs: ({ nodeId, attrs }) => doc.setAttrs(nodeId, attrs),
  setText: ({ nodeId, text }) => doc.setText(nodeId, text),
  setInner: ({ nodeId, html }) => doc.setInner(nodeId, html),
  rename: ({ items }) => doc.rename(items),
  remove: ({ nodeIds }) => doc.remove(nodeIds),
  duplicate: ({ nodeIds }) => doc.duplicate(nodeIds),
  move: (a) => doc.move(a),
  reorder: (a) => doc.reorder(a),
  moveArtboard: ({ nodeId, x, y }) => doc.moveArtboard(nodeId, x, y),
  removeFont: (a) => doc.removeFont(a),
  listFonts: () => doc.listFonts(),
  // version history
  historyList: () => listVersions(doc),
  historySave: ({ name }) => saveVersion(doc, { name }),
  historyRestore: ({ id }) => restoreVersion(doc, id),
  historyRename: ({ id, name }) => renameVersion(doc, id, name),
  historyDelete: ({ id }) => deleteVersion(doc, id),
  // design system: components, styles, brand kit
  createComponent: (a) => doc.createComponent(a),
  createInstance: (a) => doc.createInstance(a),
  detachInstance: (a) => doc.detachInstance(a),
  renameComponent: (a) => doc.renameComponent(a),
  deleteComponent: (a) => doc.deleteComponent(a),
  listComponents: () => doc.listComponents(),
  createStyle: (a) => doc.createStyle(a),
  updateStyle: (a) => doc.updateStyle(a),
  applyStyle: (a) => doc.applyStyle(a),
  detachStyle: (a) => doc.detachStyle(a),
  deleteStyle: (a) => doc.deleteStyle(a),
  setBrand: (a) => doc.setBrand(a),
  getBrand: () => doc.getBrand(),
  // canvas tools
  setGuides: (a) => doc.setGuides(a),
  setGrid: (a) => doc.setGrid(a),
  setAutoLayout: (a) => doc.setAutoLayout(a),
  setSvg: (a) => doc.setSvg(a),
  cropImage: (a) => doc.cropImage(a),
  uncropImage: (a) => doc.uncropImage(a),
  bakeCrop: async ({ nodeId }) => {
    const node = doc.need(nodeId).node;
    if (!node.crop) throw new Error("Nothing to bake: this isn't a zoomed crop.");
    const html = await doc.page(node, { embed: true, ids: true });
    const buf = await screenshot(html, { nodeId, width: Math.round(parseFloat(node.style.width) || 600), scale: 2 });
    return doc.bakeCropWith(nodeId, buf);
  },
  group: ({ nodeIds, frame, members, pins }) => doc.group(nodeIds, { frame, members, pins }),
  ungroup: ({ nodeIds, members, pins }) => doc.ungroup(nodeIds, { members, pins }),
  splitText: ({ nodeId, width, height }) => doc.splitText(nodeId, { width, height }),
  setHidden: ({ nodeId, hidden }) => {
    const before = doc.snapshot();
    doc.need(nodeId).node.hidden = !!hidden;
    doc.commit(before);
  },
  projects: () => projectList(),
  openProject: ({ id }) => { openProject(id); return { id, name: projectName(id) }; },
  createProject: (a) => createProject(a),
  renameProject: ({ id = projectId, name }) => { if (!name || !name.trim()) throw new Error("Name can't be empty."); writeMeta(id, { name: name.trim() }); if (id === projectId) doc.changed(); return { id, name: name.trim() }; },
  duplicateProject: ({ id }) => {
    if (id === projectId) { clearTimeout(doc._save); doc.save(); }
    const nid = slug(projectName(id) + " copy");
    fs.cpSync(path.join(projectsRoot, id), path.join(projectsRoot, nid), { recursive: true });
    writeMeta(nid, { name: projectName(id) + " copy" });
    return { id: nid, name: projectName(nid) };
  },
  deleteProject: ({ id }) => {
    if (!isProject(id)) throw new Error(`No project "${id}".`);
    // never really deleted: moved to .trash inside the projects folder
    const trash = trashRoot; fs.mkdirSync(trash, { recursive: true });
    if (id === projectId) {
      const other = listIds().find((x) => x !== id);
      if (other) openProject(other); else createProject({ name: "Untitled" });
    }
    fs.renameSync(path.join(projectsRoot, id), path.join(trash, id + "-" + Date.now()));
    return true;
  },
  trash: () => trashList(),
  restoreProjects: ({ ids }) => trashEntries(ids).map((e) => {
    const nid = slug(e.id);
    fs.renameSync(path.join(trashRoot, e.entry), path.join(projectsRoot, nid));
    return { id: nid, name: projectName(nid) };
  }),
  // the only place a project is really erased; ids omitted = empty the whole trash
  purgeProjects: ({ ids } = {}) => {
    const list = trashEntries(ids ?? trashList().map((e) => e.entry));
    for (const e of list) fs.rmSync(path.join(trashRoot, e.entry), { recursive: true, force: true });
    return list.length;
  },
  undo: () => doc.undo(),
  redo: () => doc.redo(),
  selection: ({ ids }) => {
    doc.selection = ids || [];
    for (const fn of doc.listeners) fn("selection");
  },
};

// ---- live updates to the editor ----
const clients = new Set();
const publicState = () => ({ ...doc.publicState(), project: { id: projectId, name: projectName(projectId) } });
function attach(d) {
  d.listeners.add((kind) => {
    if (d !== doc) return;
    const payload = JSON.stringify(kind === "selection" ? { selection: doc.selection } : publicState());
    for (const res of clients) res.write(`event: ${kind === "selection" ? "selection" : "doc"}\ndata: ${payload}\n\n`);
  });
}
attach(doc);
Doc.fontProxy = `http://127.0.0.1:${PORT}`;
const ask = createAsk({ port: PORT, mcpPath: path.join(here, "mcp.js"), getDoc: () => doc, broadcast: (ev) => { for (const res of clients) res.write(`event: ask\ndata: ${JSON.stringify(ev)}\n\n`); } });

setInterval(() => { try { autoSnapshot(doc, Number(process.env.STUDIO_HISTORY_EVERY_MS) || undefined); } catch (e) { console.error("history:", e.message); } }, Number(process.env.STUDIO_HISTORY_TICK_MS) || 60000).unref();

const readBody = (req) =>
  new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
const send = (res, code, body, type = "application/json") => {
  res.writeHead(code, { "content-type": type, "cache-control": "no-store" });
  res.end(typeof body === "string" || Buffer.isBuffer(body) ? body : JSON.stringify(body));
};
const serveFile = (res, file) => {
  if (!fs.existsSync(file) || !fs.statSync(file).isFile()) return send(res, 404, "Not found", "text/plain");
  res.writeHead(200, { "content-type": TYPES[path.extname(file).toLowerCase()] || "application/octet-stream", "cache-control": "no-store" });
  fs.createReadStream(file).pipe(res);
};

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const p = url.pathname;
  try {
    // ---- Ask Claude (runs Claude Code with the Studio tools only)
    if (p === "/api/ask" && req.method === "GET") return send(res, 200, { available: ask.available(), run: ask.view() });
    if (p === "/api/ask" && req.method === "POST") {
      const { prompt, selection } = JSON.parse((await readBody(req)).toString() || "{}");
      if (!prompt || !String(prompt).trim()) throw new Error("Write what you want Claude to do.");
      return send(res, 200, { ok: true, run: ask.start({ prompt, selection: Array.isArray(selection) ? selection : [] }) });
    }
    if (p === "/api/ask/cancel" && req.method === "POST") return send(res, 200, { ok: ask.cancel() });
    if (p === "/api/ask/undo" && req.method === "POST") return send(res, 200, { ok: true, undone: ask.undoRun() });
    if (p === "/api/ping") return send(res, 200, { ok: true, project: projectDir });
    if (p === "/api/doc") return send(res, 200, publicState());
    // editor errors end up in the server log (the Mac app has no visible console)
    if (p === "/api/log" && req.method === "POST") { console.error("[editor]", (await readBody(req)).toString().slice(0, 2000)); return send(res, 200, { ok: true }); }
    // a project's first artboard as a small page, for the home screen thumbnails
    const pm = /^\/api\/projects\/([\w.-]+)\/(preview|assets\/.+)$/.exec(p);
    if (pm) {
      const id = pm[1];
      if (!isProject(id)) return send(res, 404, "Not found", "text/plain");
      if (pm[2].startsWith("assets/")) return serveFile(res, path.join(projectsRoot, id, decodeURIComponent(pm[2])));
      const d = id === projectId ? doc : new Doc(path.join(projectsRoot, id));
      const ab = d.state.artboards[0];
      const body = ab ? d.toHtml(ab, { asRoot: true }) : "";
      return send(res, 200, `<!doctype html><html><head><meta charset="utf-8">${ab ? d.fontLink(ab, { local: true }) : ""}<style>${d.fontFaceCss({ abs: true })}*{box-sizing:border-box}html,body{margin:0;padding:0;background:transparent;overflow:hidden}img{display:block}</style></head><body>${body}</body></html>`, TYPES[".html"]);
    }
    if (p === "/api/events") {
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-store", connection: "keep-alive" });
      res.write(`event: doc\ndata: ${JSON.stringify(publicState())}\n\n`);
      clients.add(res);
      req.on("close", () => clients.delete(res));
      return;
    }
    if (p === "/api/op" && req.method === "POST") {
      const { op, args = {} } = JSON.parse((await readBody(req)).toString() || "{}");
      if (!ops[op]) return send(res, 400, { error: `Unknown operation: ${op}` });
      const result = await ops[op](args);
      return send(res, 200, { ok: true, result: result === undefined ? null : result });
    }
    // Google Fonts through a local cache; custom fonts of the open project
    if (p === "/fonts/css2") {
      try { return send(res, 200, await fontsCss(url.search), "text/css; charset=utf-8"); }
      catch (e) { return send(res, 502, `/* ${e.message} */`, "text/css; charset=utf-8"); }
    }
    if (p === "/fonts/file") {
      try { const b = await fontsFile(url.searchParams.get("u") || ""); res.writeHead(200, { "content-type": "font/woff2", "cache-control": "max-age=31536000", "access-control-allow-origin": "*" }); return res.end(b); }
      catch (e) { return send(res, 502, { error: e.message }); }
    }
    if (p === "/api/font" && req.method === "POST") {
      const r = doc.addFont({ family: url.searchParams.get("family"), weight: url.searchParams.get("weight") || "400", style: url.searchParams.get("style") || "normal", name: url.searchParams.get("name"), data: await readBody(req) });
      return send(res, 200, { ok: true, font: r });
    }
    if (p === "/api/upload" && req.method === "POST") {
      const name = url.searchParams.get("name") || "image.png";
      const rel = doc.addAsset(name, await readBody(req));
      return send(res, 200, { ok: true, src: rel });
    }
    // which sections would become image slices in the email export (no rendering: instant)
    if (p === "/api/email-plan") {
      const node = doc.need(url.searchParams.get("id")).node;
      const mode = ["none", "all"].includes(url.searchParams.get("raster")) ? url.searchParams.get("raster") : "auto";
      return send(res, 200, { sections: rasterPlan(node, mode).map((n) => ({ id: n.id, name: doc.label(n) })), total: (node.children || []).length });
    }
    if (p === "/api/export") {
      const q = (k) => url.searchParams.get(k);
      const fmt = q("format") || "html";
      const all = q("scope") === "all";
      const node = all ? (doc.state.artboards[0] || (() => { throw new Error("No artboards yet."); })()) : doc.need(q("id")).node;
      const imgOpts = { type: { png: "png", jpg: "jpeg", jpeg: "jpeg", webp: "webp" }[fmt], scale: Number(q("scale")) || 2, quality: Number(q("quality")) || 90 };
      const eo = { raster: ["none", "all"].includes(q("raster")) ? q("raster") : q("raster") === "0" ? "none" : "auto", images: q("images") === "files" ? "files" : "data", format: q("quality") === "png" ? "png" : "jpeg" };
      const base = fileBase(node);
      const head = (type, name, warn) => ({ "content-type": type, "content-disposition": `attachment; filename="${name}"`, "x-email-warnings": encodeURIComponent(JSON.stringify(warn || [])), "access-control-expose-headers": "x-email-warnings" });
      if (fmt === "email") {
        const ep = await buildEmail(doc, node, eo);
        // embed=0 keeps hosted paths for pasting into an ESP; the default inlines everything into one file
        let html = ep.html;
        if (q("embed") === "0" && eo.images === "data") html = (await buildEmail(doc, node, { ...eo, images: "files" })).html;
        res.writeHead(200, head(TYPES[".html"], base + "-email.html", ep.warnings));
        return res.end(html);
      }
      if (fmt === "email-zip") { const r = await buildEmailZip(doc, node, eo); res.writeHead(200, head("application/zip", base + "-email.zip", r.warnings)); return res.end(r.zip); }
      if (fmt === "eml") { const r = await buildEml(doc, node, eo); res.writeHead(200, head("message/rfc822", base + ".eml", r.warnings)); return res.end(r.eml); }
      const pname = doc.state.artboards.length > 1 || all ? (projectId || "project").replace(/[^\w\-]+/g, "-").toLowerCase() : base;
      if (imgOpts.type) {
        if (all) { res.writeHead(200, head("application/zip", pname + "-" + fmt + ".zip")); return res.end(await buildImagesZip(doc, doc.state.artboards, imgOpts)); }
        const r = await buildImage(doc, node, imgOpts); res.writeHead(200, head(r.mime, base + "." + r.ext)); return res.end(r.buf);
      }
      if (fmt === "pdf") { const abs = all ? doc.state.artboards : [doc.artboardOf(node.id) || node]; res.writeHead(200, head("application/pdf", (all ? pname : base) + ".pdf")); return res.end(await buildPdf(doc, abs)); }
      if (fmt === "slices") { res.writeHead(200, head("application/zip", base + "-slices.zip")); return res.end(await buildSlices(doc, doc.artboardOf(node.id) || node, { type: { jpg: "jpeg", webp: "webp" }[q("type")] || "png", scale: imgOpts.scale, quality: imgOpts.quality })); }
      if (all) { res.writeHead(200, head("application/zip", pname + "-html.zip")); return res.end(await buildHtmlZip(doc, doc.state.artboards)); }
      const html = await doc.page(node, { embed: q("embed") !== "0" });
      res.writeHead(200, head(TYPES[".html"], base + ".html", []));
      return res.end(html);
    }
    if (p === "/api/screenshot") {
      const id = url.searchParams.get("id");
      const ab = doc.artboardOf(id);
      if (!ab) throw new Error(`No node with id "${id}".`);
      const html = await doc.page(ab, { embed: true, ids: true, local: true });
      const png = await screenshot(html, { nodeId: id, width: parseInt(ab.style.width, 10) || 600, scale: Number(url.searchParams.get("scale") || 1) });
      return send(res, 200, png, "image/png");
    }
    if (p.startsWith("/assets/")) return serveFile(res, path.join(projectDir, decodeURIComponent(p)));
    if (p.startsWith("/editor/")) return serveFile(res, path.join(root, p));
    if (p === "/") return serveFile(res, path.join(root, "editor", "index.html"));
    send(res, 404, "Not found", "text/plain");
  } catch (e) {
    send(res, 400, { error: e.message });
  }
});

server.on("error", (e) => {
  if (e.code === "EADDRINUSE") {
    console.error(`Port ${PORT} is already in use. Studio is probably already running at http://127.0.0.1:${PORT}`);
    process.exit(0);
  }
  throw e;
});
server.listen(PORT, "127.0.0.1", () => console.log(`AI Studio running at http://127.0.0.1:${PORT}\nProjects: ${projectsRoot}\nOpen: ${projectId}`));
for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, async () => { clearTimeout(doc._save); doc.save(); await closeBrowser(); process.exit(0); });
