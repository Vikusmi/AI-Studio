// More document operations: links, locking, placing images and icons, resizing an artboard to other formats, and variations
// (copies of an artboard that Claude redesigns; you keep one). Installed onto Doc; each is one undo step.
import path from "node:path";
import { iconSvg } from "./icons.js";

const px = (v) => (typeof v === "string" && /^-?[\d.]+px$/.test(v.trim()) ? parseFloat(v) : typeof v === "number" ? v : null);
const r1 = (n) => Math.round(n * 10) / 10;
// properties whose px values grow and shrink with the design
const SCALED = /^(font-size|line-height|letter-spacing|word-spacing|padding.*|margin.*|gap|row-gap|column-gap|border-radius|border(-top|-right|-bottom|-left)?(-width)?|border-(top|bottom)-(left|right)-radius|outline(-width|-offset)?|box-shadow|text-shadow|width|height|min-width|min-height|max-width|max-height|left|top|right|bottom|flex-basis|text-indent|background-size|background-position|-webkit-text-stroke(-width)?|filter|transform)$/;
// only px values change (angles, %, unitless line heights stay)
const scaleValue = (k, v, s) => (typeof v === "string" && SCALED.test(k) ? v.replace(/(-?\d*\.?\d+)px/g, (m, n) => r1(parseFloat(n) * s) + "px") : v);
// layer placement that belongs to the link wrapper when an image is wrapped in <a>
const PLACE = /^(position|left|top|right|bottom|z-index|transform|margin.*|align-self|flex|flex-grow|flex-shrink|flex-basis|order|grid-.*)$/;

export function installExtras(Doc) {
  const P = Doc.prototype;

  // deep copy with fresh ids; map: old id -> new id
  P.reId = function (node, map = new Map()) {
    const c = JSON.parse(JSON.stringify(node));
    const walk = (n) => { const nid = this.id(); map.set(n.id, nid); n.id = nid; (n.children || []).forEach(walk); };
    walk(c);
    return c;
  };
  // copies don't carry component masters, and become plain layers (instances would snap back to their master)
  const plain = (n) => { delete n.component; delete n.instanceOf; delete n.overrides; delete n.variant; (n.children || []).forEach(plain); };
  P.rightEdge = function () { return this.state.artboards.reduce((m, a) => Math.max(m, (a.x || 0) + (px(a.style.width) || 600)), 0); };

  // ---------- layers outside artboards ----------
  // Layers can sit on the canvas itself, outside every artboard: kept in the project, never exported. They live at the top level
  // next to the artboards (free: true, x / y on the canvas) and can be moved back into any artboard or frame.
  P.boards = function () { return this.state.artboards.filter((a) => !a.free); };
  P.relocate = function ({ moves = [], updates = [] }) {
    const before = this.snapshot();
    if (updates.length) this.applyStyles(updates);
    const px = (v) => Math.round(v * 10) / 10 + "px";
    const PLACE_KEYS = ["left", "top", "right", "bottom", "margin", "margin-top", "margin-right", "margin-bottom", "margin-left", "align-self", "flex", "flex-grow", "flex-shrink", "flex-basis", "order"];
    for (const m of moves) {
      const r = this.need(m.nodeId), n = r.node;
      if (n.artboard) throw new Error("Artboards already sit on the canvas: move them with update_styles left/top.");
      const into = m.to && m.to !== "canvas" ? this.need(m.to).node : null;
      if (into && (into === n || this.find(m.to, n.children || []))) throw new Error("Cannot move a layer into itself.");
      if (into && (into.tag === "img" || into.tag === "svg" || into.tag === "#text")) throw new Error("Move layers into an artboard or a frame.");
      this.detachInstanceOf(m.nodeId);
      if (into) this.detachInstanceOf(m.to, { includeRoot: true });
      r.list.splice(r.index, 1);
      n.style = n.style || {};
      for (const k of PLACE_KEYS) delete n.style[k];
      if (m.width != null) n.style.width = px(m.width);
      if (m.height != null) n.style.height = px(m.height);
      if (!into) {
        n.free = true; n.x = Math.round(Number(m.x) || 0); n.y = Math.round(Number(m.y) || 0);
        Object.assign(n.style, { position: "absolute", left: "0px", top: "0px" });
        this.state.artboards.push(n);
      } else {
        delete n.free; delete n.x; delete n.y;
        Object.assign(n.style, { position: "absolute", left: px(Number(m.left) || 0), top: px(Number(m.top) || 0) });
        if (!into.style.position || into.style.position === "static") into.style.position = "relative";
        into.children = into.children || [];
        into.children.push(n);
      }
    }
    this.commit(before);
    return moves.map((m) => m.nodeId);
  };

  // ---------- links ----------
  P.setLink = function ({ nodeId, href }) {
    const before = this.snapshot();
    const r = this.need(nodeId);
    let n = r.node;
    if (n.artboard) throw new Error("Put the link on a layer inside the artboard, not on the artboard itself.");
    this.detachInstanceOf(nodeId, { includeRoot: true });
    const clear = href === null || href === undefined || String(href).trim() === "";
    href = clear ? null : String(href).trim();
    const media = n.tag === "img" || n.tag === "svg";
    // an image's link is the <a> we wrapped around it
    if (media && r.parent && r.parent.linkWrap) n = r.parent;
    if (n.tag === "a") {
      n.attrs = n.attrs || {};
      if (!clear) n.attrs.href = href;
      else if (n.linkWrap) {
        const w = this.need(n.id), img = n.children[0];
        for (const [k, v] of Object.entries(n.style || {})) if (PLACE.test(k)) img.style[k] = v;
        w.list.splice(w.index, 1, img);
      } else { delete n.attrs.href; delete n.attrs.target; if (n.linkFrom) { n.tag = n.linkFrom; delete n.linkFrom; } }
    } else if (!clear) {
      if (media) {
        const st = {};
        for (const [k, v] of Object.entries(n.style || {})) if (PLACE.test(k)) { st[k] = v; delete n.style[k]; }
        const w = { id: this.id(), tag: "a", name: "Link", linkWrap: true, attrs: { href }, style: { display: "block", ...st }, children: [n] };
        r.list.splice(r.index, 1, w);
      } else { n.linkFrom = n.tag; n.tag = "a"; n.attrs = { ...(n.attrs || {}), href }; if (!n.style["text-decoration"]) n.style["text-decoration"] = "none"; if (!n.style.color && n.linkFrom !== "span") n.style.color = "inherit"; }
    }
    this.commit(before);
    return { nodeId, href };
  };
  // the link a layer sits in (its own, or the closest link around it)
  P.linkOf = function (id) {
    const chain = this.chainTo(id) || [];
    for (let i = chain.length - 1; i >= 0; i--) if (chain[i].tag === "a" && chain[i].attrs && chain[i].attrs.href) return { id: chain[i].id, href: chain[i].attrs.href, own: i === chain.length - 1 || (chain[i].linkWrap && i === chain.length - 2) };
    return null;
  };

  P.setLocked = function ({ nodeIds, locked = true }) {
    const before = this.snapshot();
    for (const id of nodeIds) { const n = this.need(id).node; if (locked) n.locked = true; else delete n.locked; }
    this.commit(before);
    return nodeIds;
  };

  // ---------- images and icons ----------
  P.fetchAsset = async function (src, name) {
    if (/^https?:\/\//i.test(src)) {
      const r = await fetch(src, { headers: { "user-agent": "Mozilla/5.0 Studio" } });
      if (!r.ok) throw new Error(`Couldn't download the image (${r.status}).`);
      const buf = Buffer.from(await r.arrayBuffer());
      const type = (r.headers.get("content-type") || "").split(";")[0];
      const ext = { "image/png": ".png", "image/jpeg": ".jpg", "image/webp": ".webp", "image/gif": ".gif", "image/svg+xml": ".svg", "image/avif": ".avif" }[type] || path.extname(new URL(src).pathname).toLowerCase() || ".png";
      const stem = (name || path.basename(new URL(src).pathname, path.extname(new URL(src).pathname)) || "image").replace(/[^\w-]+/g, "-").slice(0, 40) || "image";
      return this.addAsset(stem + ext, buf);
    }
    const m = /^data:image\/([\w+]+);base64,(.*)$/s.exec(src);
    if (m) return this.addAsset((name || "image").replace(/[^\w-]+/g, "-") + "." + (m[1] === "jpeg" ? "jpg" : m[1].replace("+xml", "")), Buffer.from(m[2], "base64"));
    return this.localiseUrl(src);
  };
  P.placeImage = async function ({ src, parentId, replaceNodeId, style, name, alt, index }) {
    if (!src) throw new Error("Give the image: a local file path, an https URL or a data: URL.");
    const rel = await this.fetchAsset(src, name);
    const before = this.snapshot();
    if (replaceNodeId) {
      const n = this.need(replaceNodeId).node;
      const pic = n.crop ? (n.children || [])[0] : n;
      if (pic && pic.tag === "img") { pic.attrs = { ...(pic.attrs || {}), src: rel, ...(alt !== undefined ? { alt } : {}) }; this.override(pic.id, { attrs: { src: rel } }); }
      else { n.style["background-image"] = `url(${rel})`; if (!n.style["background-size"]) n.style["background-size"] = "cover"; if (!n.style["background-position"]) n.style["background-position"] = "center"; }
      this.commit(before);
      return { id: replaceNodeId, src: rel };
    }
    if (!parentId) throw new Error("Give parentId (where to put the image) or replaceNodeId (an image to swap).");
    const parent = this.need(parentId).node;
    const st = { width: "100%", height: "auto", display: "block", ...(style || {}) };
    const node = { id: this.id(), tag: "img", style: Object.fromEntries(Object.entries(st).map(([k, v]) => [k.replace(/[A-Z]/g, (c) => "-" + c.toLowerCase()), String(v)])), attrs: { src: rel, alt: alt || "" } };
    if (name) node.name = name;
    this.detachInstanceOf(parentId, { includeRoot: true });
    parent.children = parent.children || [];
    parent.children.splice(index === undefined ? parent.children.length : index, 0, node);
    this.commit(before);
    return { id: node.id, src: rel };
  };
  P.insertIcon = function ({ name, parentId, size = 24, color = "#161616", strokeWidth = 2, style = {}, index }) {
    const svg = iconSvg(name, { size, color: "currentColor", strokeWidth });
    const extra = Object.entries(style).map(([k, v]) => `${k.replace(/[A-Z]/g, (c) => "-" + c.toLowerCase())}:${v}`).join(";");
    const html = svg.replace(/^<svg/, `<svg layer-name="${name} icon" style="width:${size}px;height:${size}px;color:${color};display:block;flex:none${extra ? ";" + extra : ""}"`);
    return this.insert({ parentId, html, index });
  };

  // ---------- resize to other formats ----------
  // Copies of an artboard at new sizes. Free-placed layers keep their place relative to the frame, everything else scales evenly
  // with the smaller of the two ratios, so a post becomes a story or a banner as a starting point that Claude (or you) then tidy.
  P.resizeArtboard = function ({ nodeId, sizes }) {
    const ab = this.artboardOf(nodeId);
    if (!ab) throw new Error(`No artboard for "${nodeId}".`);
    if (!Array.isArray(sizes) || !sizes.length) throw new Error("Give one or more sizes: [{ width, height, name }].");
    const W1 = px(ab.style.width) || 600, H1 = px(ab.style.height);
    const before = this.snapshot();
    let x = this.rightEdge() + 160;
    const out = [];
    for (const sz of sizes) {
      const W2 = Math.round(Number(sz.width)), H2 = sz.height ? Math.round(Number(sz.height)) : null;
      if (!(W2 > 0)) throw new Error("Every size needs a width.");
      const sx = W2 / W1, sy = H1 && H2 ? H2 / H1 : sx, s = Math.min(sx, sy);
      const c = this.reId(ab); plain(c);
      const scaleAll = (n, k, top) => {
        if (n.tag === "#text") return;
        const w = px(n.style.width);
        for (const [key, v] of Object.entries(n.style || {})) n.style[key] = scaleValue(key, v, k);
        if (top && w !== null && Math.abs(w - W1) < 2) n.style.width = W2 + "px"; // full-width blocks stay full width
        (n.children || []).forEach((ch) => scaleAll(ch, k, false));
      };
      for (const [key, v] of Object.entries(c.style)) if (key !== "width" && key !== "height") c.style[key] = scaleValue(key, v, s);
      for (const ch of c.children || []) {
        if (ch.tag === "#text") continue;
        if (ch.style && ch.style.position === "absolute") {
          const w = px(ch.style.width) || 0, h = px(ch.style.height) || 0, L = px(ch.style.left), T = px(ch.style.top), R = px(ch.style.right), B = px(ch.style.bottom);
          scaleAll(ch, s, false);
          if (L !== null) ch.style.left = r1((L + w / 2) * sx - (w * s) / 2) + "px"; else if (R !== null) ch.style.right = r1((R + w / 2) * sx - (w * s) / 2) + "px";
          if (T !== null) ch.style.top = r1((T + h / 2) * sy - (h * s) / 2) + "px"; else if (B !== null) ch.style.bottom = r1((B + h / 2) * sy - (h * s) / 2) + "px";
        } else scaleAll(ch, s, true);
      }
      c.style.width = W2 + "px";
      c.style.height = H2 ? H2 + "px" : "fit-content";
      c.name = sz.name || `${ab.name || "Artboard"} · ${W2}×${H2 || "auto"}`;
      c.x = x; c.y = ab.y || 0; x += W2 + 120;
      this.state.artboards.push(c);
      out.push({ id: c.id, name: c.name, width: W2, height: H2 });
    }
    this.commit(before);
    return out;
  };

  // ---------- variations ----------
  // Copies of the artboard (or of the artboard holding a layer) placed in a row, tagged as one set. Claude redesigns each copy;
  // pickVariant keeps one in the original's place and removes the rest.
  P.makeVariants = function ({ nodeId, count = 3 }) {
    const r = this.need(nodeId);
    const ab = r.node.artboard ? r.node : this.artboardOf(nodeId);
    count = Math.max(1, Math.min(8, Math.round(count)));
    const before = this.snapshot();
    const set = "v" + Date.now().toString(36);
    if (ab.variant && ab.variant.set) for (const a of this.state.artboards) if (a.variant && a.variant.set === ab.variant.set && a !== ab) delete a.variant;
    ab.variant = { set, n: 0 };
    const W = px(ab.style.width) || 600;
    let x = this.rightEdge() + 160;
    const copies = [];
    for (let i = 0; i < count; i++) {
      const map = new Map();
      const c = this.reId(ab, map); plain(c);
      c.variant = { set, n: i + 1, of: ab.id };
      c.name = `${ab.name || "Artboard"} · V${i + 1}`;
      c.x = x; c.y = ab.y || 0; x += W + 120;
      this.state.artboards.push(c);
      copies.push({ id: c.id, name: c.name, focusId: r.node.artboard ? c.id : map.get(nodeId) });
    }
    this.commit(before);
    return { set, original: ab.id, focus: r.node.artboard ? null : nodeId, copies };
  };
  P.variantSet = function (set) { return this.state.artboards.filter((a) => a.variant && a.variant.set === set); };
  P.pickVariant = function ({ nodeId }) {
    const chosen = this.artboardOf(nodeId);
    if (!chosen || !chosen.variant) throw new Error("That isn't part of a set of variations.");
    const members = this.variantSet(chosen.variant.set);
    const original = members.find((a) => a.variant.n === 0);
    const before = this.snapshot();
    const list = this.state.artboards;
    if (original && chosen !== original) {
      chosen.x = original.x; chosen.y = original.y; chosen.name = original.name;
      list.splice(list.indexOf(chosen), 1);
      list.splice(list.indexOf(original), 0, chosen);
    }
    for (const a of members) if (a !== chosen) list.splice(list.indexOf(a), 1);
    delete chosen.variant;
    this.selection = this.selection.filter((s) => this.find(s));
    this.commit(before);
    return { kept: chosen.id, removed: members.length - 1 };
  };
  P.discardVariants = function ({ set }) {
    const members = this.variantSet(set);
    if (!members.length) throw new Error("No such set of variations.");
    const original = members.find((a) => a.variant.n === 0) || members[0];
    return this.pickVariant({ nodeId: original.id });
  };
}
