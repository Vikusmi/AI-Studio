// Design system features for the document: components (a master and instances that follow it, with per-instance overrides),
// linked colour / text styles, and the project's brand kit. Installed onto Doc, so every operation is one undo step
// and works the same for the editor and for Claude.

const KEEP = new Set(["position", "left", "top", "right", "bottom", "width", "height", "margin", "margin-top", "margin-right", "margin-bottom", "margin-left", "transform", "z-index", "align-self", "flex", "flex-grow", "flex-shrink", "flex-basis", "order"]);
export const TEXT_PROPS = ["font-family", "font-size", "font-weight", "font-style", "line-height", "letter-spacing", "text-transform", "text-decoration"];
export const COLOR_PROPS = ["background-color", "color", "border-color"];
const TEXTSET = new Set(TEXT_PROPS);

export function install(Doc) {
  const P = Doc.prototype;

  // ---------- helpers ----------
  P.walkAll = function (fn) {
    const rec = (n, parent) => { fn(n, parent); for (const c of n.children || []) rec(c, n); };
    for (const a of this.state.artboards) rec(a, null);
  };
  // the chain of nodes from an artboard down to `id`
  P.chainTo = function (id) {
    const rec = (n, acc) => {
      acc.push(n);
      if (n.id === id) return true;
      for (const c of n.children || []) if (rec(c, acc)) return true;
      acc.pop();
      return false;
    };
    for (const a of this.state.artboards) { const acc = []; if (rec(a, acc)) return acc; }
    return null;
  };
  // the innermost instance that contains `id` (or is `id`) and the child-index path from it: { inst, path } | null
  P.instanceCtx = function (id) {
    const chain = this.chainTo(id);
    if (!chain) return null;
    let k = -1;
    for (let i = chain.length - 1; i >= 0; i--) if (chain[i].instanceOf) { k = i; break; }
    if (k < 0) return null;
    const idx = [];
    for (let i = k; i < chain.length - 1; i++) idx.push(chain[i].children.indexOf(chain[i + 1]));
    return { inst: chain[k], path: idx.join("."), isRoot: k === chain.length - 1 };
  };
  P.override = function (id, patch) {
    const ctx = this.instanceCtx(id);
    if (!ctx) return false;
    const o = (ctx.inst.overrides = ctx.inst.overrides || {});
    const e = (o[ctx.path] = o[ctx.path] || {});
    for (const [k, v] of Object.entries(patch)) {
      if (k === "style" || k === "attrs") { e[k] = e[k] || {}; Object.assign(e[k], v); }
      else e[k] = v;
    }
    if (patch.text !== undefined) delete e.html;
    if (patch.html !== undefined) delete e.text;
    return true;
  };
  // structural edits inside an instance (adding, removing, moving layers) detach it, so the instance never fights its master
  P.detachInstanceOf = function (id, { includeRoot = false } = {}) {
    const ctx = this.instanceCtx(id);
    if (!ctx || (ctx.isRoot && !includeRoot)) return false;
    delete ctx.inst.instanceOf; delete ctx.inst.overrides;
    return true;
  };

  // ---------- components ----------
  P.findMaster = function (cid) { let m = null; this.walkAll((n) => { if (n.component === cid) m = n; }); return m; };
  P.createComponent = function ({ nodeId, name }) {
    const before = this.snapshot();
    const { node } = this.need(nodeId);
    if (node.artboard) throw new Error("Artboards can't be components. Select a layer or a frame.");
    if (node.component) throw new Error("This layer is already a component.");
    if (node.instanceOf) throw new Error("This layer is an instance. Detach it first, or pick its main component.");
    this.state.components = this.state.components || {};
    this.state.nextComp = (this.state.nextComp || 0) + 1;
    const id = "c" + this.state.nextComp;
    const nm = (name && name.trim()) || this.label(node);
    this.state.components[id] = { name: nm };
    node.component = id;
    node.name = nm;
    this.commit(before);
    return { id, name: nm };
  };
  P.cloneForInstance = function (master) {
    const walk = (m) => {
      const c = JSON.parse(JSON.stringify(m));
      delete c.component;
      const reid = (n) => { n.id = this.id(); (n.children || []).forEach(reid); };
      reid(c);
      return c;
    };
    return walk(master);
  };
  P.createInstance = function ({ componentId, parentId, index, style = {} }) {
    const before = this.snapshot();
    const master = this.findMaster(componentId);
    if (!master) throw new Error(`No component "${componentId}". Use list_components.`);
    const parent = this.need(parentId).node;
    if (this.chainTo(parentId)?.some((n) => n === master)) throw new Error("A component can't contain an instance of itself.");
    const inst = this.cloneForInstance(master);
    inst.instanceOf = componentId; inst.overrides = {};
    inst.name = this.state.components[componentId].name;
    // the instance gets its own place; everything else follows the master
    for (const k of ["position", "left", "top", "right", "bottom", "margin"]) delete inst.style[k];
    Object.assign(inst.style, style);
    parent.children = parent.children || [];
    parent.children.splice(index === undefined ? parent.children.length : index, 0, inst);
    this.commit(before);
    return this.brief(inst);
  };
  P.detachInstance = function ({ nodeIds }) {
    const before = this.snapshot();
    for (const id of nodeIds) { const { node } = this.need(id); delete node.instanceOf; delete node.overrides; }
    this.commit(before);
    return true;
  };
  P.renameComponent = function ({ componentId, name }) {
    const before = this.snapshot();
    const c = (this.state.components || {})[componentId];
    if (!c) throw new Error(`No component "${componentId}".`);
    c.name = name.trim() || c.name;
    const m = this.findMaster(componentId);
    if (m) m.name = c.name;
    this.walkAll((n) => { if (n.instanceOf === componentId) n.name = c.name; });
    this.commit(before);
    return true;
  };
  P.deleteComponent = function ({ componentId }) {
    const before = this.snapshot();
    this.walkAll((n) => { if (n.instanceOf === componentId) { delete n.instanceOf; delete n.overrides; } if (n.component === componentId) delete n.component; });
    if (this.state.components) delete this.state.components[componentId];
    this.commit(before);
    return true;
  };
  P.listComponents = function () {
    const out = [];
    for (const [id, c] of Object.entries(this.state.components || {})) {
      const m = this.findMaster(id);
      let uses = 0; this.walkAll((n) => { if (n.instanceOf === id) uses++; });
      out.push({ id, name: c.name, main: m ? m.id : null, instances: uses });
    }
    return out;
  };

  // Rebuild every instance from its master, then re-apply the instance's own overrides. Runs inside every commit.
  P.syncComponents = function () {
    const comps = this.state.components;
    if (!comps || !Object.keys(comps).length) { this.walkAll((n) => { if (n.instanceOf) { delete n.instanceOf; delete n.overrides; } }); return; }
    for (let pass = 0; pass < 3; pass++) {
      const masters = {}, insts = [];
      this.walkAll((n) => { if (n.component && comps[n.component]) masters[n.component] = n; if (n.instanceOf) insts.push(n); });
      for (const cid of Object.keys(comps)) if (!masters[cid]) delete comps[cid];     // the main component was deleted
      let changed = false;
      for (const inst of insts) {
        const m = masters[inst.instanceOf];
        if (!m) { delete inst.instanceOf; delete inst.overrides; changed = true; continue; }
        if (this.chainTo(inst.id)?.includes(m)) { delete inst.instanceOf; delete inst.overrides; continue; }   // inside its own master: never sync
        const before = JSON.stringify(inst);
        this.rebuildInstance(inst, m);
        if (JSON.stringify(inst) !== before) changed = true;
      }
      if (!changed) break;
    }
  };
  P.rebuildInstance = function (inst, master) {
    const ov = inst.overrides || {};
    const build = (m, existing, path) => {
      const n = { id: existing && existing.tag === m.tag ? existing.id : this.id(), tag: m.tag };
      if (m.tag === "#text") { n.text = m.text; return n; }
      if (m.name) n.name = m.name;
      if (m.hidden) n.hidden = true;
      if (m.group) n.group = true;
      n.style = { ...(m.style || {}) };
      if (m.attrs) n.attrs = { ...m.attrs };
      if (m.raw !== undefined) n.raw = m.raw;
      if (m.refs) n.refs = { ...m.refs };
      if (m.auto) n.auto = true;
      if (m.crop) n.crop = { ...m.crop };
      if (m.instanceOf) { n.instanceOf = m.instanceOf; n.overrides = existing && existing.instanceOf === m.instanceOf && existing.overrides ? existing.overrides : {}; }
      n.children = (m.children || []).map((c, i) => build(c, existing && existing.children ? existing.children[i] : null, path === "" ? String(i) : path + "." + i));
      const o = ov[path];
      if (o) {
        if (o.text !== undefined) n.children = [{ id: this.id(), tag: "#text", text: o.text }];
        if (o.html !== undefined) n.children = this.parseHtml(o.html);
        if (o.attrs) { n.attrs = n.attrs || {}; for (const [k, v] of Object.entries(o.attrs)) { if (v === null) delete n.attrs[k]; else n.attrs[k] = v; } }
        if (o.style) for (const [k, v] of Object.entries(o.style)) { if (v === null || v === "") delete n.style[k]; else n.style[k] = v; }
        if (o.name) n.name = o.name;
        if (o.raw !== undefined) n.raw = o.raw;
        if (o.hidden !== undefined) { if (o.hidden) n.hidden = true; else delete n.hidden; }
      }
      return n;
    };
    const built = build(master, inst, "");
    // the instance keeps its own placement and size
    for (const k of KEEP) { if (inst.style && inst.style[k] !== undefined) built.style[k] = inst.style[k]; else if (path0(inst, k)) delete built.style[k]; }
    built.name = inst.name || (this.state.components[inst.instanceOf] || {}).name;
    inst.tag = built.tag; inst.style = built.style; inst.children = built.children;
    if (built.attrs) inst.attrs = built.attrs; else delete inst.attrs;
    if (built.raw !== undefined) inst.raw = built.raw; else delete inst.raw;
    if (built.refs) inst.refs = built.refs; else delete inst.refs;
    inst.name = built.name;
    delete inst.component;
    if (built.auto) inst.auto = true; else delete inst.auto;
    if (built.crop) inst.crop = built.crop; else delete inst.crop;
  };
  // placement props that the master has but a fresh instance deliberately doesn't carry
  const path0 = (inst, k) => ["position", "left", "top", "right", "bottom", "margin"].includes(k);

  // ---------- styles ----------
  P.styles = function () { return (this.state.styles = this.state.styles || {}); };
  P.createStyle = function ({ kind, name, value, nodeId, css }) {
    const before = this.snapshot();
    if (!["color", "text"].includes(kind)) throw new Error('Style kind must be "color" or "text".');
    const st = this.styles();
    this.state.nextStyle = (this.state.nextStyle || 0) + 1;
    const id = (kind === "color" ? "s" : "t") + this.state.nextStyle;
    if (kind === "color") {
      if (!value) throw new Error("A colour style needs a value, e.g. #46DE46.");
      st[id] = { kind, name: (name || "Colour").trim(), value };
    } else {
      let c = css;
      if (!c && nodeId) { const { node } = this.need(nodeId); c = Object.fromEntries(TEXT_PROPS.filter((k) => node.style && node.style[k]).map((k) => [k, node.style[k]])); }
      if (!c || !Object.keys(c).length) throw new Error("A text style needs fonts: pass css or a layer with text styles.");
      st[id] = { kind, name: (name || "Text").trim(), css: c };
    }
    this.commit(before);
    return { id, ...st[id] };
  };
  P.updateStyle = function ({ id, name, value, css }) {
    const before = this.snapshot();
    const st = this.styles()[id];
    if (!st) throw new Error(`No style "${id}".`);
    if (name) st.name = name.trim();
    if (st.kind === "color" && value) st.value = value;
    if (st.kind === "text" && css) st.css = css;
    // every layer linked to it follows
    this.walkAll((n) => {
      if (!n.refs) return;
      for (const [prop, sid] of Object.entries(n.refs)) {
        if (sid !== id) continue;
        if (st.kind === "color") n.style[prop] = st.value;
        else { for (const k of TEXT_PROPS) delete n.style[k]; Object.assign(n.style, st.css); }
      }
    });
    this.commit(before);
    return true;
  };
  P.applyStyle = function ({ nodeIds, styleId, prop }) {
    const before = this.snapshot();
    const st = this.styles()[styleId];
    if (!st) throw new Error(`No style "${styleId}".`);
    for (const id of nodeIds) {
      const { node } = this.need(id);
      if (st.kind === "color") {
        const p = prop || "background-color";
        if (!COLOR_PROPS.includes(p)) throw new Error("Colour styles apply to " + COLOR_PROPS.join(", ") + ".");
        this.applyStyles([{ nodeIds: [id], styles: { [p]: st.value } }]);
        // a solid colour replaces any gradient or shorthand that would hide it
        if (p === "background-color") { delete node.style["background-image"]; if (node.style.background && !/url\(/.test(node.style.background)) delete node.style.background; }
        (node.refs = node.refs || {})[p] = styleId;     // after the style change: editing a property unlinks it, linking must come last
      } else {
        this.applyStyles([{ nodeIds: [id], styles: { ...Object.fromEntries(TEXT_PROPS.map((k) => [k, null])), ...st.css } }]);
        (node.refs = node.refs || {}).text = styleId;
      }
    }
    this.commit(before);
    return true;
  };
  P.detachStyle = function ({ nodeIds, prop }) {
    const before = this.snapshot();
    for (const id of nodeIds) { const { node } = this.need(id); if (node.refs) { if (prop) delete node.refs[prop]; else delete node.refs; if (node.refs && !Object.keys(node.refs).length) delete node.refs; } }
    this.commit(before);
    return true;
  };
  P.deleteStyle = function ({ id }) {
    const before = this.snapshot();
    if (!this.styles()[id]) throw new Error(`No style "${id}".`);
    this.walkAll((n) => { if (n.refs) { for (const [p, sid] of Object.entries(n.refs)) if (sid === id) delete n.refs[p]; if (!Object.keys(n.refs).length) delete n.refs; } });
    delete this.state.styles[id];
    this.commit(before);
    return true;
  };
  // a manual edit of a linked property unlinks it, so the style never silently overwrites a deliberate change
  P.unlinkEdited = function (node, key) {
    if (!node.refs) return;
    if (node.refs[key]) delete node.refs[key];
    if (TEXTSET.has(key) && node.refs.text) delete node.refs.text;
    if (!Object.keys(node.refs).length) delete node.refs;
  };

  // ---------- brand kit ----------
  P.brand = function () { return (this.state.brand = this.state.brand || { name: "", fonts: { heading: "", body: "", mono: "" }, logo: null, notes: "" }); };
  P.setBrand = function ({ name, fonts, logo, notes, colors }) {
    const before = this.snapshot();
    const b = this.brand();
    if (name !== undefined) b.name = String(name);
    if (notes !== undefined) b.notes = String(notes);
    if (fonts) b.fonts = { ...b.fonts, ...fonts };
    if (logo !== undefined) b.logo = logo ? this.localiseUrl(logo) : null;
    if (colors) {
      const st = this.styles();
      for (const c of colors) {
        const ex = Object.entries(st).find(([, s]) => s.kind === "color" && s.name.toLowerCase() === String(c.name).toLowerCase());
        if (ex) { ex[1].value = c.value; this.walkAll((n) => { if (n.refs) for (const [p, sid] of Object.entries(n.refs)) if (sid === ex[0]) n.style[p] = c.value; }); }
        else { this.state.nextStyle = (this.state.nextStyle || 0) + 1; st["s" + this.state.nextStyle] = { kind: "color", name: String(c.name), value: c.value }; }
      }
    }
    this.commit(before);
    return this.getBrand();
  };
  P.getBrand = function () {
    const st = this.styles();
    return {
      brand: this.brand(),
      colors: Object.entries(st).filter(([, s]) => s.kind === "color").map(([id, s]) => ({ id, name: s.name, value: s.value })),
      textStyles: Object.entries(st).filter(([, s]) => s.kind === "text").map(([id, s]) => ({ id, name: s.name, css: s.css })),
      components: this.listComponents(),
    };
  };
}
