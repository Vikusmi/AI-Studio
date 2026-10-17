// Templates: any artboard saved for reuse in any project. Each one is a small project folder (doc.json with one artboard,
// its images in assets/, meta.json), so previews and fonts work exactly like projects. Lives in <projects>/.templates.
import fs from "node:fs";
import path from "node:path";

const kindOf = (w, h) => {
  if (w === 600 || (w >= 560 && w <= 700 && !h)) return "Email";
  if ([1080, 1000].includes(w) || (w === 1200 && h === 630) || (w === 1200 && h === 627) || (w === 1600 && h === 900) || (w === 1280 && h === 720)) return "Social";
  if ((w === 1920 && h === 1080) || (w === 1024 && h === 768)) return "Slides";
  if ([300, 728, 160, 970, 320].includes(w)) return "Ads";
  if ([794, 816, 1050, 1728].includes(w)) return "Print";
  if ([1440, 1280, 768, 390].includes(w)) return "Web";
  return "Other";
};
export { kindOf };

export function createTemplates({ root, Doc }) {
  fs.mkdirSync(root, { recursive: true });
  const dirOf = (id) => { if (!/^[\w-]+$/.test(String(id))) throw new Error("Unknown template."); return path.join(root, id); };
  const meta = (id) => { try { return JSON.parse(fs.readFileSync(path.join(dirOf(id), "meta.json"), "utf8")); } catch { return null; } };
  const exists = (id) => { try { return fs.existsSync(path.join(dirOf(id), "doc.json")); } catch { return false; } };
  const assetsIn = (json) => [...new Set([...json.matchAll(/assets\/[\w.\-]+/g)].map((m) => m[0]))];

  function list() {
    return fs.readdirSync(root, { withFileTypes: true }).filter((d) => d.isDirectory() && exists(d.name)).map((d) => ({ id: d.name, ...meta(d.name) })).sort((a, b) => (b.created || 0) - (a.created || 0));
  }
  function save(d, { nodeId, name }) {
    const ab = d.artboardOf(nodeId);
    if (!ab) throw new Error(`No artboard for "${nodeId}".`);
    name = String(name || ab.name || "Template").trim().slice(0, 80);
    const base = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40) || "template";
    let id = base, i = 2; while (fs.existsSync(path.join(root, id))) id = `${base}-${i++}`;
    const dir = path.join(root, id);
    const node = JSON.parse(JSON.stringify(ab));
    // styles and components belong to the project the template came from
    (function plain(n) { delete n.component; delete n.instanceOf; delete n.overrides; delete n.variant; delete n.refs; (n.children || []).forEach(plain); })(node);
    node.x = 0; node.y = 0;
    const json = JSON.stringify(node);
    fs.mkdirSync(path.join(dir, "assets"), { recursive: true });
    for (const a of assetsIn(json)) { const src = path.join(d.dir, a); if (fs.existsSync(src)) fs.copyFileSync(src, path.join(dir, a)); }
    // custom fonts the artboard uses come along
    const used = new Set([...d.fontFamilies(ab)].map((f) => f.toLowerCase())), fonts = (d.state.fonts || []).filter((f) => used.has(f.family.toLowerCase()));
    for (const f of fonts) { const src = path.join(d.dir, f.file); if (fs.existsSync(src)) { fs.mkdirSync(path.dirname(path.join(dir, f.file)), { recursive: true }); fs.copyFileSync(src, path.join(dir, f.file)); } }
    fs.writeFileSync(path.join(dir, "doc.json"), JSON.stringify({ nextId: d.state.nextId, artboards: [node], fonts }));
    const w = parseInt(ab.style.width, 10) || 600, h = parseInt(ab.style.height, 10) || 0;
    fs.writeFileSync(path.join(dir, "meta.json"), JSON.stringify({ name, created: Date.now(), width: w, height: h, kind: kindOf(w, h), layers: JSON.stringify(node).split('"id"').length - 1 }));
    return { id, ...meta(id) };
  }
  // put a template's artboard into a document (its images and fonts are copied in); returns the new artboard
  function use(d, { templateId, name, x, y }) {
    if (!exists(templateId)) throw new Error(`No template "${templateId}". Use list_templates.`);
    const dir = dirOf(templateId);
    const t = JSON.parse(fs.readFileSync(path.join(dir, "doc.json"), "utf8"));
    let json = JSON.stringify(t.artboards[0]);
    for (const a of assetsIn(json)) { const src = path.join(dir, a); if (fs.existsSync(src)) json = json.split(a).join(d.addAsset(path.basename(a), fs.readFileSync(src))); }
    const before = d.snapshot();
    for (const f of t.fonts || []) {
      d.state.fonts = d.state.fonts || [];
      if (d.state.fonts.some((g) => g.family === f.family && String(g.weight) === String(f.weight) && g.style === f.style)) continue;
      const src = path.join(dir, f.file);
      if (fs.existsSync(src)) { fs.mkdirSync(path.dirname(path.join(d.dir, f.file)), { recursive: true }); fs.copyFileSync(src, path.join(d.dir, f.file)); d.state.fonts.push(f); }
    }
    const ab = d.reId(JSON.parse(json));
    ab.name = name || meta(templateId)?.name || ab.name;
    ab.x = x !== undefined ? x : d.state.artboards.length ? d.rightEdge() + 160 : 0;
    ab.y = y !== undefined ? y : 0;
    d.state.artboards.push(ab);
    d.commit(before);
    return { id: ab.id, name: ab.name };
  }
  const rename = ({ id, name }) => { const m = meta(id); if (!m) throw new Error("Unknown template."); m.name = String(name).trim().slice(0, 80) || m.name; fs.writeFileSync(path.join(dirOf(id), "meta.json"), JSON.stringify(m)); return { id, ...m }; };
  const remove = ({ id }) => { if (!exists(id)) throw new Error("Unknown template."); fs.rmSync(dirOf(id), { recursive: true, force: true }); return true; };
  const docOf = (id) => (exists(id) ? new Doc(dirOf(id)) : null);
  return { list, save, use, rename, remove, docOf, dirOf };
}
