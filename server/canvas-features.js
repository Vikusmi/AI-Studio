// Server side of the canvas tools: guides, layout grid, auto layout, SVG editing, zoomable image crops.
// Every operation is one undo step and works the same for the editor and for Claude.

const BOX = new Set(["position", "left", "top", "right", "bottom", "margin", "margin-top", "margin-right", "margin-bottom", "margin-left", "width", "height", "transform", "z-index", "align-self", "flex", "flex-grow", "flex-shrink", "flex-basis", "order", "border-radius", "box-shadow", "opacity", "filter", "mix-blend-mode", "border", "min-width", "min-height", "max-width", "max-height"]);

// strip anything executable from SVG markup
export function cleanSvg(raw) {
  let s = String(raw || "").trim();
  if (!/^<svg[\s>]/i.test(s)) throw new Error("That isn't SVG markup (it must start with <svg>).");
  s = s.replace(/<script[\s\S]*?<\/script>/gi, "").replace(/<foreignObject[\s\S]*?<\/foreignObject>/gi, "").replace(/\son\w+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, "").replace(/(href|xlink:href)\s*=\s*("\s*javascript:[^"]*"|'\s*javascript:[^']*')/gi, "");
  return s;
}

export function install(Doc) {
  const P = Doc.prototype;

  P.setGuides = function ({ nodeId, guides }) {
    const before = this.snapshot();
    const { node } = this.need(nodeId);
    if (!node.artboard) throw new Error("Guides belong to artboards.");
    const g = (guides || []).filter((x) => (x.a === "x" || x.a === "y") && Number.isFinite(+x.p)).map((x) => ({ a: x.a, p: Math.round(+x.p) }));
    if (g.length) node.guides = g; else delete node.guides;
    this.commit(before);
    return g;
  };
  P.setGrid = function ({ nodeId, grid }) {
    const before = this.snapshot();
    const { node } = this.need(nodeId);
    if (!node.artboard) throw new Error("The layout grid belongs to artboards.");
    const g = grid ? { size: Math.max(2, Math.min(400, parseInt(grid.size, 10) || 8)), show: !!grid.show, snap: !!grid.snap } : null;
    // a grid that is off and at the default size is just "no grid"; a chosen size is remembered even while it is hidden
    if (!g || (!g.show && !g.snap && g.size === 8)) delete node.grid; else node.grid = g;
    this.commit(before);
    return node.grid || null;
  };

  // Turn auto layout on or off for a frame in one step: style updates for the frame and its children, the new child order, the flag.
  P.setAutoLayout = function ({ nodeId, auto, updates = [], order }) {
    const before = this.snapshot();
    const { node } = this.need(nodeId);
    if (node.tag === "img" || node.tag === "svg" || node.tag === "#text") throw new Error("Only frames can use auto layout.");
    this.detachInstanceOf(nodeId, { includeRoot: true });
    if (updates.length) this.applyStyles(updates);
    if (order && order.length) {
      const byId = new Map((node.children || []).map((c) => [c.id, c]));
      if (order.every((id) => byId.has(id))) {
        const rest = (node.children || []).filter((c) => !order.includes(c.id));
        node.children = [...order.map((id) => byId.get(id)), ...rest];
      }
    }
    if (auto) node.auto = true; else delete node.auto;
    this.commit(before);
    return true;
  };

  // ---------- svg ----------
  P.setSvg = function ({ nodeId, raw }) {
    const before = this.snapshot();
    const { node } = this.need(nodeId);
    if (node.tag !== "svg") throw new Error("That layer isn't an SVG.");
    const clean = cleanSvg(raw).replace(/\slayer-name="[^"]*"/, "").replace(/\sstyle="[^"]*"/, "");
    node.raw = clean;
    // the root's own attributes (viewBox, width, height …) are kept as attributes of the layer
    const root = /^<svg([^>]*)>/i.exec(clean);
    const attrs = {};
    if (root) for (const m of root[1].matchAll(/([\w:-]+)\s*=\s*"([^"]*)"/g)) if (!["xmlns", "style", "layer-name", "xmlns:xlink"].includes(m[1])) attrs[m[1]] = m[2];
    if (Object.keys(attrs).length) node.attrs = attrs; else delete node.attrs;
    if (!this.override(nodeId, { raw: clean })) { /* not inside an instance */ }
    this.commit(before);
    return true;
  };

  // ---------- zoomable image crops ----------
  // A cropped image with zoom is a frame (overflow hidden) holding the picture at a larger size; frame.crop remembers the settings.
  P.layoutCrop = function (node) {
    const c = node.crop, img = (node.children || [])[0];
    if (!c || !img) return;
    const W = parseFloat(node.style.width), H = parseFloat(node.style.height);
    if (!(W > 0 && H > 0 && c.nw > 0 && c.nh > 0)) return;
    const k = Math.max(W / c.nw, H / c.nh) * Math.max(1, c.zoom || 1);
    const iw = c.nw * k, ih = c.nh * k;
    const r = (v) => Math.round(v * 100) / 100;
    img.style = { position: "absolute", display: "block", "max-width": "none", left: r((W - iw) * ((c.px ?? 50) / 100)) + "px", top: r((H - ih) * ((c.py ?? 50) / 100)) + "px", width: r(iw) + "px", height: r(ih) + "px" };
  };
  P.cropImage = function ({ nodeId, zoom = 1, px = 50, py = 50, nw, nh, w, h }) {
    const before = this.snapshot();
    const { node } = this.need(nodeId);
    zoom = Math.max(1, Math.min(8, +zoom || 1)); px = Math.max(0, Math.min(100, +px)); py = Math.max(0, Math.min(100, +py));
    if (node.crop) {
      node.crop = { ...node.crop, zoom, px, py };
      this.layoutCrop(node);
    } else if (node.tag === "img") {
      if (!(nw > 0 && nh > 0)) throw new Error("The picture's natural size is needed to crop it.");
      const W = parseFloat(node.style.width) || w, H = parseFloat(node.style.height) || h;
      if (!(W > 0 && H > 0)) throw new Error("The frame's size is needed to crop the picture.");
      const frameStyle = {};
      for (const [k, v] of Object.entries(node.style)) if (BOX.has(k)) frameStyle[k] = v;
      frameStyle.width = W + "px"; frameStyle.height = H + "px"; frameStyle.overflow = "hidden";
      if (!frameStyle.position || frameStyle.position === "static") frameStyle.position = "relative";
      delete frameStyle.flex;
      const img = { id: this.id(), tag: "img", attrs: { ...(node.attrs || {}) }, style: {} };
      node.tag = "div"; node.style = frameStyle; node.attrs = {}; node.children = [img]; node.crop = { zoom, px, py, nw, nh };
      node.name = node.name || "Image";
      this.layoutCrop(node);
    } else throw new Error("Only pictures can be cropped.");
    this.commit(before);
    return true;
  };
  // back to a plain picture (with object-fit: cover and the same focal point)
  P.uncropImage = function ({ nodeId }) {
    const before = this.snapshot();
    const { node } = this.need(nodeId);
    if (!node.crop) return true;
    const img = (node.children || [])[0];
    const style = { ...node.style }; delete style.overflow;
    if (node.crop.zoom > 1.0001) { /* the zoom is dropped: a plain picture can only cover its frame */ }
    style["object-fit"] = "cover"; style["object-position"] = `${node.crop.px}% ${node.crop.py}%`; style.display = "block";
    node.tag = "img"; node.attrs = { ...((img && img.attrs) || {}) }; node.style = style; node.children = []; delete node.crop;
    this.commit(before);
    return true;
  };
  // the frame becomes one flat picture (what you see is what is exported, also in email)
  P.bakeCropWith = function (nodeId, buf) {
    const before = this.snapshot();
    const { node } = this.need(nodeId);
    if (!node.crop) throw new Error("Nothing to bake: this isn't a zoomed crop.");
    const src = this.addAsset((node.name || "crop") + "-crop.png", buf);
    const style = { ...node.style }; delete style.overflow; style.display = "block";
    node.tag = "img"; node.attrs = { src, alt: node.name || "" }; node.style = style; node.children = []; delete node.crop;
    this.commit(before);
    return src;
  };
}
