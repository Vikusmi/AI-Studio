// Keeping Studio healthy: daily backups of every project, and noticing when the running server (or the Mac app's copy of it)
// is older than the code on disk.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { zip } from "./zip.js";

// a short fingerprint of the app's code: the MCP server compares its own with the running server's
export function codeHash(root) {
  const h = crypto.createHash("sha1");
  const walk = (dir) => {
    let list = [];
    try { list = fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name)); } catch { return; }
    for (const e of list) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (/\.(js|css|html|swift)$/.test(e.name)) { h.update(e.name); try { h.update(fs.readFileSync(p)); } catch {} }
    }
  };
  for (const d of ["server", "editor"]) walk(path.join(root, d));
  try { h.update(fs.readFileSync(path.join(root, "package.json"))); } catch {}
  return h.digest("hex").slice(0, 12);
}

const DAY = 24 * 60 * 60 * 1000;
export function createBackups({ projectsRoot, settingsFile, defaultDir }) {
  const read = () => { try { return JSON.parse(fs.readFileSync(settingsFile, "utf8")); } catch { return {}; } };
  const write = (s) => fs.writeFileSync(settingsFile, JSON.stringify(s, null, 2));
  const settings = () => { const s = read(); return { backupDir: s.backupDir || defaultDir, backupKeep: s.backupKeep || 14, autoBackup: s.autoBackup !== false, lastBackup: s.lastBackup || null }; };
  const list = () => { const dir = settings().backupDir; try { return fs.readdirSync(dir).filter((f) => /^Studio-backup-.*\.zip$/.test(f)).sort().reverse().map((f) => ({ file: path.join(dir, f), size: fs.statSync(path.join(dir, f)).size })); } catch { return []; } };
  function backupNow() {
    const s = settings();
    fs.mkdirSync(s.backupDir, { recursive: true });
    const files = [];
    const add = (abs, rel) => {
      let st; try { st = fs.statSync(abs); } catch { return; }
      if (st.isDirectory()) { for (const e of fs.readdirSync(abs)) if (e !== "history" && !e.startsWith(".")) add(path.join(abs, e), rel + "/" + e); }
      else files.push({ name: rel, data: fs.readFileSync(abs) });
    };
    for (const e of fs.readdirSync(projectsRoot, { withFileTypes: true })) if (e.isDirectory() && !e.name.startsWith(".")) add(path.join(projectsRoot, e.name), "projects/" + e.name);
    const tpl = path.join(projectsRoot, ".templates");
    if (fs.existsSync(tpl)) add(tpl, "templates");
    const d = new Date(), stamp = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}-${String(d.getHours()).padStart(2, "0")}${String(d.getMinutes()).padStart(2, "0")}`;
    const file = path.join(s.backupDir, `Studio-backup-${stamp}.zip`);
    fs.writeFileSync(file, zip(files));
    for (const old of list().slice(s.backupKeep)) fs.rmSync(old.file, { force: true });
    write({ ...read(), lastBackup: Date.now() });
    return { file, size: fs.statSync(file).size, projects: new Set(files.map((f) => f.name.split("/")[1])).size };
  }
  function tick() { const s = settings(); if (s.autoBackup && (!s.lastBackup || Date.now() - s.lastBackup > DAY)) { try { return backupNow(); } catch (e) { console.error("backup:", e.message); } } return null; }
  function setSettings(patch) {
    const s = read();
    if (patch.backupDir !== undefined) { const p = String(patch.backupDir).trim().replace(/^~(?=\/|$)/, process.env.HOME || "~"); if (p && !path.isAbsolute(p)) throw new Error("Use a full folder path, like /Users/you/Library/Mobile Documents/com~apple~CloudDocs/Studio backups."); s.backupDir = p || undefined; }
    if (patch.backupKeep !== undefined) s.backupKeep = Math.max(1, Math.min(90, Math.round(patch.backupKeep)));
    if (patch.autoBackup !== undefined) s.autoBackup = !!patch.autoBackup;
    write(s);
    return { ...settings(), backups: list().length };
  }
  return { settings: () => ({ ...settings(), backups: list().length, latest: list()[0] || null }), backupNow, tick, setSettings, list };
}
