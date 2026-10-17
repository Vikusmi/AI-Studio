// Version history: snapshots of doc.json kept in <project>/history/. Automatic ones are taken while you work (and pruned);
// named ones are kept until you delete them. Restoring is an ordinary edit, so ⌘Z brings the old state back.
import fs from "node:fs";
import path from "node:path";

const MAX_AUTO = 40;
const dirOf = (doc) => path.join(doc.dir, "history");
const fileOf = (doc, id) => { if (!/^[a-z0-9]+$/.test(String(id))) throw new Error("Unknown version."); return path.join(dirOf(doc), id + ".json"); };
const readMeta = (f) => { try { const j = JSON.parse(fs.readFileSync(f, "utf8")); return { id: path.basename(f, ".json"), at: j.at, name: j.name || "", auto: !!j.auto, artboards: (j.state.artboards || []).length, layers: countNodes(j.state.artboards || []) }; } catch { return null; } };
const countNodes = (list) => list.reduce((n, x) => n + 1 + countNodes(x.children || []), 0);

export function listVersions(doc) {
  const d = dirOf(doc); if (!fs.existsSync(d)) return [];
  return fs.readdirSync(d).filter((f) => f.endsWith(".json")).map((f) => readMeta(path.join(d, f))).filter(Boolean).sort((a, b) => b.at - a.at);
}

export function saveVersion(doc, { name = "", auto = false } = {}) {
  if (!doc.state.artboards.length) throw new Error("Nothing to save yet.");
  doc.save();
  fs.mkdirSync(dirOf(doc), { recursive: true });
  let id = Date.now().toString(36); while (fs.existsSync(fileOf(doc, id))) id += "a";
  fs.writeFileSync(fileOf(doc, id), JSON.stringify({ at: Date.now(), name: String(name).trim().slice(0, 80), auto, state: doc.state }));
  doc._histVersion = doc.version;
  if (auto) { const old = listVersions(doc).filter((v) => v.auto && !v.name); for (const v of old.slice(MAX_AUTO)) fs.rmSync(fileOf(doc, v.id), { force: true }); }
  return readMeta(fileOf(doc, id));
}

export function restoreVersion(doc, id) {
  const f = fileOf(doc, id); if (!fs.existsSync(f)) throw new Error("That version no longer exists.");
  const state = JSON.parse(fs.readFileSync(f, "utf8")).state;
  // never lose the present: keep it as a version before going back
  if (doc.state.artboards.length) saveVersion(doc, { name: "Before restoring", auto: true });
  doc.replaceAll(state);
  return true;
}

export function renameVersion(doc, id, name) {
  const f = fileOf(doc, id); const j = JSON.parse(fs.readFileSync(f, "utf8"));
  j.name = String(name).trim().slice(0, 80); if (j.name) j.auto = false; // naming one keeps it for good
  fs.writeFileSync(f, JSON.stringify(j)); return readMeta(f);
}

export function deleteVersion(doc, id) { fs.rmSync(fileOf(doc, id), { force: true }); return true; }

// call every minute: snapshot when something changed and the last snapshot is old enough
export function autoSnapshot(doc, everyMs = 10 * 60 * 1000) {
  if (!doc.state.artboards.length || doc._histVersion === doc.version) return null;
  if (doc._histVersion === undefined) { doc._histVersion = doc.version; if (listVersions(doc).length) return null; }
  const last = listVersions(doc)[0];
  if (last && Date.now() - last.at < everyMs) return null;
  return saveVersion(doc, { auto: true });
}
