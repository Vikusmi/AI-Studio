// A built-in icon library (Lucide, ~1500 line icons, offline). Search by name or keyword, get the SVG at any size and colour.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const base = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "node_modules", "lucide-static");
let names = null, tags = {};
function load() {
  if (names) return;
  try { names = fs.readdirSync(path.join(base, "icons")).filter((f) => f.endsWith(".svg")).map((f) => f.slice(0, -4)).sort(); } catch { names = []; }
  try { tags = JSON.parse(fs.readFileSync(path.join(base, "tags.json"), "utf8")); } catch { tags = {}; }
}

export function searchIcons(query = "", limit = 40) {
  load();
  const q = String(query).toLowerCase().trim().replace(/\s+/g, " ");
  if (!q) return names.slice(0, limit).map((name) => ({ name, tags: (tags[name] || []).slice(0, 5) }));
  const words = q.split(" ");
  const scored = [];
  for (const name of names) {
    const t = tags[name] || [], hay = name.replace(/-/g, " ");
    let s = 0;
    if (name === q.replace(/ /g, "-")) s += 100;
    else if (hay.startsWith(q)) s += 50;
    else if (hay.includes(q)) s += 30;
    for (const w of words) {
      if (hay.split(" ").includes(w)) s += 12;
      else if (hay.includes(w)) s += 6;
      if (t.includes(w) || t.includes(q)) s += 10;
      else if (t.some((x) => x.includes(w))) s += 3;
    }
    if (s) scored.push([s - name.length / 100, name]);
  }
  return scored.sort((a, b) => b[0] - a[0]).slice(0, limit).map(([, name]) => ({ name, tags: (tags[name] || []).slice(0, 5) }));
}

export function iconSvg(name, { size = 24, color = "currentColor", strokeWidth = 2 } = {}) {
  load();
  if (!/^[a-z0-9-]+$/.test(String(name)) || !names.includes(name)) {
    const close = searchIcons(String(name).replace(/[-_]/g, " "), 5).map((x) => x.name);
    throw new Error(`No icon "${name}".${close.length ? " Close matches: " + close.join(", ") + "." : ""} Use search_icons.`);
  }
  let svg = fs.readFileSync(path.join(base, "icons", name + ".svg"), "utf8").replace(/<!--[\s\S]*?-->/g, "").trim();
  svg = svg.replace(/\sclass="[^"]*"/, "")
    .replace(/\swidth="[^"]*"/, ` width="${size}"`).replace(/\sheight="[^"]*"/, ` height="${size}"`)
    .replace(/\sstroke="currentColor"/, ` stroke="${color}"`).replace(/\sstroke-width="[^"]*"/, ` stroke-width="${strokeWidth}"`)
    .replace(/\s*\n\s*/g, " ").replace(/>\s+</g, "><");
  return svg;
}
