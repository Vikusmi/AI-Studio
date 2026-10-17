// Everything that turns an artboard into a file: email (html / zip / eml), and later images and PDFs.
import fs from "node:fs";
import path from "node:path";
import { emailPage } from "./email.js";
import { renderSliced, renderPdf, screenshot } from "./shot.js";
import { zip } from "./zip.js";

const safe = (s, fallback = "design") => (String(s || fallback).replace(/[^\w\-]+/g, "-").replace(/^-+|-+$/g, "").toLowerCase() || fallback);
export const fileBase = (node) => safe(node.name);

// Rendering sections is the slow part of an email export, so renders are remembered until the document changes.
const cache = new Map();
function cached(doc, node, key, make) {
  const k = `${doc.dir}|${node.id}|${doc.version}|${key}`;
  if (cache.has(k)) return cache.get(k);
  const p = make();
  cache.set(k, p);
  p.catch(() => cache.delete(k));
  for (const old of [...cache.keys()].slice(0, Math.max(0, cache.size - 24))) cache.delete(old);
  return p;
}

// opts: { images: "data" | "files", raster: "auto" | "all" | "none", format: "jpeg"|"png" }
export async function buildEmail(doc, artboard, opts = {}) {
  const images = opts.images || "data", raster = opts.raster || "auto", format = opts.format || "jpeg";
  return cached(doc, artboard, `email|${images}|${raster}|${format}`, async () => {
    const render = raster !== "none" ? async (n, { width, bg }) => renderSliced(await doc.page(n, { embed: true, ids: true, local: true }), { nodeId: n.id, width, bg, format, scale: 2 }) : null;
    const ep = await emailPage(doc, artboard, { render, images, raster });
    // real <img> elements that point at project files (not slices) become inline data in "data" mode, hosted paths are left alone
    if (images === "data") ep.html = await doc.embedImages(ep.html);
    return ep;
  });
}

// email + its images as one zip: upload images/ to a host and replace the paths, or send as-is to an ESP that takes zips
export async function buildEmailZip(doc, artboard, opts = {}) {
  const ep = await buildEmail(doc, artboard, { ...opts, images: "files" });
  const files = [{ name: "index.html", data: ep.html }, ...ep.files];
  // images that come from the project (assets/…) travel with the zip too
  const seen = new Set();
  for (const m of ep.html.matchAll(/src="(assets\/[^"]+)"/g)) {
    if (seen.has(m[1])) continue; seen.add(m[1]);
    const f = path.join(doc.dir, decodeURIComponent(m[1]));
    if (fs.existsSync(f)) files.push({ name: m[1], data: fs.readFileSync(f) });
  }
  return { zip: zip(files), warnings: ep.warnings };
}

// A .eml opens as a draft in Outlook (X-Unsent) and can be sent from there as a test. Images are attached inline (cid:).
export async function buildEml(doc, artboard, opts = {}) {
  const ep = await buildEmail(doc, artboard, { ...opts, images: "files" });
  const parts = [];
  let html = ep.html;
  const cid = (name, data, mime) => { const id = `${safe(name.replace(/\W+/g, "-"))}-${parts.length}@studio.local`; parts.push({ id, name: path.basename(name), data, mime }); return "cid:" + id; };
  const mimeOf = (f) => ({ ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp", ".gif": "image/gif", ".svg": "image/svg+xml" })[path.extname(f).toLowerCase()] || "application/octet-stream";
  for (const f of ep.files) html = html.split(`src="${f.name}"`).join(`src="${cid(f.name, f.data, mimeOf(f.name))}"`);
  for (const m of new Set([...html.matchAll(/src="(assets\/[^"]+)"/g)].map((x) => x[1]))) {
    const f = path.join(doc.dir, decodeURIComponent(m));
    if (fs.existsSync(f)) html = html.split(`src="${m}"`).join(`src="${cid(m, fs.readFileSync(f), mimeOf(m))}"`);
  }
  const b64 = (buf) => buf.toString("base64").replace(/(.{76})/g, "$1\r\n");
  const boundary = "----=_studio_" + Math.random().toString(36).slice(2);
  const subject = (artboard.name || "Email").replace(/[\r\n]+/g, " ");
  const enc = (t) => (/^[\x20-\x7e]*$/.test(t) ? t : `=?UTF-8?B?${Buffer.from(t).toString("base64")}?=`);
  const lines = [
    "X-Unsent: 1", `Subject: ${enc(subject)}`, "To: ", "MIME-Version: 1.0", `Content-Type: multipart/related; boundary="${boundary}"; type="text/html"`, "",
    `--${boundary}`, "Content-Type: text/html; charset=utf-8", "Content-Transfer-Encoding: base64", "", b64(Buffer.from(html, "utf8")),
  ];
  for (const p of parts) lines.push(`--${boundary}`, `Content-Type: ${p.mime}; name="${p.name}"`, "Content-Transfer-Encoding: base64", `Content-ID: <${p.id}>`, `Content-Disposition: inline; filename="${p.name}"`, "", b64(p.data));
  lines.push(`--${boundary}--`, "");
  return { eml: Buffer.from(lines.join("\r\n"), "utf8"), warnings: ep.warnings };
}

// ---------- images, PDF, slices ----------
const EXT = { png: "png", jpeg: "jpg", webp: "webp" };
const widthOf = (n) => parseInt(n.style && n.style.width, 10) || 600;
const uniq = (names) => { const seen = new Map(); return names.map((n) => { const c = seen.get(n) || 0; seen.set(n, c + 1); return c ? `${n}-${c + 1}` : n; }); };

// opts: { type: "png"|"jpeg"|"webp", scale: 1..4, quality: 1..100 }
export async function buildImage(doc, node, opts = {}) {
  const type = ["png", "jpeg", "webp"].includes(opts.type) ? opts.type : "png";
  const scale = Math.max(1, Math.min(4, Number(opts.scale) || 2)), quality = Number(opts.quality) || 90;
  const ab = doc.artboardOf(node.id) || node;
  const buf = await screenshot(await doc.page(ab, { embed: true, ids: true, local: true }), { nodeId: node.id, width: widthOf(ab), scale, type, quality });
  return { buf, ext: EXT[type], mime: type === "png" ? "image/png" : "image/" + type };
}

// every artboard as a file inside one zip
export async function buildImagesZip(doc, artboards, opts = {}) {
  const names = uniq(artboards.map(fileBase)), files = [];
  for (let i = 0; i < artboards.length; i++) { const r = await buildImage(doc, artboards[i], opts); files.push({ name: `${names[i]}.${r.ext}`, data: r.buf }); }
  return zip(files);
}

// one PDF; each artboard is one page of exactly its own size
export async function buildPdf(doc, artboards) {
  let body = "";
  for (const ab of artboards) body += `<section data-pg="${ab.id}" style="display:block;width:${widthOf(ab)}px;overflow:hidden">${await doc.embedImages(doc.toHtml(ab, { asRoot: true, ids: true }))}</section>`;
  const html = `<!doctype html><html><head><meta charset="utf-8"><title>${(artboards[0]?.name || "Design").replace(/</g, "")}</title>${doc.fontLink({ children: artboards }, { local: true })}<style>${doc.fontFaceCss()}*{box-sizing:border-box}html,body{margin:0;padding:0}img{display:block}section[data-pg]{margin:0}</style></head><body>${body}</body></html>`;
  return renderPdf(await doc.embedImages(html));
}

// each top-level section of an artboard as its own image
export async function buildSlices(doc, artboard, opts = {}) {
  const type = ["png", "jpeg", "webp"].includes(opts.type) ? opts.type : "png";
  const kids = (artboard.children || []).filter((c) => c.tag !== undefined || c.id);
  if (!kids.length) throw new Error("This artboard has no layers to slice.");
  const bufs = await screenshot(await doc.page(artboard, { embed: true, ids: true, local: true }), { nodeIds: kids.map((k) => k.id), width: widthOf(artboard), scale: Math.max(1, Math.min(4, Number(opts.scale) || 2)), type, quality: Number(opts.quality) || 90 });
  const names = uniq(kids.map((k, i) => `${String(i + 1).padStart(2, "0")}-${safe(doc.label ? doc.label(k) : k.name, "section")}`));
  return zip(kids.map((k, i) => ({ name: `${names[i]}.${EXT[type]}`, data: bufs[i] })));
}

export async function buildHtmlZip(doc, artboards) {
  const names = uniq(artboards.map(fileBase));
  const files = [];
  for (let i = 0; i < artboards.length; i++) files.push({ name: `${names[i]}.html`, data: await doc.page(artboards[i], { embed: true }) });
  return zip(files);
}
