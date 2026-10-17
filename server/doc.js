// The document: a tree of nodes, the operations that change it, history and saving.
// Both the editor (browser) and Claude (MCP) change the document through the same operations.
import fs from "node:fs";
import path from "node:path";
import { parse, HTMLElement, TextNode } from "node-html-parser";
import { install as installDesignSystem, TEXT_PROPS } from "./design-system.js";
import { install as installCanvasFeatures } from "./canvas-features.js";
import { installFonts } from "./fonts.js";

const VOID = new Set(["img", "br", "hr", "input"]);
const INLINE = new Set(["span", "b", "i", "strong", "em", "a", "u", "small", "sup", "sub"]);
const DROP = new Set(["script", "style", "link", "meta", "title", "head"]);

// Google Fonts rejects the whole request if a family lacks an axis value, so single-weight display fonts need their own spec
const SINGLE = new Set(["Anton", "Bebas Neue", "Bowlby One", "Caprasimo", "Lobster", "Pacifico", "Titan One", "Chewy", "Dela Gothic One", "Rubik Mono One", "Shrikhand", "Paytone One", "Bagel Fat One", "Gloock", "Instrument Serif", "DM Serif Display", "Abril Fatface", "Righteous", "Permanent Marker"]);
const SPECS = { Newsreader: ":ital,wght@0,300..600;1,300..600", "DM Mono": ":wght@300;400;500", "Hanken Grotesk": ":ital,wght@0,300..800;1,300..800", Fraunces: ":ital,wght@0,300..900;1,300..900", Caveat: ":wght@400..700", "Inter Tight": ":ital,wght@0,300..800;1,300..800", Nunito: ":ital,wght@0,300..900;1,300..900" };
export const fontSpec = (f) => (SINGLE.has(f) ? (f === "Instrument Serif" || f === "DM Serif Display" ? ":ital@0;1" : "") : SPECS[f] || ":wght@300;400;500;600;700;800");
export const kebab = (k) => k.replace(/[A-Z]/g, (m) => "-" + m.toLowerCase()).replace(/^-ms-/, "ms-");

export class Doc {
  constructor(dir) {
    this.dir = dir;
    this.assetsDir = path.join(dir, "assets");
    this.file = path.join(dir, "doc.json");
    fs.mkdirSync(this.assetsDir, { recursive: true });
    this.state = { nextId: 1, artboards: [] };
    this.undoStack = [];
    this.redoStack = [];
    this.selection = [];
    this.version = 0;
    this.listeners = new Set();
    if (fs.existsSync(this.file)) {
      try {
        this.state = JSON.parse(fs.readFileSync(this.file, "utf8"));
      } catch (e) {
        console.error("Could not read doc.json, starting empty:", e.message);
      }
    }
  }

  // ---------- plumbing ----------
  id() {
    return "n" + this.state.nextId++;
  }
  snapshot() {
    return JSON.stringify(this.state);
  }
  commit(before) {
    this.syncComponents();      // instances follow their main component (no-op when there are none)
    this.undoStack.push(before);
    if (this.undoStack.length > 100) this.undoStack.shift();
    this.redoStack = [];
    this.changed();
  }
  changed() {
    this.version++;
    clearTimeout(this._save);
    this._save = setTimeout(() => this.save(), 400);
    for (const fn of this.listeners) fn();
  }
  save() {
    fs.writeFileSync(this.file, JSON.stringify(this.state));
  }
  undo() {
    if (!this.undoStack.length) return false;
    this.redoStack.push(this.snapshot());
    this.state = JSON.parse(this.undoStack.pop());
    this.changed();
    return true;
  }
  redo() {
    if (!this.redoStack.length) return false;
    this.undoStack.push(this.snapshot());
    this.state = JSON.parse(this.redoStack.pop());
    this.changed();
    return true;
  }

  // ---------- lookup ----------
  find(id, list = this.state.artboards, parent = null) {
    for (let i = 0; i < list.length; i++) {
      const n = list[i];
      if (n.id === id) return { node: n, parent, list, index: i };
      if (n.children) {
        const r = this.find(id, n.children, n);
        if (r) return r;
      }
    }
    return null;
  }
  need(id) {
    const r = this.find(id);
    if (!r) throw new Error(`No node with id "${id}". Use get_basic_info or get_children to see current ids.`);
    return r;
  }
  artboardOf(id) {
    for (const ab of this.state.artboards) if (ab.id === id || this.find(id, ab.children || [])) return ab;
    return null;
  }

  // ---------- HTML in ----------
  styleObj(str = "") {
    const out = {};
    for (const part of str.split(/;(?![^(]*\))/)) {
      const i = part.indexOf(":");
      if (i < 0) continue;
      const k = part.slice(0, i).trim();
      const v = part.slice(i + 1).trim();
      if (k && v) out[kebab(k)] = v;
    }
    return out;
  }
  localiseUrl(src) {
    if (!src) return src;
    let p = null;
    if (src.startsWith("paper-asset://")) p = decodeURIComponent(src.slice("paper-asset://".length));
    else if (src.startsWith("file://")) p = decodeURIComponent(src.slice(7));
    else if (src.startsWith("/") && !src.startsWith("//") && fs.existsSync(src)) p = src;
    if (!p) return src;
    if (!fs.existsSync(p)) throw new Error(`Image file not found: ${p}`);
    return this.addAssetFile(p);
  }
  addAssetFile(p) {
    const base = path.basename(p);
    return this.addAsset(base, fs.readFileSync(p));
  }
  addAsset(name, buf) {
    const safe = name.replace(/[^\w.\-]+/g, "_");
    const ext = path.extname(safe);
    const stem = path.basename(safe, ext);
    let final = safe;
    let i = 1;
    while (fs.existsSync(path.join(this.assetsDir, final))) {
      if (fs.readFileSync(path.join(this.assetsDir, final)).equals(buf)) return "assets/" + final;
      final = `${stem}-${i++}${ext}`;
    }
    fs.writeFileSync(path.join(this.assetsDir, final), buf);
    return "assets/" + final;
  }
  localiseStyle(style) {
    for (const [k, v] of Object.entries(style)) {
      if (typeof v === "string" && v.includes("url(")) {
        style[k] = v.replace(/url\((['"]?)([^)'"]+)\1\)/g, (m, q, u) => `url(${this.localiseUrl(u)})`);
      }
    }
    return style;
  }
  fromElement(el) {
    const tag = el.tagName.toLowerCase();
    if (DROP.has(tag)) return null;
    const attrs = { ...el.attributes };
    const name = attrs["layer-name"];
    delete attrs["layer-name"];
    delete attrs["data-id"];
    delete attrs.contenteditable;
    const style = this.localiseStyle(this.styleObj(attrs.style));
    delete attrs.style;
    if (attrs.src) attrs.src = this.localiseUrl(attrs.src);
    const node = { id: this.id(), tag, style };
    if (name) node.name = name;
    if (Object.keys(attrs).length) node.attrs = attrs;
    if (tag === "svg") {
      // keep SVG markup as-is
      const raw = el.outerHTML.replace(/\sstyle="[^"]*"/, "").replace(/\slayer-name="[^"]*"/, "");
      node.raw = raw;
      node.style = style;
      return node;
    }
    if (!VOID.has(tag)) node.children = this.fromNodes(el.childNodes);
    return node;
  }
  fromNodes(list) {
    const out = [];
    list = list.filter((c) => c instanceof HTMLElement || c instanceof TextNode);
    list.forEach((c, i) => {
      if (c instanceof HTMLElement) {
        const n = this.fromElement(c);
        if (n) out.push(n);
      } else if (c instanceof TextNode) {
        // collapse whitespace; keep one space between inline siblings ("Hello <b>world</b>")
        let t = c.text.replace(/\s+/g, " ");
        if (i === 0) t = t.trimStart();
        if (i === list.length - 1) t = t.trimEnd();
        const inline = (x) => x instanceof HTMLElement && INLINE.has(x.tagName.toLowerCase());
        const keepGap = t === " " && inline(list[i - 1]) && inline(list[i + 1]);
        if (t.trim() || keepGap) out.push({ id: this.id(), tag: "#text", text: decode(t) });
      }
    });
    return out;
  }
  parseHtml(html) {
    const root = parse(`<div id="__root">${html}</div>`, { blockTextElements: { script: false, style: false } });
    return this.fromNodes(root.querySelector("#__root").childNodes);
  }

  // ---------- operations ----------
  createArtboard({ name = "Artboard", width = 600, height, x, y = 0, style = {} } = {}) {
    const before = this.snapshot();
    const abs = this.state.artboards;
    if (x === undefined) x = abs.length ? Math.max(...abs.map((a) => a.x + parseInt(a.style.width || 600, 10))) + 120 : 0;
    const ab = {
      id: this.id(),
      tag: "div",
      artboard: true,
      name,
      x,
      y,
      style: {
        width: `${width}px`,
        height: height ? `${height}px` : "fit-content",
        display: "flex",
        "flex-direction": "column",
        "background-color": "#ffffff",
        ...this.localiseStyle(normStyle(style)),
      },
      children: [],
    };
    abs.push(ab);
    this.commit(before);
    return { id: ab.id, name: ab.name };
  }
  insert({ parentId, html, mode = "insert-children", index }) {
    const before = this.snapshot();
    const nodes = this.parseHtml(html);
    if (!nodes.length) throw new Error("The HTML produced no elements.");
    const { node: parent } = this.need(parentId);
    this.detachInstanceOf(parentId, { includeRoot: true });
    parent.children = parent.children || [];
    if (mode === "replace") {
      const { list, index: i } = this.need(parentId);
      list.splice(i, 1, ...nodes);
    } else {
      const at = index === undefined ? parent.children.length : index;
      parent.children.splice(at, 0, ...nodes);
    }
    this.commit(before);
    return nodes.map((n) => this.brief(n));
  }
  updateStyles(updates) {
    const before = this.snapshot();
    const done = this.applyStyles(updates);
    this.commit(before);
    return done;
  }
  // the style change itself, without history: composite operations (group, ungroup …) call it inside their own commit
  applyStyles(updates) {
    const done = [];
    for (const u of updates) {
      const styles = normStyle(u.styles || {});
      for (const id of u.nodeIds) {
        const { node } = this.need(id);
        const ctx = node.artboard ? null : this.instanceCtx(id);
        for (const [k, v] of Object.entries(styles)) {
          if (node.artboard && (k === "left" || k === "top")) {
            node[k === "left" ? "x" : "y"] = parseFloat(v) || 0;
            continue;
          }
          if (v === null || v === "") delete node.style[k];
          else node.style[k] = typeof v === "number" ? String(v) : v;
          this.unlinkEdited(node, k);
          if (node.crop && (k === "width" || k === "height")) this.layoutCrop(node);
          // inside an instance: remember the change as an override of that layer (an instance's own placement is not an override)
          if (ctx && !(ctx.isRoot && ["position", "left", "top", "right", "bottom", "width", "height", "margin", "margin-top", "margin-right", "margin-bottom", "margin-left", "transform", "z-index", "align-self", "flex", "flex-grow", "flex-shrink", "flex-basis", "order"].includes(k))) this.override(id, { style: { [k]: v === "" || v === undefined ? null : typeof v === "number" ? String(v) : v } });
        }
        this.localiseStyle(node.style);
        done.push(id);
      }
    }
    return done;
  }
  setAttrs(id, attrs) {
    const before = this.snapshot();
    const { node } = this.need(id);
    node.attrs = node.attrs || {};
    const ov = {};
    for (const [k, v] of Object.entries(attrs)) {
      if (v === null) delete node.attrs[k];
      else node.attrs[k] = k === "src" ? this.localiseUrl(v) : v;
      ov[k] = v === null ? null : node.attrs[k];
    }
    this.override(id, { attrs: ov });
    this.commit(before);
  }
  setText(id, text) {
    const before = this.snapshot();
    const { node } = this.need(id);
    if (node.tag === "#text") node.text = text;
    else node.children = [{ id: this.id(), tag: "#text", text }];
    if (node.tag === "#text") { const ch = this.chainTo(id); if (ch && ch.length > 1) this.override(ch[ch.length - 2].id, { text }); }
    else this.override(id, { text });
    this.commit(before);
  }
  // replace a node's children with parsed HTML (used when editing text that has inline formatting)
  setInner(id, html) {
    const before = this.snapshot();
    const { node } = this.need(id);
    node.children = this.parseHtml(html);
    this.override(id, { html });
    this.commit(before);
  }
  rename(items) {
    const before = this.snapshot();
    for (const { nodeId, name } of items) {
      const n = this.need(nodeId).node;
      n.name = name;
      if (n.component && this.state.components && this.state.components[n.component]) this.state.components[n.component].name = name;
      if (!n.instanceOf) this.override(nodeId, { name });
    }
    this.commit(before);
  }
  remove(ids) {
    const before = this.snapshot();
    for (const id of ids) {
      const r = this.find(id);
      if (r) { this.detachInstanceOf(id); r.list.splice(r.index, 1); }
    }
    this.selection = this.selection.filter((s) => this.find(s));
    this.commit(before);
  }
  clone(node, offsetX = 0) {
    const c = JSON.parse(JSON.stringify(node));
    const walk = (n) => {
      n.id = this.id();
      (n.children || []).forEach(walk);
    };
    (function strip(n) { delete n.component; (n.children || []).forEach(strip); })(c);
    walk(c);
    if (c.artboard) {
      c.x += offsetX;
      c.name = (c.name || "Artboard") + " copy";
    }
    return c;
  }
  duplicate(ids) {
    const before = this.snapshot();
    const out = [];
    for (const id of ids) {
      const r = this.need(id);
      const w = r.node.artboard ? parseInt(r.node.style.width || 600, 10) + 120 : 0;
      const c = this.clone(r.node, w);
      r.list.splice(r.index + 1, 0, c);
      out.push(this.brief(c));
    }
    this.commit(before);
    return out;
  }
  move({ nodeId, parentId, index }) {
    const before = this.snapshot();
    const r = this.need(nodeId);
    if (!parentId) throw new Error("move_nodes needs a parentId (an artboard or frame). To reposition an artboard use update_styles left/top.");
    const p = this.need(parentId).node;
    if (p === r.node || this.find(parentId, r.node.children || [])) throw new Error("Cannot move a node into itself.");
    this.detachInstanceOf(nodeId); this.detachInstanceOf(parentId, { includeRoot: true });
    if (r.node.artboard) throw new Error("Artboards can't be nested. Use update_styles left/top to move one on the canvas.");
    r.list.splice(r.index, 1);
    p.children = p.children || [];
    const at = index === undefined ? p.children.length : Math.min(index, p.children.length);
    p.children.splice(at, 0, r.node);
    this.commit(before);
  }
  // Change the stacking order of layers that share a parent, as one undo step. Later siblings paint on top.
  // to: front | back | forward | backward. Text pieces between elements keep their slots, so a step is always one visible layer.
  reorder({ nodeIds, to }) {
    if (!["front", "back", "forward", "backward"].includes(to)) throw new Error("to must be front, back, forward or backward.");
    const rs = nodeIds.map((id) => this.need(id));
    if (rs.some((r) => r.node.artboard)) throw new Error("Artboards have no stacking order.");
    const list = rs[0].list;
    if (rs.some((r) => r.list !== list)) throw new Error("Pick layers that are in the same frame.");
    const slots = list.map((n, i) => i).filter((i) => list[i].tag !== "#text"); // positions of real layers
    const els = slots.map((i) => list[i]);
    const sel = new Set(rs.map((r) => r.node));
    let order = els.slice();
    if (to === "front") order = [...els.filter((n) => !sel.has(n)), ...els.filter((n) => sel.has(n))];
    else if (to === "back") order = [...els.filter((n) => sel.has(n)), ...els.filter((n) => !sel.has(n))];
    else if (to === "forward") { for (let i = order.length - 2; i >= 0; i--) if (sel.has(order[i]) && !sel.has(order[i + 1])) [order[i], order[i + 1]] = [order[i + 1], order[i]]; }
    else { for (let i = 1; i < order.length; i++) if (sel.has(order[i]) && !sel.has(order[i - 1])) [order[i], order[i - 1]] = [order[i - 1], order[i]]; }
    if (order.every((n, i) => n === els[i])) return false; // already at the end
    const before = this.snapshot();
    for (const r of rs) this.detachInstanceOf(r.node.id);
    slots.forEach((slot, k) => { list[slot] = order[k]; });
    this.commit(before);
    return true;
  }
  moveArtboard(id, x, y) {
    const before = this.snapshot();
    const ab = this.need(id).node;
    ab.x = x;
    ab.y = y;
    this.commit(before);
  }
  replaceAll(state) {
    const before = this.snapshot();
    this.state = state;
    this.commit(before);
  }
  // Group nodes into one frame. The editor passes measured geometry so the group is free-form:
  // the frame sits at `frame` ({left, top, width, height} in the parent) and every member is pinned inside it at its old spot.
  // Without geometry (Claude's tool) the members are stacked in a column, as before.
  group(ids, { frame, members = [], pins = [] } = {}) {
    const before = this.snapshot();
    ids = [...ids].sort((a, b) => this.need(a).index - this.need(b).index); // keep document order
    for (const id of ids) this.detachInstanceOf(id);
    const first = this.need(ids[0]);
    for (const id of ids) {
      const r = this.need(id);
      if (r.list !== first.list) throw new Error("Select nodes with the same parent to group them.");
      if (r.node.artboard) throw new Error("Artboards can't be grouped.");
    }
    if (pins.length) this.applyStyles(pins);
    const px = (v) => Math.round(v * 10) / 10 + "px";
    const f = { id: this.id(), tag: "div", name: "Group", group: true, style: frame ? { position: "absolute", left: px(frame.left), top: px(frame.top), width: px(frame.width), height: px(frame.height) } : { display: "flex", "flex-direction": "column" }, children: [] };
    const nodes = ids.map((id) => this.need(id).node);
    const idx = Math.min(...ids.map((id) => this.need(id).index));
    for (const id of ids) {
      const r = this.need(id);
      r.list.splice(r.index, 1);
    }
    if (frame) {
      for (const n of nodes) {
        const m = members.find((x) => x.id === n.id);
        if (!m) continue;
        delete n.style.right; delete n.style.bottom;
        Object.assign(n.style, { position: "absolute", left: px(m.left), top: px(m.top) });
        if (m.width != null) n.style.width = px(m.width);
        if (m.height != null) n.style.height = px(m.height);
      }
    }
    f.children = nodes;
    first.list.splice(idx, 0, f);
    this.commit(before);
    return f.id;
  }
  // Dissolve frames: their children move into the frame's parent. `members` carry each child's measured spot in that parent.
  ungroup(ids, { members = [], pins = [] } = {}) {
    const before = this.snapshot();
    if (pins.length) this.applyStyles(pins.filter((u) => !u.nodeIds.some((x) => ids.includes(x))));
    const freed = [];
    const px = (v) => Math.round(v * 10) / 10 + "px";
    for (const id of ids) {
      this.detachInstanceOf(id, { includeRoot: true });
      const r = this.need(id);
      const n = r.node;
      if (n.artboard) throw new Error("Artboards can't be ungrouped.");
      const kids = (n.children || []).filter((c) => c.tag !== "#text" || (c.text || "").trim());
      if (!kids.length) continue;
      const ox = n.style.position === "absolute" ? parseFloat(n.style.left) || 0 : 0, oy = n.style.position === "absolute" ? parseFloat(n.style.top) || 0 : 0;
      for (const c of kids) {
        if (c.tag === "#text") continue;
        const m = members.find((x) => x.id === c.id);
        if (m) {
          delete c.style.right; delete c.style.bottom;
          Object.assign(c.style, { position: "absolute", left: px(m.left), top: px(m.top) });
          if (m.width != null) c.style.width = px(m.width);
          if (m.height != null) c.style.height = px(m.height);
        } else if (c.style && c.style.position === "absolute") {
          if (c.style.left) c.style.left = px((parseFloat(c.style.left) || 0) + ox);
          if (c.style.top) c.style.top = px((parseFloat(c.style.top) || 0) + oy);
        }
      }
      r.list.splice(r.index, 1, ...kids);
      freed.push(...kids.filter((c) => c.tag !== "#text").map((c) => c.id));
    }
    this.selection = this.selection.filter((x) => this.find(x));
    this.commit(before);
    return freed;
  }
  // A button is one element holding both its box (background, border, padding) and its text. Split it into a box with a separate text layer inside.
  splitText(id, { width, height } = {}) {
    const before = this.snapshot();
    const { node } = this.need(id);
    if (node.artboard || node.tag === "img" || node.tag === "svg" || node.tag === "#text") throw new Error("Only text elements can be split.");
    this.detachInstanceOf(id, { includeRoot: true });
    const kids = node.children || [];
    if (!kids.length) throw new Error("This element has no text.");
    const TEXT = /^(font|color$|letter-spacing|line-height|text-(align|transform|decoration|shadow|indent)|white-space|word-|-webkit-text)/;
    const box = {}, txt = {};
    for (const [k, v] of Object.entries(node.style || {})) (TEXT.test(k) ? txt : box)[k] = v;
    for (const k of Object.keys(box)) if (/^padding/.test(k)) delete box[k];
    if (width != null && !/px|%/.test(box.width || "")) box.width = Math.round(width) + "px";
    if (height != null && !/px|%/.test(box.height || "")) box.height = Math.round(height) + "px";
    const align = txt["text-align"] || "center";
    box.display = "flex";
    box["align-items"] = "center";
    box["justify-content"] = align === "left" || align === "start" ? "flex-start" : align === "right" || align === "end" ? "flex-end" : "center";
    delete txt["text-align"];
    const child = { id: this.id(), tag: "span", name: "Text", style: { ...txt, "white-space": txt["white-space"] || "nowrap" }, children: kids };
    if (["span", "p", "h1", "h2", "h3", "h4", "h5", "h6", "label"].includes(node.tag)) node.tag = "div";
    node.style = box;
    node.children = [child];
    this.commit(before);
    return child.id;
  }

  // ---------- reading ----------
  brief(n) {
    return { id: n.id, name: this.label(n), tag: n.tag, childCount: (n.children || []).length };
  }
  label(n) {
    if (n.name) return n.name;
    if (n.tag === "#text") return n.text.slice(0, 40);
    const kids = n.children || [];
    if (kids.length === 1 && kids[0].tag === "#text") return kids[0].text.slice(0, 40);
    return { img: "Image", svg: "SVG", div: "Frame", span: "Text", p: "Text", a: "Link" }[n.tag] || n.tag;
  }
  summary(node, depth = 0, max = 4) {
    const pad = "  ".repeat(depth);
    let line = `${pad}${node.id} ${this.label(node)} <${node.tag}>`;
    if (node.artboard) line += ` (${node.style.width} × ${node.style.height}) at ${node.x},${node.y}`;
    const kids = (node.children || []).filter((c) => !(c.tag === "#text" && (node.children || []).length === 1));
    let s = line + "\n";
    if (depth < max) for (const c of kids) s += this.summary(c, depth + 1, max);
    else if (kids.length) s += `${pad}  … ${kids.length} more\n`;
    return s;
  }
  publicState() {
    return { version: this.version, state: this.state, selection: this.selection, canUndo: this.undoStack.length > 0, canRedo: this.redoStack.length > 0 };
  }

  // ---------- HTML out ----------
  toHtml(node, { ids = false, asRoot = false } = {}) {
    if (node.tag === "#text") return esc(node.text);
    if (node.hidden) return "";
    const style = { ...node.style };
    if (asRoot) {
      style["margin"] = "0 auto";
    }
    const styleStr = Object.entries(style)
      .map(([k, v]) => `${k}:${v}`)
      .join(";");
    const attrs = { ...(node.attrs || {}) };
    let a = Object.entries(attrs)
      .map(([k, v]) => ` ${k}="${escAttr(v)}"`)
      .join("");
    if (styleStr) a += ` style="${escAttr(styleStr)}"`;
    if (ids) a += ` data-node-id="${node.id}"`;
    if (node.tag === "svg") {
      let raw = node.raw;
      const extra = (styleStr ? ` style="${escAttr(styleStr)}"` : "") + (ids ? ` data-node-id="${node.id}"` : "");
      return raw.replace(/^<svg/, "<svg" + extra);
    }
    if (VOID.has(node.tag)) return `<${node.tag}${a}>`;
    const inner = (node.children || []).map((c) => this.toHtml(c, { ids })).join("");
    return `<${node.tag}${a}>${inner}</${node.tag}>`;
  }
  fontFamilies(node, set = new Set()) {
    const f = node.style && node.style["font-family"];
    if (f) {
      const first = f.split(",")[0].trim().replace(/^['"]|['"]$/g, "");
      if (first && !/^(sans-serif|serif|monospace|cursive|system-ui|inherit)$/i.test(first)) set.add(first);
    }
    (node.children || []).forEach((c) => this.fontFamilies(c, set));
    return set;
  }
  // local: point at this machine's cached copy of Google Fonts (for rendering); otherwise at Google directly (for files you hand out)
  fontLink(node, { local = false } = {}) {
    const custom = this.customFamilies();
    const fams = [...this.fontFamilies(node)].filter((f) => !custom.has(f.toLowerCase()));
    if (!fams.length) return "";
    const q = fams.map((f) => "family=" + encodeURIComponent(f).replace(/%20/g, "+") + fontSpec(f)).join("&");
    if (local && Doc.fontProxy) return `<link href="${Doc.fontProxy}/fonts/css2?${q}&display=swap" rel="stylesheet">`;
    return `<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin><link href="https://fonts.googleapis.com/css2?${q}&display=swap" rel="stylesheet">`;
  }
  async page(node, { embed = true, ids = false, local = false } = {}) {
    let body = this.toHtml(node, { asRoot: true, ids });
    const faces = this.fontFaceCss();
    if (faces) body = `<style>${faces}</style>` + body;
    if (embed) body = await this.embedImages(body);
    const title = (node.name || "Design").replace(/</g, "");
    return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title>
${this.fontLink(node, { local })}
<style>*{box-sizing:border-box}html,body{margin:0;padding:0}body{background:#e9e9e6}img{display:block}</style>
</head><body>${body}</body></html>`;
  }
  async embedImages(html) {
    const urls = new Set();
    for (const m of html.matchAll(/(?:src="|url\()(&quot;|["'])?([^"')&]+?)(?:&quot;|["'])?(?:"|\))/g)) urls.add(m[2]);
    const map = new Map();
    for (const u of urls) {
      if (u.startsWith("data:") || u.startsWith("#")) continue;
      try {
        let buf, mime;
        if (/^https?:\/\//.test(u)) {
          const r = await fetch(u);
          if (!r.ok) continue;
          buf = Buffer.from(await r.arrayBuffer());
          mime = r.headers.get("content-type")?.split(";")[0];
        } else if (u.startsWith("assets/")) {
          buf = fs.readFileSync(path.join(this.dir, u));
        } else continue;
        mime = mime || MIME[path.extname(u).toLowerCase()] || "application/octet-stream";
        map.set(u, `data:${mime};base64,${buf.toString("base64")}`);
      } catch {
        /* leave the original URL in place */
      }
    }
    let out = html;
    for (const [u, d] of map) out = out.split(u).join(d);
    return out;
  }
}

const MIME = { ".woff2": "font/woff2", ".woff": "font/woff", ".ttf": "font/ttf", ".otf": "font/otf", ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp", ".gif": "image/gif", ".svg": "image/svg+xml", ".avif": "image/avif" };
const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const escAttr = (s) => String(s).replace(/&/g, "&amp;").replace(/"/g, "&quot;");
const decode = (s) => s.replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&nbsp;/g, " ");
export function normStyle(obj) {
  const out = {};
  for (const [k, v] of Object.entries(obj)) out[kebab(k)] = v;
  return out;
}

installDesignSystem(Doc);
installCanvasFeatures(Doc);
installFonts(Doc);
