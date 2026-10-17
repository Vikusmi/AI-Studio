// Claude's changes, grouped into runs. Every operation that comes from Claude (the MCP server in your chat, or Ask Claude in the app)
// joins the open run of its project; the first one saves a version and remembers the state before. The editor shows what Claude
// touches as it happens and, when it pauses, a Keep / Undo bar. Undo puts the project back to how it was before the run (one ⌘Z step).
import fs from "node:fs";

// operations that never change a document: they don't start a run
export const READ_ONLY = new Set([
  "info", "tree", "children", "node", "projects", "trash", "listFonts", "historyList", "listComponents", "getBrand", "selection",
  "notes", "listTemplates", "searchIcons", "critique", "brandFromUrl", "agentState", "activity", "settings", "connection", "ops", "hello",
]);
// operations about projects rather than one document's content
export const PROJECT_OPS = new Set([
  "projects", "openProject", "createProject", "renameProject", "duplicateProject", "deleteProject", "trash", "restoreProjects", "purgeProjects",
  "listTemplates", "deleteTemplate", "renameTemplate", "saveTemplate", "agentKeep", "agentUndo", "activity", "settings", "setSettings", "backupNow", "revealBackups",
  "connection", "hello", "restartServer", "rebuildApp", "ops",
]);

const LABEL = {
  createArtboard: "Creating an artboard", insert: "Adding layers", updateStyles: "Changing styles", setAttrs: "Updating a layer", setText: "Rewriting text",
  setInner: "Rewriting text", rename: "Renaming layers", remove: "Removing layers", duplicate: "Duplicating", move: "Moving layers", reorder: "Changing layer order",
  group: "Grouping layers", ungroup: "Ungrouping", splitText: "Separating text", setHidden: "Hiding or showing", setLocked: "Locking layers", setLink: "Setting a link",
  applyStyle: "Applying a style", createStyle: "Creating a style", updateStyle: "Changing a style", createComponent: "Making a component", createInstance: "Adding an instance",
  detachInstance: "Detaching an instance", setBrand: "Updating the brand kit", placeImage: "Placing an image", insertIcon: "Adding an icon", resizeArtboard: "Resizing to new formats",
  makeVariants: "Making variations", pickVariant: "Picking a variation", discardVariants: "Discarding variations", useTemplate: "Adding a template", setAutoLayout: "Changing auto layout",
  setGuides: "Setting guides", setGrid: "Setting a grid", cropImage: "Cropping an image", uncropImage: "Removing a crop", bakeCrop: "Baking a crop", setSvg: "Editing a vector",
  historyRestore: "Restoring a version", undo: "Undoing", redo: "Redoing", moveArtboard: "Moving an artboard", resolveNote: "Finishing a note", addNote: "Leaving a note",
};
export const labelOf = (op) => LABEL[op] || op.replace(/([A-Z])/g, " $1").replace(/^./, (c) => c.toUpperCase());

// node ids mentioned in an operation's arguments or its result (n12, n340 …)
function idsIn(x, out = new Set(), depth = 0) {
  if (out.size > 60 || depth > 6 || x == null) return out;
  if (typeof x === "string") { if (/^n\d+$/.test(x)) out.add(x); return out; }
  if (Array.isArray(x)) { for (const v of x) idsIn(v, out, depth + 1); return out; }
  if (typeof x === "object") for (const [k, v] of Object.entries(x)) if (k !== "html" && k !== "styles" && k !== "css") idsIn(v, out, depth + 1);
  return out;
}

const IDLE_NEW_RUN = 10 * 60 * 1000; // a pause this long starts a new run (the old one is kept)

export function createAgent({ broadcast, activityFile, nameOf, saveVersion }) {
  let log = [];
  try { log = JSON.parse(fs.readFileSync(activityFile, "utf8")); } catch {}
  let saveT;
  const persist = () => { clearTimeout(saveT); saveT = setTimeout(() => { try { fs.writeFileSync(activityFile, JSON.stringify(log.slice(0, 60))); } catch {} }, 300); };
  const view = (r) => r && { id: r.id, projectId: r.projectId, projectName: nameOf(r.projectId), open: r.open, status: r.status, ops: r.ops, labels: r.labels.slice(-6), source: r.source, startedAt: r.startedAt, lastAt: r.lastAt, mixed: r.mixed, touched: [...r.touched].slice(-40) };
  const record = (r) => {
    const e = { id: r.id, projectId: r.projectId, projectName: nameOf(r.projectId), source: r.source, startedAt: r.startedAt, lastAt: r.lastAt, ops: r.ops, labels: [...new Set(r.labels)].slice(0, 6), status: r.status };
    const i = log.findIndex((x) => x.id === r.id);
    if (i >= 0) log[i] = e; else log.unshift(e);
    persist();
  };
  const emitRun = (d) => broadcast({ kind: "run", projectId: d.projectId, run: view(d._run) });

  function close(d, status) {
    const r = d._run; if (!r || !r.open) return null;
    r.open = false; r.status = status;
    if (r.ops) record(r);
    emitRun(d);
    return view(r);
  }
  function start(d, source) {
    if (d._run && d._run.open) {
      if (Date.now() - d._run.lastAt < IDLE_NEW_RUN) return d._run;
      close(d, "kept");
    }
    const r = { id: Date.now().toString(36) + Math.random().toString(36).slice(2, 5), projectId: d.projectId, source, open: true, status: "open", ops: 0, labels: [], touched: new Set(),
      startedAt: Date.now(), lastAt: Date.now(), mixed: false, before: d.snapshot(), versionId: null };
    d._run = r;
    return r;
  }

  return {
    // before an operation runs: Claude's first change of a run saves a version (history) first
    before(d, source, op) {
      if (READ_ONLY.has(op) || PROJECT_OPS.has(op)) return null;
      const agent = source === "mcp" || source === "ask";
      const v0 = d.version;
      if (!agent) return { v0, agent };
      const r = start(d, source);
      if (!r.versionId && !r.ops && d.state.artboards.length) { try { r.versionId = saveVersion(d, { auto: true, note: "Before Claude's changes" })?.id || null; } catch {} }
      return { v0, agent };
    },
    after(d, source, op, args, result, pre) {
      if (!pre || d.version === pre.v0) return;
      const r = d._run;
      if (!pre.agent) { if (r && r.open && r.ops) { r.mixed = true; emitRun(d); } return; }
      if (!r || !r.open) return;
      r.ops++; r.lastAt = Date.now(); r.endVersion = d.version;
      const label = labelOf(op);
      if (r.labels[r.labels.length - 1] !== label) r.labels.push(label);
      const ids = [...idsIn(args), ...idsIn(result)].filter((id) => d.find(id));
      for (const id of ids) r.touched.add(id);
      broadcast({ kind: "op", projectId: d.projectId, projectName: nameOf(d.projectId), runId: r.id, label, nodeIds: ids.slice(0, 40) });
      emitRun(d);
      if (r.ops === 1 || r.ops % 10 === 0) record(r);
    },
    view: (d) => view(d && d._run),
    keep(d) { return close(d, "kept"); },
    // back to the state before the run, as one undoable step. If you edited in between, those edits go too (the editor asks first).
    undo(d, { force = false } = {}) {
      const r = d._run;
      if (!r || !r.open || !r.ops) throw new Error("Claude hasn't changed anything to undo.");
      if (r.mixed && !force) throw new Error("You've edited since Claude's changes. Undoing them would also remove your edits.");
      d.replaceAll(JSON.parse(r.before));
      return close(d, "undone");
    },
    activity: () => log.slice(0, 30),
    forget(projectId) { log = log.filter((e) => e.projectId !== projectId); persist(); },
  };
}
