// Email-safe export: flex layouts become nested tables, with inline styles only.
// Handles what email clients (Outlook, Gmail) need: padding/background/radius live on <td>, gaps become cell padding,
// buttons become "bulletproof" table buttons. Absolute positioning and grid can't be expressed in email and are reported.
const INLINE = new Set(["span", "b", "i", "strong", "em", "a", "u", "small", "sup", "sub", "br", "label"]);
const BOX = /^(background(-color|-image|-size|-position|-repeat)?|padding(-(top|right|bottom|left))?|border(-(top|right|bottom|left))?(-(width|style|color|radius))?|border-radius|box-shadow|width|min-width|max-width|height|min-height)$/;
// text styles are inherited in CSS, but a flex container becomes tables: its font, colour and spacing must be repeated on the cells
const INHERIT = /^(font($|-)|color$|letter-spacing$|line-height$|text-(align|transform|decoration|shadow|indent)$|white-space$|word-spacing$)/;
const inherited = (st) => Object.fromEntries(Object.entries(st || {}).filter(([k, v]) => INHERIT.test(k) && v !== undefined && v !== ""));
const px = (v) => (v && /^-?[\d.]+(px)?$/.test(String(v).trim()) ? parseFloat(v) : null);
const css = (o) => Object.entries(o).filter(([, v]) => v !== undefined && v !== "").map(([k, v]) => `${k}:${v}`).join(";");
const attr = (s) => String(s).replace(/&/g, "&amp;").replace(/"/g, "&quot;");

// opts.render(node, { width, bg }) -> sliced render (see shot.js renderSliced); opts.images: "data" (inline base64) | "files" (images/slice-N.jpg)
const isAbs = (c) => c.tag !== "#text" && !c.hidden && ["absolute", "fixed"].includes((c.style || {}).position);
// layouts that tables can't express faithfully: free placement, max-width, flexible sizing, wrapping rows, grids, transforms, gradients, cropped images
const ownRisky = (st = {}, tag) => /^(absolute|fixed)$/.test(st.position || "")
  || (st["max-width"] && st["max-width"] !== "none") || parseFloat(st["flex-grow"]) > 0 || /^[1-9]/.test(st.flex || "") || /wrap/.test(st["flex-wrap"] || "")
  || /grid/.test(st.display || "") || (st.transform && st.transform !== "none") || /(gradient|url)\(/.test((st["background-image"] || "") + (st.background || ""))
  || (tag === "img" && (st["object-fit"] || st["border-radius"])) || /(^|\s)-\d/.test(st.margin || "") || /^-/.test(st["margin-top"] || st["margin-left"] || "");
const risky = (n) => n.tag !== "#text" && !n.hidden && (ownRisky(n.style, n.tag) || (n.children || []).some(risky));
const visibleKids = (n) => (n.children || []).filter((c) => c.tag !== "#text" && !c.hidden);
// mode "auto": sections that need it become slices, "all": every section does, "none": tables only
export const rasterPlan = (n, mode = "auto") => {
  if (mode === "none") return [];
  if ((n.children || []).some(isAbs)) return [n];       // free-placed layers straight on the artboard: the whole artboard
  return visibleKids(n).filter((c) => mode === "all" || risky(c));
};

export async function emailPage(doc, artboard, opts = {}) {
  const warnings = new Set();
  const files = [];
  const rasters = new Map();
  let nSlice = 0;
  const imgSrc = (buf, ext) => {
    if ((opts.images || "data") === "files") { const name = `slice-${String(++nSlice).padStart(2, "0")}.${ext}`; files.push({ name: "images/" + name, data: buf }); return "images/" + name; }
    return `data:image/${ext === "jpg" ? "jpeg" : ext};base64,${buf.toString("base64")}`;
  };
  const visible = (n) => !n.hidden && !(n.tag === "#text" && !n.text.trim());
  const isInlineTree = (n) => n.tag === "#text" || (INLINE.has(n.tag) && (n.children || []).every(isInlineTree));
  const isFlex = (st) => /flex/.test(st.display || "");
  // text with inline formatting; a flex container is always a layout, even if its children are spans
  const isTextBlock = (n) => n.tag !== "img" && n.tag !== "svg" && n.tag !== "#text" && (n.children || []).length > 0 && n.children.every(isInlineTree) && !(isFlex(n.style || {}) && n.children.some((c) => c.tag !== "#text"));

  function dims(st, inRow) {
    // table width: explicit px/% wins, otherwise fill the cell in a column and shrink in a row
    const w = st.width;
    if (w && w !== "auto" && w !== "fit-content") return /%$/.test(w) ? { style: `width:${w}` } : { attr: ` width="${parseFloat(w)}"`, style: `width:${parseFloat(w)}px` };
    return inRow ? {} : { attr: ' width="100%"', style: "width:100%" };
  }
  function split(st) {
    const box = {}, rest = {};
    for (const [k, v] of Object.entries(st)) (BOX.test(k) ? box : rest)[k] = v;
    return { box, rest };
  }
  function cellStyle(box) {
    const out = {};
    for (const [k, v] of Object.entries(box)) if (/^padding/.test(k)) out[k] = v;
    return out;
  }
  function tableStyle(box) {
    const out = { "border-collapse": "separate", "border-spacing": "0" };
    for (const [k, v] of Object.entries(box)) {
      if (/^padding/.test(k) || /^(width|min-width|max-width|height|min-height)$/.test(k)) continue;
      out[k] = v;
    }
    if (box["border-radius"]) out.overflow = "hidden";
    return out;
  }
  function table(inner, st, inRow, extraTd = {}) {
    const { box } = split(st);
    extraTd = { ...inherited(st), ...extraTd };
    const d = dims(st, inRow);
    const bg = st["background-color"] || (/^(#|rgb|hsl|[a-z]+$)/i.test(st.background || "") ? st.background : "");
    const h = px(box.height) || px(box["min-height"]);
    return `<table role="presentation" cellpadding="0" cellspacing="0" border="0"${d.attr || ""}${bg && /^#[0-9a-f]{3,8}$/i.test(bg) ? ` bgcolor="${bg}"` : ""} style="${css({ ...tableStyle(box), ...(d.style ? Object.fromEntries([d.style.split(":")]) : {}) })}"><tr><td valign="top" style="${css({ ...cellStyle(box), ...extraTd, height: h ? h + "px" : undefined })}">${inner}</td></tr></table>`;
  }

  function leaf(n, inRow) {
    const { box, rest } = split(n.style || {});
    const hasBox = Object.keys(box).some((k) => !/^(width|min-width|max-width|height|min-height)$/.test(k));
    if (!hasBox) return doc.toHtml(n);
    // background, padding, radius or border on text (e.g. a button): the box goes on a <td>, the text styles stay inline
    const html = doc.toHtml({ ...n, style: rest });
    const bg = box["background-color"] || box.background || "";
    const d = dims(n.style, inRow || INLINE.has(n.tag) || /inline/.test(n.style.display || ""));
    return `<table role="presentation" cellpadding="0" cellspacing="0" border="0"${d.attr || ""}${/^#[0-9a-f]{3,8}$/i.test(bg) ? ` bgcolor="${bg}"` : ""} style="${css({ ...tableStyle(box), ...(d.style ? Object.fromEntries([d.style.split(":")]) : {}) })}"><tr><td align="${rest["text-align"] || "left"}" valign="middle" style="${css(cellStyle(box))}">${html}</td></tr></table>`;
  }

  function emit(n, ctx = {}) {
    if (n.tag === "#text") return doc.toHtml(n);
    if (rasters.has(n.id)) return rasters.get(n.id);
    if (n.tag === "img") {
      const st = { ...n.style };
      const w = px(st.width);
      const a = { ...(n.attrs || {}) };
      return `<img${Object.entries(a).map(([k, v]) => ` ${k}="${attr(v)}"`).join("")}${w ? ` width="${w}"` : ""} style="${css({ display: "block", border: "0", outline: "none", "text-decoration": "none", ...st })}">`;
    }
    if (n.tag === "svg") return doc.toHtml(n);
    if (n.style && n.style.position === "absolute") warnings.add("absolutely positioned elements keep their position only in browsers, not in most email clients");
    if (n.style && n.style.display === "grid") warnings.add("grid layouts aren't supported by email clients");
    if (isTextBlock(n)) return leaf(n, ctx.inRow);
    return container(n, ctx);
  }

  function container(n, ctx) {
    const st = n.style || {};
    const kids = (n.children || []).filter(visible);
    const flex = isFlex(st);
    const row = flex && !/^column/.test(st["flex-direction"] || "row");
    const gap = px(st.gap) || 0;
    const ai = st["align-items"], jc = st["justify-content"];
    if (!kids.length) return table("&nbsp;", st, ctx.inRow, { "font-size": "1px", "line-height": "1px" });
    let inner;
    if (!row) {
      const align = ai === "center" ? "center" : ai === "flex-end" ? "right" : "left";
      inner = `<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="border-collapse:collapse">${kids
        .map((c, i) => `<tr><td align="${align}" valign="top" style="${css({ ...inherited(st), ...(i && gap ? { "padding-top": gap + "px" } : {}) })}">${emit(c, {})}</td></tr>`)
        .join("")}</table>`;
    } else {
      const valign = ai === "center" ? "middle" : ai === "flex-end" || ai === "baseline" ? "bottom" : "top";
      const spacer = (w) => `<td width="${w}%" style="width:${w}%;font-size:1px;line-height:1px">&nbsp;</td>`;
      const spaced = jc && !/^(flex-start|start)$/.test(jc);
      const cells = kids.map((c, i) => `<td valign="${valign}" style="${css({ ...inherited(st), "padding-left": i && gap && jc !== "space-between" ? gap + "px" : "", "white-space": spaced ? "nowrap" : "" })}">${emit(c, { inRow: true })}</td>`);
      let tds;
      if (jc === "center") tds = spacer(50) + cells.join("") + spacer(50);
      else if (jc === "flex-end") tds = spacer(100) + cells.join("");
      else if (jc === "space-between" && cells.length > 1) tds = cells.join(spacer(100));
      else if (jc === "space-around" && cells.length) tds = spacer(50) + cells.join(spacer(100)) + spacer(50);
      else tds = cells.join("");
      const fill = jc && jc !== "flex-start" && jc !== "start";
      inner = `<table role="presentation" cellpadding="0" cellspacing="0" border="0"${fill ? ' width="100%"' : ""} style="border-collapse:collapse${fill ? ";width:100%" : ""}"><tr>${tds}</tr></table>`;
    }
    return table(inner, st, ctx.inRow);
  }

  // Free-placed layers (position:absolute) can't be expressed in email. The outermost block that holds them is rendered to image
  // slices instead, cut around its links so every button stays a real link. Everything else stays live tables and text.
  const artW = px(artboard.style.width) || 600;
  const abBg = artboard.style["background-color"] || "#ffffff";
  const rasterTable = (r) => {
    const W = r.width, ext = r.format === "png" ? "png" : "jpg";
    const rows = r.rows.map((row) => {
      const cells = row.cells.map((c) => {
        const img = `<img src="${imgSrc(c.buf, ext)}" width="${c.w}" height="${row.h}" alt="${attr(c.alt || "")}" style="display:block;border:0;outline:none;text-decoration:none;width:${c.w}px;height:${row.h}px">`;
        return `<td width="${c.w}" height="${row.h}" valign="top" style="padding:0;font-size:0;line-height:0">${c.href ? `<a href="${attr(c.href)}" target="_blank" style="text-decoration:none">${img}</a>` : img}</td>`;
      }).join("");
      return `<tr><td style="padding:0;font-size:0;line-height:0"><table role="presentation" width="${W}" cellpadding="0" cellspacing="0" border="0" style="border-collapse:collapse"><tr>${cells}</tr></table></td></tr>`;
    }).join("");
    return `<table role="presentation" width="${W}" cellpadding="0" cellspacing="0" border="0" align="center" style="border-collapse:collapse;width:${W}px">${rows}</table>`;
  };
  if (opts.render) {
    for (const n of rasterPlan(artboard, opts.raster || "auto")) {
      const w = n.id === artboard.id ? artW : (px(n.style && n.style.width) || artW);
      rasters.set(n.id, rasterTable(await opts.render(n, { width: w, bg: abBg })));
    }
    if (rasters.size) warnings.add(`${rasters.size} section${rasters.size > 1 ? "s" : ""} ${rasters.size > 1 ? "were" : "was"} turned into image slices because ${(opts.raster || "auto") === "all" ? "you chose image slices" : "the layout can't be built from email tables"} (links stay clickable, text in the slices is part of the picture)`);
  }
  const bg = artboard.style["background-color"] || "#ffffff";
  const width = px(artboard.style.width) || 600;
  const body = emit({ ...artboard, style: { ...artboard.style, width: width + "px" } }, {});
  const title = (artboard.name || "Email").replace(/</g, "");
  const note = warnings.size ? `<!-- Email export notes: ${[...warnings].join("; ")} -->\n` : "";
  return {
    files,
    rasterized: rasters.size,
    warnings: [...warnings],
    html: `<!doctype html>
<html lang="en" xmlns="http://www.w3.org/1999/xhtml"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="X-UA-Compatible" content="IE=edge"><meta name="x-apple-disable-message-reformatting"><title>${title}</title>
${doc.fontLink(artboard)}
<style>body{margin:0;padding:0}table{mso-table-lspace:0;mso-table-rspace:0}img{-ms-interpolation-mode:bicubic}</style>
</head><body style="margin:0;padding:0;background-color:${bg}">
${note}<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="${bg}" style="background-color:${bg}"><tr><td align="center">${body}</td></tr></table>
</body></html>`,
  };
}
