// Fonts: (1) custom font files uploaded into a project (state.fonts, stored in assets/), (2) a small cache for Google Fonts so a
// design that was opened once keeps its fonts offline. Nothing here needs an account or key.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";

const FORMATS = { ".woff2": "woff2", ".woff": "woff", ".ttf": "truetype", ".otf": "opentype" };
const MAGIC = (b) => { const m = b.toString("latin1", 0, 4); return m === "wOF2" || m === "wOFF" || m === "OTTO" || m === "true" || b.readUInt32BE(0) === 0x00010000; };
const cleanFamily = (s) => String(s || "").replace(/[^\p{L}\p{N} \-_.]/gu, "").trim().slice(0, 60);

export function installFonts(Doc) {
  Doc.prototype.listFonts = function () { return this.state.fonts || []; };
  Doc.prototype.addFont = function ({ family, weight = "400", style = "normal", name, data }) {
    family = cleanFamily(family); if (!family) throw new Error("Give the font a name.");
    const ext = path.extname(String(name || "")).toLowerCase();
    if (!FORMATS[ext]) throw new Error("Use a .woff2, .woff, .ttf or .otf font file.");
    if (!Buffer.isBuffer(data) || data.length < 64 || !MAGIC(data)) throw new Error("That doesn't look like a font file.");
    if (data.length > 12 * 1024 * 1024) throw new Error("That font file is over 12 MB.");
    weight = /^[1-9]00$/.test(String(weight)) ? String(weight) : "400"; style = style === "italic" ? "italic" : "normal";
    const before = this.snapshot();
    const file = this.addAsset(`font-${family.replace(/ /g, "_")}-${weight}${style === "italic" ? "i" : ""}${ext}`, data);
    const fonts = (this.state.fonts = (this.state.fonts || []).filter((f) => !(f.family.toLowerCase() === family.toLowerCase() && f.weight === weight && f.style === style)));
    fonts.push({ family, weight, style, file });
    this.commit(before);
    return { family, weight, style, file };
  };
  Doc.prototype.removeFont = function ({ family, weight, style }) {
    const before = this.snapshot(), all = this.state.fonts || [];
    const keep = all.filter((f) => !(f.family === family && (weight === undefined || f.weight === weight) && (style === undefined || f.style === style)));
    if (keep.length === all.length) throw new Error(`No custom font "${family}".`);
    this.state.fonts = keep; if (!keep.length) delete this.state.fonts;
    this.commit(before); // the file stays in assets/ (undo can bring the font back)
    return true;
  };
  Doc.prototype.customFamilies = function () { return new Set((this.state.fonts || []).map((f) => f.family.toLowerCase())); };
  // @font-face rules for the custom fonts; abs → /assets/… (the editor), otherwise assets/… (pages that are exported)
  Doc.prototype.fontFaceCss = function ({ abs = false } = {}) {
    return (this.state.fonts || []).map((f) => `@font-face{font-family:"${f.family}";src:url(${abs ? "/" : ""}${f.file}) format("${FORMATS[path.extname(f.file).toLowerCase()] || "truetype"}");font-weight:${f.weight};font-style:${f.style};font-display:swap}`).join("");
  };
}

// ---------- Google Fonts through a local cache ----------
const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15";
export const fontsCacheDir = () => process.env.STUDIO_FONTS_CACHE || path.join(os.homedir(), "Library", "Application Support", "Studio", "fonts-cache");
const sha = (s) => crypto.createHash("sha1").update(s).digest("hex").slice(0, 24);

// /fonts/css2?family=…  →  the Google stylesheet, with its font files redirected to /fonts/file?u=…
// Each family is fetched (and cached) on its own: Google rejects a whole request if one name isn't one of its fonts (Arial, a brand
// typeface…), which would otherwise take every other font of the design down with it. Unknown families are remembered as empty.
async function familyCss(param, display) {
  const dir = fontsCacheDir(); fs.mkdirSync(dir, { recursive: true });
  const f = path.join(dir, "css-" + sha(param + display) + ".css");
  if (fs.existsSync(f)) return fs.readFileSync(f, "utf8");
  const r = await fetch(`https://fonts.googleapis.com/css2?${param}&display=${display}`, { headers: { "user-agent": UA }, signal: AbortSignal.timeout(8000) });
  if (r.status === 400 || r.status === 404) { fs.writeFileSync(f, ""); return ""; }
  if (!r.ok) throw new Error("Google Fonts answered " + r.status);
  const css = (await r.text()).replace(/https:\/\/fonts\.gstatic\.com\/[^)'"\s]+/g, (u) => "/fonts/file?u=" + encodeURIComponent(u));
  fs.writeFileSync(f, css);
  return css;
}
export async function fontsCss(search) {
  const sp = new URLSearchParams(search), display = (sp.get("display") || "swap").replace(/[^a-z]/g, "") || "swap";
  const fams = sp.getAll("family").slice(0, 24);
  const parts = await Promise.allSettled(fams.map((fam) => familyCss("family=" + encodeURIComponent(fam).replace(/%20/g, "+").replace(/%3A/g, ":").replace(/%40/g, "@").replace(/%3B/g, ";").replace(/%2C/g, ",").replace(/%2E/g, "."), display)));
  const got = parts.filter((p) => p.status === "fulfilled");
  if (fams.length && !got.length) throw parts[0].reason; // offline and nothing cached: let the editor fall back to Google directly
  return got.map((p) => p.value).join("\n");
}
export async function fontsFile(u) {
  if (!/^https:\/\/fonts\.gstatic\.com\//.test(u)) throw new Error("Not a Google font file.");
  const dir = fontsCacheDir(); fs.mkdirSync(dir, { recursive: true });
  const f = path.join(dir, "file-" + sha(u) + (path.extname(new URL(u).pathname) || ".woff2"));
  if (fs.existsSync(f)) return fs.readFileSync(f);
  const r = await fetch(u, { headers: { "user-agent": UA }, signal: AbortSignal.timeout(15000) });
  if (!r.ok) throw new Error("Google Fonts answered " + r.status);
  const buf = Buffer.from(await r.arrayBuffer()); fs.writeFileSync(f, buf);
  return buf;
}
