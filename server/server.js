// Local app server: serves the editor, keeps the documents, and exposes the operations over HTTP.
// The MCP server (mcp.js) and the editor both call /api/op, so Claude and you edit the same documents.
// Any operation can name a projectId to work on that project without opening it; Claude's operations are grouped into runs (agent.js).
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawn } from "node:child_process";
import { AsyncLocalStorage } from "node:async_hooks";
import { fileURLToPath } from "node:url";
import { Doc } from "./doc.js";
import { fontsCss, fontsFile } from "./fonts.js";
import { screenshot, closeBrowser, inspectPage } from "./shot.js";
import { buildEmail, buildEmailZip, buildEml, buildImage, buildImagesZip, buildPdf, buildSlices, buildHtmlZip, fileBase } from "./exporters.js";
import { rasterPlan } from "./email.js";
import { createAsk } from "./ask.js";
import { listVersions, saveVersion, restoreVersion, renameVersion, deleteVersion, autoSnapshot } from "./history.js";
import { createAgent, READ_ONLY, PROJECT_OPS } from "./agent.js";
import { createNotes } from "./notes.js";
import { createTemplates, kindOf } from "./templates.js";
import { brandFromUrl } from "./brandurl.js";
import { critique } from "./critique.js";
import { searchIcons, iconSvg } from "./icons.js";
import { codeHash, createBackups } from "./upkeep.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
export const PORT = Number(process.env.STUDIO_PORT || 4777);
const HASH = codeHash(root);
const BUNDLE = /\.app\/Contents\/Resources\/app$/.test(root);
// Projects live in one folder, one sub-folder each (doc.json + assets/ + meta.json).
// STUDIO_PROJECT pins one project (tests); otherwise the app and Claude share ~/Library/Application Support/Studio/projects.
const explicit = process.env.STUDIO_PROJECT ? path.resolve(process.env.STUDIO_PROJECT) : null;
const projectsRoot = path.resolve(process.env.STUDIO_PROJECTS || (explicit ? path.dirname(explicit) : path.join(os.homedir(), "Library", "Application Support", "Studio", "projects")));
fs.mkdirSync(projectsRoot, { recursive: true });
const seed = path.join(root, "projects", "default");
const isProject = (d) => /^[\w.-]+$/.test(d) && !d.startsWith(".") && (fs.existsSync(path.join(projectsRoot, d, "doc.json")) || fs.existsSync(path.join(projectsRoot, d, "meta.json")));
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
doc.projectId = projectId;

// every document that has been opened stays loaded (with its own undo history), so Claude can work on one in the background
const docs = new Map([[projectId, doc]]);
function docFor(id) {
  if (!id || id === projectId) return doc;
  let d = docs.get(id);
  if (!d) {
    if (!isProject(id)) throw new Error(`No project "${id}". Use list_projects to see the ids.`);
    d = new Doc(path.join(projectsRoot, id)); d.projectId = id; docs.set(id, d); attach(d);
  }
  return d;
}
function dropDoc(id) { const d = docs.get(id); if (d) { clearTimeout(d._save); d.listeners.clear(); docs.delete(id); } }

// the document the current operation works on (an operation can name another project than the open one)
const als = new AsyncLocalStorage();
const D = () => als.getStore()?.doc || doc;
const SOURCE = () => als.getStore()?.source || "user";

// the open project always counts as a project, even before its first save
setTimeout(() => { if (!isProject(projectId)) writeMeta(projectId, {}); });
function readMeta(id) {
  try { return JSON.parse(fs.readFileSync(path.join(projectsRoot, id, "meta.json"), "utf8")); } catch { return {}; }
}
function writeMeta(id, m) { fs.writeFileSync(path.join(projectsRoot, id, "meta.json"), JSON.stringify({ ...readMeta(id), ...m })); }
const projectName = (id) => readMeta(id).name || (id === "default" ? "Welcome email" : null) || String(id || "").replace(/[-_]+/g, " ").replace(/^\w/, (c) => c.toUpperCase());
function slug(name) {
  const base = (name || "untitled").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40) || "untitled";
  let id = base, i = 2;
  while (fs.existsSync(path.join(projectsRoot, id))) id = `${base}-${i++}`;
  return id;
}
function openNotesIn(id) {
  const d = docs.get(id);
  if (d) return notes.openCount(d);
  try { return JSON.parse(fs.readFileSync(path.join(projectsRoot, id, "notes.json"), "utf8")).filter((n) => n.status === "open" && n.author !== "claude").length; } catch { return 0; }
}
function projectList() {
  const act = agent.activity();
  return listIds().map((id) => {
    const dir = path.join(projectsRoot, id), f = path.join(dir, "doc.json");
    let st = { artboards: [] };
    if (docs.has(id)) st = docs.get(id).state;
    else try { st = JSON.parse(fs.readFileSync(f, "utf8")); } catch {}
    const mtime = Math.max(fs.existsSync(f) ? fs.statSync(f).mtimeMs : 0, fs.existsSync(path.join(dir, "meta.json")) ? fs.statSync(path.join(dir, "meta.json")).mtimeMs : 0);
    const real = st.artboards.filter((a) => !a.free), cover = real[0];
    const w = cover ? parseInt(cover.style.width, 10) || 600 : 0, h = cover ? parseInt(cover.style.height, 10) || 0 : 0;
    const claude = act.find((a) => a.projectId === id);
    return { id, name: projectName(id), updated: mtime, artboards: real.length, current: id === projectId, cover: cover ? { width: w, height: h } : null, kind: cover ? kindOf(w, h) : "Empty", notes: openNotesIn(id), claudeAt: claude ? claude.lastAt : null };
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
  for (const en of entries || []) { const e = all.find((x) => x.entry === en || x.id === en); if (!e) throw new Error(`Not in the trash: "${en}".`); list.push(e); }
  return list;
}
function openProject(id) {
  if (!isProject(id)) throw new Error(`No project "${id}".`);
  if (id === projectId) return;
  clearTimeout(doc._save); doc.save();
  let next = docs.get(id);
  if (!next) { next = new Doc(path.join(projectsRoot, id)); next.projectId = id; docs.set(id, next); attach(next); }
  projectId = id; projectDir = path.join(projectsRoot, id);
  doc = next;
  if (!explicit) fs.writeFileSync(currentFile, id);
  writeMeta(id, { opened: Date.now() });
  doc.changed();
}
function createProject({ name = "Untitled", artboard, template, open = true } = {}) {
  const id = slug(name);
  fs.mkdirSync(path.join(projectsRoot, id, "assets"), { recursive: true });
  fs.writeFileSync(path.join(projectsRoot, id, "doc.json"), JSON.stringify({ nextId: 1, artboards: [] }));
  writeMeta(id, { name });
  const d = open ? (openProject(id), doc) : docFor(id);
  if (artboard) d.createArtboard(artboard);
  if (template) templates.use(d, { templateId: template });
  d.undoStack = []; d.redoStack = []; d.changed();
  return { id, name, open };
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

// ---- live updates to the editor ----
const clients = new Set();
const sse = (event, data) => { const s = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`; for (const res of clients) res.write(s); };
const publicState = () => ({ ...doc.publicState(), project: { id: projectId, name: projectName(projectId) }, notes: notes.list(doc), run: agent.view(doc) });
const bgTimers = new Map();
function attach(d) {
  d.listeners.add((kind) => {
    if (d === doc) {
      if (kind === "selection") sse("selection", { selection: doc.selection });
      else sse("doc", publicState());
      return;
    }
    // another project changed (Claude working on it in the background): tell the editor, at most every 1.5 s
    if (kind === "selection" || bgTimers.has(d.projectId)) return;
    bgTimers.set(d.projectId, setTimeout(() => { bgTimers.delete(d.projectId); sse("bg", { projectId: d.projectId, name: projectName(d.projectId) }); }, 1500));
  });
}
attach(doc);
Doc.fontProxy = `http://127.0.0.1:${PORT}`;

const agent = createAgent({ broadcast: (ev) => sse("agent", ev), activityFile: path.join(projectsRoot, ".activity.json"), nameOf: projectName, saveVersion });
const notes = createNotes({ onChange: (d) => { if (d === doc) sse("notes", { notes: notes.list(doc) }); else sse("bg", { projectId: d.projectId, name: projectName(d.projectId) }); } });
const templates = createTemplates({ root: path.join(projectsRoot, ".templates"), Doc });
const backups = createBackups({ projectsRoot, settingsFile: path.join(projectsRoot, ".settings.json"), defaultDir: process.env.STUDIO_PROJECTS ? path.join(projectsRoot, ".backups") : path.join(path.dirname(projectsRoot), "Backups") });
const ask = createAsk({ port: PORT, mcpPath: path.join(here, "mcp.js"), getDoc: () => doc, broadcast: (ev) => sse("ask", ev) });

// ---- is Claude connected, and is this server the newest code? ----
let lastHello = null, stale = null, restarting = false;
let configured = { at: 0, value: null };
function claudeConfigured() {
  if (Date.now() - configured.at < 60000) return configured.value;
  let v = false;
  try { const s = fs.readFileSync(path.join(os.homedir(), ".claude.json"), "utf8"); v = s.includes("ai-studio") || s.includes("studio/server/mcp.js"); } catch {}
  configured = { at: Date.now(), value: v };
  return v;
}
function restartSoon() {
  if (restarting) return; restarting = true;
  // a fresh copy of this server from the same folder takes over the port once this one has saved and exited
  spawn("/bin/sh", ["-c", `sleep 1; exec "${process.execPath}" "${path.join(here, "server.js")}"`], { detached: true, stdio: "ignore", env: process.env }).unref();
  setTimeout(() => shutdown(), 150);
}

// All operations, by name. Each takes an args object and returns JSON-able data.
const ops = {
  info: () => {
    const d = D();
    return {
      project: d.dir, projectId: d.projectId, projectName: projectName(d.projectId), openProjectId: projectId,
      url: `http://127.0.0.1:${PORT}`, version: d.version, selection: d.selection,
      artboards: d.boards().map((a) => ({ id: a.id, name: a.name, width: a.style.width, height: a.style.height, x: a.x, y: a.y, childCount: a.children.length, ...(a.variant ? { variant: a.variant } : {}) })),
      openNotes: notes.openCount(d),
      // layers placed on the canvas outside every artboard: kept in the project, not exported
      canvasLayers: d.state.artboards.filter((a) => a.free).map((a) => ({ id: a.id, name: d.label(a), x: a.x, y: a.y })),
    };
  },
  tree: ({ nodeId, depth = 4 }) => {
    const d = D();
    if (nodeId) return d.summary(d.need(nodeId).node, 0, depth);
    return d.state.artboards.map((a) => d.summary(a, 0, depth)).join("\n") || "(no artboards yet)";
  },
  children: ({ nodeId }) => { const d = D(); return (nodeId ? d.need(nodeId).node.children || [] : d.state.artboards).map((n) => d.brief(n)); },
  node: ({ nodeId }) => {
    const d = D(), n = d.need(nodeId).node, ab = d.artboardOf(nodeId), link = d.linkOf(nodeId);
    return { id: n.id, name: d.label(n), tag: n.tag, style: n.style, attrs: n.attrs, text: n.tag === "#text" ? n.text : undefined, artboard: ab && ab.id, ...(link ? { link } : {}), ...(n.locked ? { locked: true } : {}), ...(n.hidden ? { hidden: true } : {}), html: d.toHtml(n) };
  },
  createArtboard: (a) => D().createArtboard(a),
  insert: (a) => D().insert(a),
  updateStyles: ({ updates }) => D().updateStyles(updates),
  setAttrs: ({ nodeId, attrs }) => D().setAttrs(nodeId, attrs),
  setText: ({ nodeId, text }) => D().setText(nodeId, text),
  setInner: ({ nodeId, html }) => D().setInner(nodeId, html),
  rename: ({ items }) => D().rename(items),
  remove: ({ nodeIds }) => D().remove(nodeIds),
  duplicate: ({ nodeIds }) => D().duplicate(nodeIds),
  move: (a) => D().move(a),
  reorder: (a) => D().reorder(a),
  moveArtboard: ({ nodeId, x, y }) => D().moveArtboard(nodeId, x, y),
  removeFont: (a) => D().removeFont(a),
  listFonts: () => D().listFonts(),
  // version history
  historyList: () => listVersions(D()),
  historySave: ({ name }) => saveVersion(D(), { name }),
  historyRestore: ({ id }) => restoreVersion(D(), id),
  historyRename: ({ id, name }) => renameVersion(D(), id, name),
  historyDelete: ({ id }) => deleteVersion(D(), id),
  // design system: components, styles, brand kit
  createComponent: (a) => D().createComponent(a),
  createInstance: (a) => D().createInstance(a),
  detachInstance: (a) => D().detachInstance(a),
  renameComponent: (a) => D().renameComponent(a),
  deleteComponent: (a) => D().deleteComponent(a),
  listComponents: () => D().listComponents(),
  createStyle: (a) => D().createStyle(a),
  updateStyle: (a) => D().updateStyle(a),
  applyStyle: (a) => D().applyStyle(a),
  detachStyle: (a) => D().detachStyle(a),
  deleteStyle: (a) => D().deleteStyle(a),
  setBrand: (a) => D().setBrand(a),
  getBrand: () => D().getBrand(),
  brandFromUrl: ({ url }) => brandFromUrl(url),
  setBrandFromUrl: async ({ url }) => {
    const d = D(), b = await brandFromUrl(url);
    let logo; if (b.logo) { try { logo = await d.fetchAsset(b.logo, "logo"); } catch {} }
    return d.setBrand({ name: b.name, colors: b.colors, fonts: { heading: b.fonts.heading, body: b.fonts.body }, notes: b.notes, ...(logo ? { logo } : {}) });
  },
  // canvas tools
  setGuides: (a) => D().setGuides(a),
  setGrid: (a) => D().setGrid(a),
  setAutoLayout: (a) => D().setAutoLayout(a),
  setSvg: (a) => D().setSvg(a),
  cropImage: (a) => D().cropImage(a),
  uncropImage: (a) => D().uncropImage(a),
  bakeCrop: async ({ nodeId }) => {
    const d = D(), node = d.need(nodeId).node;
    if (!node.crop) throw new Error("Nothing to bake: this isn't a zoomed crop.");
    const html = await d.page(node, { embed: true, ids: true });
    const buf = await screenshot(html, { nodeId, width: Math.round(parseFloat(node.style.width) || 600), scale: 2 });
    return d.bakeCropWith(nodeId, buf);
  },
  group: ({ nodeIds, frame, members, pins }) => D().group(nodeIds, { frame, members, pins }),
  ungroup: ({ nodeIds, members, pins }) => D().ungroup(nodeIds, { members, pins }),
  splitText: ({ nodeId, width, height }) => D().splitText(nodeId, { width, height }),
  setHidden: ({ nodeId, nodeIds, hidden }) => {
    const d = D(), before = d.snapshot();
    for (const id of nodeIds || [nodeId]) d.need(id).node.hidden = !!hidden;
    d.commit(before);
  },
  setLocked: (a) => D().setLocked(a),
  setLink: (a) => D().setLink(a),
  relocate: (a) => D().relocate(a),
  placeImage: (a) => D().placeImage(a),
  insertIcon: (a) => D().insertIcon(a),
  searchIcons: ({ query, limit }) => searchIcons(query, limit),
  resizeArtboard: (a) => D().resizeArtboard(a),
  makeVariants: (a) => D().makeVariants(a),
  pickVariant: (a) => D().pickVariant(a),
  discardVariants: (a) => D().discardVariants(a),
  critique: async ({ nodeId }) => {
    const d = D(), ab = nodeId ? d.artboardOf(nodeId) : d.boards()[0];
    if (!ab) throw new Error(nodeId ? `No artboard for "${nodeId}".` : "No artboards yet.");
    return critique(d, ab, { inspect: inspectPage });
  },
  // notes on the canvas (requests for Claude, and notes Claude leaves for you)
  notes: (a = {}) => notes.list(D(), a),
  addNote: (a) => notes.add(D(), { ...a, author: a.author || (SOURCE() === "user" ? "you" : "claude") }),
  updateNote: (a) => notes.update(D(), a),
  resolveNote: (a) => notes.resolve(D(), a),
  reopenNote: (a) => notes.reopen(D(), a),
  deleteNote: (a) => notes.remove(D(), a),
  clearDoneNotes: () => notes.clearDone(D()),
  // templates
  listTemplates: () => templates.list(),
  saveTemplate: (a) => templates.save(D(), a),
  useTemplate: (a) => templates.use(D(), a),
  renameTemplate: (a) => templates.rename(a),
  deleteTemplate: (a) => templates.remove(a),
  // Claude's runs: keep or undo what it changed
  agentState: () => agent.view(D()),
  agentKeep: ({ projectId: pid } = {}) => agent.keep(docFor(pid)),
  agentUndo: ({ projectId: pid, force } = {}) => agent.undo(docFor(pid), { force }),
  activity: () => agent.activity(),
  // projects
  projects: () => projectList(),
  openProject: ({ id }) => { openProject(id); return { id, name: projectName(id) }; },
  createProject: (a) => createProject(a),
  renameProject: ({ id = projectId, name }) => { if (!name || !name.trim()) throw new Error("Name can't be empty."); if (!isProject(id)) throw new Error(`No project "${id}".`); writeMeta(id, { name: name.trim() }); if (id === projectId) doc.changed(); return { id, name: name.trim() }; },
  duplicateProject: ({ id = projectId, name }) => {
    if (!isProject(id)) throw new Error(`No project "${id}".`);
    const d = docs.get(id); if (d) { clearTimeout(d._save); d.save(); }
    const nm = (name && name.trim()) || projectName(id) + " copy";
    const nid = slug(nm);
    fs.cpSync(path.join(projectsRoot, id), path.join(projectsRoot, nid), { recursive: true });
    fs.rmSync(path.join(projectsRoot, nid, "notes.json"), { force: true });
    writeMeta(nid, { name: nm });
    return { id: nid, name: projectName(nid) };
  },
  deleteProject: ({ id }) => {
    if (!isProject(id)) throw new Error(`No project "${id}".`);
    // never really deleted: moved to .trash inside the projects folder
    fs.mkdirSync(trashRoot, { recursive: true });
    if (id === projectId) {
      const other = listIds().find((x) => x !== id);
      if (other) openProject(other); else createProject({ name: "Untitled" });
    }
    dropDoc(id);
    fs.renameSync(path.join(projectsRoot, id), path.join(trashRoot, id + "-" + Date.now()));
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
  // settings and backups
  settings: () => backups.settings(),
  setSettings: (a) => backups.setSettings(a),
  backupNow: () => backups.backupNow(),
  revealBackups: () => { const dir = backups.settings().backupDir; fs.mkdirSync(dir, { recursive: true }); spawn("open", [dir], { detached: true, stdio: "ignore" }).unref(); return dir; },
  connection: () => ({ hello: lastHello, configured: claudeConfigured(), hash: HASH, root, bundle: BUNDLE, stale, askAvailable: ask.available() }),
  // the MCP server says hello when it starts: tells us Claude is connected, and whether we run older code than it has
  hello: ({ hash, root: srcRoot, source = "mcp" } = {}) => {
    if (source === "mcp") lastHello = { at: Date.now() };
    if (hash && hash !== HASH && srcRoot) {
      if (path.resolve(srcRoot) === root && !BUNDLE) { restartSoon(); return { hash: HASH, restarting: true }; }
      stale = { sourceRoot: path.resolve(srcRoot), bundle: BUNDLE, at: Date.now() };
      sse("system", { stale });
    }
    return { hash: HASH, restarting: false, stale };
  },
  restartServer: () => { restartSoon(); return true; },
  rebuildApp: () => {
    if (!BUNDLE || !stale) throw new Error("Nothing to rebuild: Studio is up to date.");
    const app = path.resolve(root, "../../.."), script = path.join(stale.sourceRoot, "scripts", "make-app.sh");
    // quit, rebuild from the newer code, open again (the old app reopens if the build fails)
    spawn("/bin/bash", ["-c", `sleep 1; osascript -e 'quit app "Studio"' >/dev/null 2>&1; sleep 2; bash "${script}" "${app}" > "${path.join(os.tmpdir(), "studio-rebuild.log")}" 2>&1; open "${app}"`], { detached: true, stdio: "ignore" }).unref();
    return true;
  },
  ops: () => Object.keys(ops),
  undo: () => D().undo(),
  redo: () => D().redo(),
  selection: ({ ids }) => {
    const d = D();
    d.selection = ids || [];
    for (const fn of d.listeners) fn("selection");
  },
};

// run one operation on a document, inside its context; Claude's operations join a run
async function runOp(name, args, target, source) {
  if (!ops[name]) throw new Error(`Unknown operation: ${name}`);
  const pre = agent.before(target, source, name);
  const result = await als.run({ doc: target, source }, () => ops[name](args || {}));
  agent.after(target, source, name, args, result, pre);
  return result;
}

setInterval(() => { for (const d of docs.values()) { try { autoSnapshot(d, Number(process.env.STUDIO_HISTORY_EVERY_MS) || undefined); } catch (e) { console.error("history:", e.message); } } }, Number(process.env.STUDIO_HISTORY_TICK_MS) || 60000).unref();
if (!explicit && !process.env.STUDIO_NO_BACKUP) { setTimeout(() => backups.tick(), 20000).unref(); setInterval(() => backups.tick(), 60 * 60 * 1000).unref(); }

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
// a document as it was when Claude's open run started (for before / after screenshots)
function beforeRun(d) {
  if (!d._run || !d._run.open) throw new Error("There's no open run of Claude's changes to compare with.");
  const s = Object.create(d); s.state = JSON.parse(d._run.before); return s;
}
// font and image paths stay relative: the page is served at /api/<projects|templates>/<id>/preview, next to that folder's assets
const previewPage = (d, ab) => `<!doctype html><html><head><meta charset="utf-8">${ab ? d.fontLink(ab, { local: true }) : ""}<style>${d.fontFaceCss()}*{box-sizing:border-box}html,body{margin:0;padding:0;background:transparent;overflow:hidden}img{display:block}</style></head><body>${ab ? d.toHtml(ab, { asRoot: true }) : ""}</body></html>`;

// prompts for the quick actions on the selection (they run through Ask Claude)
function variationsPrompt(d, v, direction) {
  const orig = d.need(v.original).node;
  const focus = v.focus ? d.need(v.focus).node : null;
  const what = focus ? `the layer “${d.label(focus)}”` : "the whole design";
  const list = v.copies.map((c, i) => `${i + 1}. artboard ${c.id} “${c.name}”${focus ? `: redesign layer ${c.focusId}` : ""}`).join("\n");
  return `I made ${v.copies.length} copies of the artboard “${orig.name}” (${v.original}) to explore variations of ${what}.\n${list}\nIn each copy, redesign ${focus ? "that layer" : "the artboard"} so every copy is clearly different from the others and from the original (layout, type scale, colour, image treatment), while staying on-brand and keeping the same content.${direction ? ` Direction: ${direction}.` : ""} Leave the original ${v.original} untouched and change nothing outside ${focus ? "those layers" : "the copies"}. Check each copy with get_screenshot.`;
}
function imagePrompt(d, id, kind) {
  const n = d.need(id).node, pic = n.crop ? (n.children || [])[0] : n, src = pic && pic.attrs && pic.attrs.src;
  if (!src) throw new Error("Select an image.");
  const file = src.startsWith("assets/") ? path.join(d.dir, src) : src;
  const job = kind === "remove-bg" ? "remove its background (keep the subject, transparent background, PNG)" : "upscale it 2× (keep it faithful, no new details)";
  return `Take the image layer ${id} (file: ${file}) and ${job} with the Magnific tools (upload the file first if the tool needs it, and wait for the result). Then put the result in place with place_image using replaceNodeId ${pic.id}. If the Magnific tools aren't available, say so in one sentence and change nothing.`;
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const p = url.pathname;
  const q = (k) => url.searchParams.get(k);
  try {
    // ---- Ask Claude (runs Claude Code with the Studio tools only)
    if (p === "/api/ask" && req.method === "GET") return send(res, 200, { available: ask.available(), run: ask.view() });
    if (p === "/api/ask" && req.method === "POST") {
      let { prompt, selection, mode, count } = JSON.parse((await readBody(req)).toString() || "{}");
      selection = Array.isArray(selection) ? selection : [];
      let tools;
      if (mode === "variations") {
        if (!selection.length) throw new Error("Select an artboard or a layer to make variations of.");
        if (ask.view()?.running) throw new Error("Claude is still working on the last request.");
        if (!ask.available()) throw new Error("Claude Code isn't installed. Install it and sign in once by running `claude` in a terminal; Studio then uses your own login.");
        const v = await runOp("makeVariants", { nodeId: selection[0], count: count || 3 }, doc, "ask");
        prompt = variationsPrompt(doc, v, (prompt || "").trim());
        selection = v.copies.map((c) => c.focusId);
      } else if (mode === "remove-bg" || mode === "upscale") {
        if (selection.length !== 1) throw new Error("Select one image.");
        prompt = imagePrompt(doc, selection[0], mode);
        tools = "images";
      }
      if (!prompt || !String(prompt).trim()) throw new Error("Write what you want Claude to do.");
      return send(res, 200, { ok: true, run: ask.start({ prompt, selection, tools }) });
    }
    if (p === "/api/ask/cancel" && req.method === "POST") return send(res, 200, { ok: ask.cancel() });
    if (p === "/api/ask/undo" && req.method === "POST") return send(res, 200, { ok: true, undone: ask.undoRun() });
    if (p === "/api/ping") return send(res, 200, { ok: true, project: projectDir, hash: HASH, root });
    if (p === "/api/doc") return send(res, 200, publicState());
    // editor errors end up in the server log (the Mac app has no visible console)
    if (p === "/api/log" && req.method === "POST") { console.error("[editor]", (await readBody(req)).toString().slice(0, 2000)); return send(res, 200, { ok: true }); }
    // a project's (or a template's) first artboard as a small page, for the home screen thumbnails
    const pm = /^\/api\/(projects|templates)\/([\w.-]+)\/(preview|assets\/.+|fonts\/.+)$/.exec(p);
    if (pm) {
      const [, kind, id, rest] = pm;
      const dir = kind === "projects" ? (isProject(id) ? path.join(projectsRoot, id) : null) : (() => { try { return templates.dirOf(id); } catch { return null; } })();
      if (!dir || !fs.existsSync(dir)) return send(res, 404, "Not found", "text/plain");
      if (rest !== "preview") return serveFile(res, path.join(dir, decodeURIComponent(rest)));
      const d = kind === "projects" ? docs.get(id) || new Doc(dir) : templates.docOf(id);
      return send(res, 200, previewPage(d, d.boards()[0]), TYPES[".html"]);
    }
    if (p === "/api/icon") {
      try { return send(res, 200, iconSvg(q("name"), { size: Number(q("size")) || 24, color: q("color") || "currentColor", strokeWidth: Number(q("stroke")) || 2 }), "image/svg+xml"); }
      catch (e) { return send(res, 404, { error: e.message }); }
    }
    if (p === "/api/events") {
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-store", connection: "keep-alive" });
      res.write(`event: doc\ndata: ${JSON.stringify(publicState())}\n\n`);
      if (stale) res.write(`event: system\ndata: ${JSON.stringify({ stale })}\n\n`);
      clients.add(res);
      req.on("close", () => clients.delete(res));
      return;
    }
    if (p === "/api/op" && req.method === "POST") {
      const { op, args = {}, projectId: pid, source = "user" } = JSON.parse((await readBody(req)).toString() || "{}");
      if (!ops[op]) return send(res, 400, { error: `Unknown operation: ${op}` });
      const target = PROJECT_OPS.has(op) ? doc : docFor(pid);
      const result = await runOp(op, args, target, ["mcp", "ask"].includes(source) ? source : "user");
      return send(res, 200, { ok: true, result: result === undefined ? null : result });
    }
    // Google Fonts through a local cache; custom fonts of the open project
    if (p === "/fonts/css2") {
      try { return send(res, 200, await fontsCss(url.search), "text/css; charset=utf-8"); }
      catch (e) { return send(res, 502, `/* ${e.message} */`, "text/css; charset=utf-8"); }
    }
    if (p === "/fonts/file") {
      try { const b = await fontsFile(q("u") || ""); res.writeHead(200, { "content-type": "font/woff2", "cache-control": "max-age=31536000", "access-control-allow-origin": "*" }); return res.end(b); }
      catch (e) { return send(res, 502, { error: e.message }); }
    }
    if (p === "/api/font" && req.method === "POST") {
      const r = doc.addFont({ family: q("family"), weight: q("weight") || "400", style: q("style") || "normal", name: q("name"), data: await readBody(req) });
      return send(res, 200, { ok: true, font: r });
    }
    if (p === "/api/upload" && req.method === "POST") {
      const name = q("name") || "image.png";
      const rel = doc.addAsset(name, await readBody(req));
      return send(res, 200, { ok: true, src: rel });
    }
    // which sections would become image slices in the email export (no rendering: instant)
    const pd = q("project") ? docFor(q("project")) : doc;
    if (p === "/api/email-plan") {
      const node = pd.need(q("id")).node;
      const mode = ["none", "all"].includes(q("raster")) ? q("raster") : "auto";
      return send(res, 200, { sections: rasterPlan(node, mode).map((n) => ({ id: n.id, name: pd.label(n) })), total: (node.children || []).length });
    }
    if (p === "/api/export") {
      const fmt = q("format") || "html";
      const all = q("scope") === "all";
      const boards = pd.boards();
      const node = all ? (boards[0] || (() => { throw new Error("No artboards yet."); })()) : pd.need(q("id")).node;
      const imgOpts = { type: { png: "png", jpg: "jpeg", jpeg: "jpeg", webp: "webp" }[fmt], scale: Number(q("scale")) || 2, quality: Number(q("quality")) || 90 };
      const eo = { raster: ["none", "all"].includes(q("raster")) ? q("raster") : q("raster") === "0" ? "none" : "auto", images: q("images") === "files" ? "files" : "data", format: q("quality") === "png" ? "png" : "jpeg" };
      const base = fileBase(node);
      const head = (type, name, warn) => ({ "content-type": type, "content-disposition": `attachment; filename="${name}"`, "x-email-warnings": encodeURIComponent(JSON.stringify(warn || [])), "access-control-expose-headers": "x-email-warnings" });
      if (fmt === "email") {
        const ep = await buildEmail(pd, node, eo);
        // embed=0 keeps hosted paths for pasting into an ESP; the default inlines everything into one file
        let html = ep.html;
        if (q("embed") === "0" && eo.images === "data") html = (await buildEmail(pd, node, { ...eo, images: "files" })).html;
        res.writeHead(200, head(TYPES[".html"], base + "-email.html", ep.warnings));
        return res.end(html);
      }
      if (fmt === "email-zip") { const r = await buildEmailZip(pd, node, eo); res.writeHead(200, head("application/zip", base + "-email.zip", r.warnings)); return res.end(r.zip); }
      if (fmt === "eml") { const r = await buildEml(pd, node, eo); res.writeHead(200, head("message/rfc822", base + ".eml", r.warnings)); return res.end(r.eml); }
      const pname = boards.length > 1 || all ? (pd.projectId || "project").replace(/[^\w\-]+/g, "-").toLowerCase() : base;
      if (imgOpts.type) {
        if (all) { res.writeHead(200, head("application/zip", pname + "-" + fmt + ".zip")); return res.end(await buildImagesZip(pd, boards, imgOpts)); }
        const r = await buildImage(pd, node, imgOpts); res.writeHead(200, head(r.mime, base + "." + r.ext)); return res.end(r.buf);
      }
      if (fmt === "pdf") { const abs = all ? boards : [pd.artboardOf(node.id) || node]; res.writeHead(200, head("application/pdf", (all ? pname : base) + ".pdf")); return res.end(await buildPdf(pd, abs)); }
      if (fmt === "slices") { res.writeHead(200, head("application/zip", base + "-slices.zip")); return res.end(await buildSlices(pd, pd.artboardOf(node.id) || node, { type: { jpg: "jpeg", webp: "webp" }[q("type")] || "png", scale: imgOpts.scale, quality: imgOpts.quality })); }
      if (all) { res.writeHead(200, head("application/zip", pname + "-html.zip")); return res.end(await buildHtmlZip(pd, boards)); }
      const html = await pd.page(node, { embed: q("embed") !== "0" });
      res.writeHead(200, head(TYPES[".html"], base + ".html", []));
      return res.end(html);
    }
    if (p === "/api/screenshot") {
      const id = q("id");
      const src = q("state") === "before" ? beforeRun(pd) : pd;
      const ab = src.artboardOf(id);
      if (!ab) throw new Error(q("state") === "before" ? `“${id}” didn't exist before Claude's changes.` : `No node with id "${id}".`);
      const html = await src.page(ab, { embed: true, ids: true, local: true });
      const region = q("region") ? (([x, y, w, h]) => ({ x, y, width: w, height: h }))(q("region").split(",").map(Number)) : null;
      const png = await screenshot(html, { nodeId: id, width: parseInt(ab.style.width, 10) || 600, scale: Math.max(0.25, Math.min(4, Number(q("scale") || 1))), pad: Number(q("pad")) || 0, region });
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
async function shutdown() {
  for (const d of docs.values()) { clearTimeout(d._save); try { d.save(); } catch {} }
  await closeBrowser();
  process.exit(0);
}
for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, shutdown);
