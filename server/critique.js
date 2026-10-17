// Design critique: renders an artboard in Chrome, measures it, and lists concrete problems with the layer each one is on.
// Claude runs it after building something and fixes what it finds; the editor shows the same list.
import fs from "node:fs";
import path from "node:path";

// runs inside the page
function measure({ abId, minText }) {
  const root = document.querySelector(`[data-node-id="${abId}"]`);
  if (!root) return [];
  const R = root.getBoundingClientRect(), out = [];
  const add = (severity, kind, el, message) => out.push({ severity, kind, nodeId: el && el.dataset ? el.dataset.nodeId || null : null, message });
  const all = [...root.querySelectorAll("[data-node-id]")];
  const visible = (el) => { const cs = getComputedStyle(el); if (cs.display === "none" || cs.visibility === "hidden" || parseFloat(cs.opacity) === 0) return false; const r = el.getBoundingClientRect(); return r.width > 0.5 && r.height > 0.5; };
  const ownText = (el) => [...el.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim());
  const texts = all.filter((el) => ownText(el) && visible(el));
  const rgb = (s) => { const m = /rgba?\(([^)]+)\)/.exec(s || ""); if (!m) return null; const p = m[1].split(/[\s,/]+/).filter(Boolean).map(parseFloat); return { r: p[0], g: p[1], b: p[2], a: p.length > 3 ? p[3] : 1 }; };
  const lin = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };
  const L = (c) => 0.2126 * lin(c.r) + 0.7152 * lin(c.g) + 0.0722 * lin(c.b);
  const ratio = (a, b) => { const x = L(a), y = L(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); };
  // the colour behind a text: what is painted under its centre (null when it's a photo, a gradient or an icon)
  function bgBehind(el) {
    const r = el.getBoundingClientRect(), stack = document.elementsFromPoint(r.left + r.width / 2, r.top + r.height / 2);
    const i = stack.indexOf(el);
    for (const e of [el, ...stack.slice(i + 1)]) {
      if (e.tagName === "IMG" || e.tagName === "svg" || e.tagName === "VIDEO" || e.tagName === "CANVAS") return null;
      const cs = getComputedStyle(e);
      if (cs.backgroundImage && cs.backgroundImage !== "none") return null;
      const c = rgb(cs.backgroundColor);
      if (c && c.a >= 0.5) return c;
      if (e === root) break;
    }
    return { r: 255, g: 255, b: 255, a: 1 };
  }
  const contains = (a, b) => a !== b && a.contains(b);
  for (const el of texts) {
    const cs = getComputedStyle(el), r = el.getBoundingClientRect(), size = parseFloat(cs.fontSize) || 16, bold = parseInt(cs.fontWeight, 10) >= 700;
    const words = el.textContent.trim().replace(/\s+/g, " ").slice(0, 40);
    // contrast (WCAG AA: 4.5 for body text, 3 for large text)
    const bg = bgBehind(el), fg = rgb(cs.color);
    if (bg && fg) {
      const f = fg.a < 1 ? { r: fg.r * fg.a + bg.r * (1 - fg.a), g: fg.g * fg.a + bg.g * (1 - fg.a), b: fg.b * fg.a + bg.b * (1 - fg.a) } : fg;
      const k = ratio(f, bg), large = size >= 24 || (size >= 18.6 && bold), need = large ? 3 : 4.5;
      if (k < need) add(k < need - 1.5 ? "high" : "medium", "contrast", el, `Low contrast ${k.toFixed(1)}:1 for “${words}” (needs ${need}:1).`);
    }
    if (size < minText) add(size < minText * 0.75 ? "medium" : "low", "small-text", el, `Text is ${Math.round(size)}px: small for this format (aim for ${minText}px or more): “${words}”.`);
    if (cs.display !== "inline") {
      if (el.scrollWidth > el.clientWidth + 2) add("high", "overflow", el, `Text is wider than its box by ${el.scrollWidth - el.clientWidth}px: “${words}”.`);
      if (/px$/.test(el.style.height || "") && el.scrollHeight > el.clientHeight + 2) add("high", "overflow", el, `Text is taller than its box by ${el.scrollHeight - el.clientHeight}px: “${words}”.`);
    }
    if (r.left < R.left - 2 || r.right > R.right + 2 || r.top < R.top - 2 || r.bottom > R.bottom + 2) add("high", "cut-off", el, `Text runs past the artboard edge and is cut off: “${words}”.`);
    if (/lorem ipsum|placeholder|headline here|your (text|headline|copy) here|\btodo\b|\bxxx\b/i.test(el.textContent)) add("medium", "placeholder", el, `Placeholder text left in: “${words}”.`);
  }
  // text on text
  const T = texts.slice(0, 250);
  for (let i = 0; i < T.length; i++) for (let j = i + 1; j < T.length; j++) {
    const a = T[i], b = T[j];
    if (contains(a, b) || contains(b, a)) continue;
    const ra = a.getBoundingClientRect(), rb = b.getBoundingClientRect();
    const w = Math.min(ra.right, rb.right) - Math.max(ra.left, rb.left), h = Math.min(ra.bottom, rb.bottom) - Math.max(ra.top, rb.top);
    if (w > 0 && h > 0 && w * h > 0.25 * Math.min(ra.width * ra.height, rb.width * rb.height)) add("medium", "overlap", a, `Text overlaps other text (“${b.textContent.trim().slice(0, 30)}”).`);
  }
  // images
  for (const el of all.filter((e) => e.tagName === "IMG" && visible(e))) {
    const r = el.getBoundingClientRect();
    if (el.complete && !el.naturalWidth) { add("high", "broken-image", el, "This image didn't load."); continue; }
    const cs = getComputedStyle(el), fit = cs.objectFit;
    // object-fit: cover crops, so the image's pixels must cover the larger ratio
    const need = fit === "cover" ? Math.max(r.width / el.naturalWidth, r.height / el.naturalHeight) : Math.max(r.width / el.naturalWidth, fit === "contain" ? 0 : r.height / el.naturalHeight);
    if (need > 1.02) add("medium", "blurry-image", el, `Image is shown ${need.toFixed(1)}× larger than its pixels (${el.naturalWidth}×${el.naturalHeight}): it will look blurry.`);
    else if (need > 0.51) add("low", "soft-image", el, `Image is sharp on normal screens but soft on Retina: it has ${el.naturalWidth}px for ${Math.round(r.width)}px (2× would be ${Math.round(r.width * 2)}px).`);
  }
  // spacing that is almost, but not quite, even
  for (const el of all.filter((e) => /flex/.test(getComputedStyle(e).display) && visible(e))) {
    const cs = getComputedStyle(el), row = /row/.test(cs.flexDirection);
    const kids = [...el.children].filter((c) => c.dataset.nodeId && visible(c) && !["absolute", "fixed"].includes(getComputedStyle(c).position));
    if (kids.length < 3) continue;
    const gaps = [];
    for (let i = 1; i < kids.length; i++) { const a = kids[i - 1].getBoundingClientRect(), b = kids[i].getBoundingClientRect(); gaps.push(Math.round(row ? b.left - a.right : b.top - a.bottom)); }
    if (gaps.some((g) => g < 0)) continue;
    const mn = Math.min(...gaps), mx = Math.max(...gaps);
    if (mx - mn >= 1 && mx - mn <= 6) add("low", "spacing", el, `Uneven spacing between these layers: ${[...new Set(gaps)].join(", ")}px. Make them equal.`);
  }
  return out;
}

const ORDER = { high: 0, medium: 1, low: 2 };
const hex = (v) => { const m = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(String(v || "").trim()); if (!m) return null; const h = m[1].length === 3 ? m[1].split("").map((c) => c + c).join("") : m[1]; return "#" + h.toLowerCase(); };
const rgbOf = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
const dist = (a, b) => { const x = rgbOf(a), y = rgbOf(b); return Math.hypot(x[0] - y[0], x[1] - y[1], x[2] - y[2]); };
const grey = (h) => { const [r, g, b] = rgbOf(h); return Math.max(r, g, b) - Math.min(r, g, b) < 24; };

export async function critique(d, ab, { inspect }) {
  const W = parseInt(ab.style.width, 10) || 600;
  const minText = Math.min(28, Math.max(12, Math.round(W * 0.02)));
  const html = await d.page(ab, { embed: true, ids: true, local: true });
  const issues = await inspect(html, { width: W, fn: measure, arg: { abId: ab.id, minText } });
  // checks that only need the document
  const b = d.getBrand(), fonts = [b.brand.fonts.heading, b.brand.fonts.body, b.brand.fonts.mono, ...(d.state.fonts || []).map((f) => f.family)].filter(Boolean).map((f) => f.toLowerCase());
  const palette = b.colors.map((c) => hex(c.value)).filter(Boolean);
  const offFont = new Map(), offColor = new Map();
  const walk = (n) => {
    if (n.hidden) return;
    const st = n.style || {};
    if (fonts.length && st["font-family"]) { const f = st["font-family"].split(",")[0].trim().replace(/^['"]|['"]$/g, ""); if (f && !fonts.includes(f.toLowerCase()) && !/^(inherit|sans-serif|serif|monospace|system-ui)$/i.test(f)) offFont.set(f, [...(offFont.get(f) || []), n.id]); }
    if (palette.length) for (const k of ["color", "background-color"]) { const h = hex(st[k]); if (h && !grey(h) && palette.every((p) => dist(p, h) > 40)) offColor.set(h, [...(offColor.get(h) || []), n.id]); }
    if (n.tag === "img") {
      const src = n.attrs && n.attrs.src;
      if (!n.attrs || !n.attrs.alt) issues.push({ severity: "low", kind: "alt-text", nodeId: n.id, message: "Image has no alt text (screen readers and email clients with images off show nothing)." });
      if (src && src.startsWith("assets/")) { try { const kb = fs.statSync(path.join(d.dir, src)).size / 1024; if (kb > 1024) issues.push({ severity: "medium", kind: "heavy-image", nodeId: n.id, message: `Heavy image: ${(kb / 1024).toFixed(1)} MB. Compress it or export at a smaller size.` }); } catch {} }
    }
    if (n.tag === "a" && (!n.attrs || !n.attrs.href || n.attrs.href === "#")) issues.push({ severity: "medium", kind: "empty-link", nodeId: n.id, message: "Link has no address (href)." });
    (n.children || []).forEach(walk);
  };
  walk(ab);
  for (const [f, ids] of offFont) issues.push({ severity: "low", kind: "off-brand-font", nodeId: ids[0], message: `Font “${f}” isn't in the brand kit (used on ${ids.length} layer${ids.length > 1 ? "s" : ""}).` });
  for (const [c, ids] of offColor) issues.push({ severity: "low", kind: "off-brand-colour", nodeId: ids[0], message: `Colour ${c} isn't close to any brand colour (used on ${ids.length} layer${ids.length > 1 ? "s" : ""}).` });
  const named = issues.map((i) => ({ ...i, name: i.nodeId && d.find(i.nodeId) ? d.label(d.find(i.nodeId).node) : null }));
  named.sort((a, b) => ORDER[a.severity] - ORDER[b.severity]);
  const summary = { high: 0, medium: 0, low: 0 };
  for (const i of named) summary[i.severity]++;
  return { artboard: { id: ab.id, name: ab.name }, summary, issues: named.slice(0, 80) };
}
