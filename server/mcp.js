// MCP server: lets Claude read and edit the canvas. Starts the app server if it is not running yet.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";

const here = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.STUDIO_PORT || 4777);
const BASE = `http://127.0.0.1:${PORT}`;

async function alive() {
  try {
    return (await fetch(BASE + "/api/ping")).ok;
  } catch {
    return false;
  }
}
async function ensureServer() {
  if (await alive()) return;
  const child = spawn(process.execPath, [path.join(here, "server.js")], { detached: true, stdio: "ignore", env: process.env });
  child.unref();
  for (let i = 0; i < 40; i++) {
    await new Promise((r) => setTimeout(r, 150));
    if (await alive()) return;
  }
  throw new Error("Could not start the Studio server.");
}
async function op(name, args = {}) {
  await ensureServer();
  const r = await fetch(BASE + "/api/op", { method: "POST", body: JSON.stringify({ op: name, args }) });
  const j = await r.json();
  if (!r.ok) throw new Error(j.error || "Request failed");
  return j.result;
}

const text = (v) => ({ content: [{ type: "text", text: typeof v === "string" ? v : JSON.stringify(v, null, 2) }] });
const wrap = (fn) => async (args) => {
  try {
    return await fn(args || {});
  } catch (e) {
    return { isError: true, content: [{ type: "text", text: e.message }] };
  }
};

const GUIDE = `AI Studio: how to design here

Workflow
1. get_basic_info to see the open project, its artboards and what the user has selected. New piece of work? create_project first (list_projects / open_project to switch).
2. create_artboard (name it, e.g. "Welcome email"), then write_html into it with insert-children.
3. get_screenshot of the artboard, look at it, then fix with update_styles / write_html.
4. Tell the user to look at the canvas (they see changes live at the app URL). export writes files: html, email / email-zip / eml (email-safe), png / jpg / webp (scale 1-4), pdf (one page per artboard), slices (a zip of the top-level sections), and scope \"all\" for every artboard.
5. Custom fonts the user uploaded are listed in the Assets tab and can be used by name in font-family.

HTML rules (so the result exports cleanly as an email or page)
- Use inline style="" on every element. No <style> blocks, no classes, no scripts.
- Lay out with flexbox (display:flex, flex-direction, gap, align-items, justify-content). Prefer padding over margin.
- Set layer-name="Hero" on frames so the layers panel is readable.
- Images: <img src="/absolute/local/path.jpg"> or https URL. Local files are copied into the project and embedded on export.
- Fonts: use Google Fonts family names in font-family (e.g. 'Inter Tight', 'Caveat'); they load automatically.
- Absolute positioning works inside a position:relative parent: good for stickers and overlays.
- SVG is supported (kept as written).
- Text lives in span/p/h1-h6/div elements; to change text use set_text_content.

Brand, styles and components
- get_brand first: use the project's fonts and named colours instead of inventing. apply_style links a layer to a colour or text style so a later change to the style updates it.
- Repeated pieces (cards, buttons, headers): create_component once, then create_instance. Edit the main layer and every instance follows.

Editing
- update_styles takes nodeIds and a styles object (null removes a property). On an artboard, left/top move it on the canvas.
- duplicate_nodes, move_nodes (new parent + index), delete_nodes, rename_nodes are available.
- get_selection returns what the user currently has selected in the editor, so "make this bigger" can refer to it.

Formats (create_artboard preset)
- Social: instagram-post 1080×1080, instagram-portrait 1080×1350, story 1080×1920, facebook-post 1200×630, linkedin-post 1200×627, x-post 1600×900, youtube-thumbnail 1280×720, pinterest-pin 1000×1500.
- Ads: ad-300x250, ad-728x90, ad-300x600, ad-160x600, ad-970x250, ad-320x50. Presentation: slide-16x9 1920×1080, slide-4x3 1024×768.
- Print: a4 794×1123, letter 816×1056. Web: desktop 1440×900, mobile 390×844. Email: email (600 wide, grows).
- Posters, posts and ads: give the artboard a fixed height, set position:relative on it (or a full-size frame) and place layers with position:absolute; left/top/width/height. That is how the user's own canvas works too (they drag things freely).
- Slides: one artboard per slide, named "1 Title", "2 Problem"…; the user presents them with the Present button.

Styling the user can also edit in the inspector
- Gradients: background-image: linear-gradient(135deg, #ff4f1f 0%, #7a2cff 100%) or radial-gradient(circle at center, …). Use % positions on every stop.
- Image crop: give the <img> a fixed width and height plus object-fit:cover; object-position: 30% 50% picks the visible part.
- Effects: filter: blur(4px) brightness(110%) contrast(…) saturate(…) grayscale(…) hue-rotate(…deg); mix-blend-mode; box-shadow; border-radius.`;

const server = new McpServer({ name: "ai-studio", version: "0.1.0" });
const ids = z.array(z.string()).min(1);

server.tool("get_guide", "How to use this design tool and the HTML conventions. Read once before designing.", {}, wrap(async () => text(GUIDE)));

server.tool("list_projects", "All design projects (each holds its own artboards) and which one is open in the app.", {}, wrap(async () => text((await op("projects")).map(({ id, name, artboards, current, updated }) => ({ id, name, artboards, open: current, edited: new Date(updated).toISOString() })))));
server.tool(
  "open_project",
  "Switch the app to another project. The user's window follows. Every other tool works on the open project.",
  { projectId: z.string() },
  wrap(async ({ projectId }) => text(await op("openProject", { id: projectId })))
);
server.tool(
  "create_project",
  "Create a new project and open it (the user's window switches to it). Use for a new piece of work: a campaign, a deck, a set of posts.",
  { name: z.string() },
  wrap(async ({ name }) => text(await op("createProject", { name })))
);

server.tool("get_basic_info", "Project, canvas URL, all artboards (id, name, size, position) and the user's current selection.", {}, wrap(async () => text(await op("info"))));

server.tool(
  "get_tree_summary",
  "Indented outline of an artboard or node: id, name, tag, nested to a depth.",
  { nodeId: z.string().optional().describe("Omit for all artboards"), depth: z.number().optional() },
  wrap(async (a) => text(await op("tree", a)))
);

server.tool(
  "get_children",
  "List the direct children of a node (or the artboards when nodeId is omitted).",
  { nodeId: z.string().optional() },
  wrap(async (a) => text(await op("children", a)))
);

server.tool("get_node_info", "Styles, attributes and HTML of one node.", { nodeId: z.string() }, wrap(async (a) => text(await op("node", a))));

server.tool("get_selection", "The nodes the user has selected in the editor right now.", {}, wrap(async () => {
  const info = await op("info");
  const out = [];
  for (const id of info.selection) out.push(await op("node", { nodeId: id }).catch(() => null));
  return text(out.filter(Boolean).map((n) => ({ id: n.id, name: n.name, tag: n.tag, artboard: n.artboard, style: n.style, html: n.html.slice(0, 1500) })));
}));

const PRESETS = {
  email: [600], "instagram-post": [1080, 1080], "instagram-portrait": [1080, 1350], story: [1080, 1920], tiktok: [1080, 1920], "facebook-post": [1200, 630], "linkedin-post": [1200, 627], "x-post": [1600, 900], "youtube-thumbnail": [1280, 720], "pinterest-pin": [1000, 1500],
  "ad-300x250": [300, 250], "ad-728x90": [728, 90], "ad-300x600": [300, 600], "ad-160x600": [160, 600], "ad-970x250": [970, 250], "ad-320x50": [320, 50], "ad-320x100": [320, 100],
  "slide-16x9": [1920, 1080], "slide-4x3": [1024, 768], desktop: [1440, 900], laptop: [1280, 800], tablet: [768, 1024], mobile: [390, 844], a4: [794, 1123], letter: [816, 1056], "business-card": [1050, 600],
};
server.tool(
  "create_artboard",
  "Create a named artboard. Pick a preset (instagram-post, story, ad-300x250, slide-16x9, a4, email …; see get_guide) or give width/height in px. Omit height to grow with content.",
  {
    name: z.string().describe("Artboard name"),
    preset: z.enum(Object.keys(PRESETS)).optional(),
    width: z.number().optional(),
    height: z.number().optional(),
    backgroundColor: z.string().optional(),
  },
  wrap(async ({ backgroundColor, preset, ...a }) => {
    if (preset) { const [w, h] = PRESETS[preset]; a.width = a.width || w; if (h && !a.height) a.height = h; }
    return text(await op("createArtboard", { ...a, style: backgroundColor ? { "background-color": backgroundColor } : {} }));
  })
);

server.tool(
  "write_html",
  "Add HTML into an artboard/frame (insert-children) or swap a node for new HTML (replace). Inline styles and flexbox; see get_guide.",
  {
    targetNodeId: z.string(),
    html: z.string(),
    mode: z.enum(["insert-children", "replace"]).optional(),
    index: z.number().optional().describe("Position among children for insert-children; default is the end"),
  },
  wrap(async (a) => text({ created: await op("insert", { parentId: a.targetNodeId, html: a.html, mode: a.mode, index: a.index }) }))
);

server.tool(
  "update_styles",
  "Change CSS on nodes. styles is {property: value}; null removes. camelCase or kebab-case. On an artboard, left/top move it on the canvas.",
  { updates: z.array(z.object({ nodeIds: ids, styles: z.record(z.union([z.string(), z.number(), z.null()])) })) },
  wrap(async (a) => text({ updated: await op("updateStyles", a) }))
);

server.tool(
  "set_attributes",
  "Set attributes such as src, alt or href on a node (null removes).",
  { nodeId: z.string(), attrs: z.record(z.union([z.string(), z.null()])) },
  wrap(async (a) => text(await op("setAttrs", a) ?? "ok"))
);

server.tool("set_text_content", "Replace the text of a node.", { nodeId: z.string(), text: z.string() }, wrap(async (a) => text(await op("setText", a) ?? "ok")));

server.tool(
  "rename_nodes",
  "Rename layers or artboards.",
  { items: z.array(z.object({ nodeId: z.string(), name: z.string() })) },
  wrap(async (a) => text(await op("rename", a) ?? "ok"))
);

server.tool("delete_nodes", "Delete nodes or artboards.", { nodeIds: ids }, wrap(async (a) => text(await op("remove", a) ?? "ok")));

server.tool("duplicate_nodes", "Duplicate nodes or artboards.", { nodeIds: ids }, wrap(async (a) => text({ created: await op("duplicate", a) })));

server.tool(
  "move_nodes",
  "Move a node into a parent at an index (reorder or reparent). To reposition an artboard use update_styles left/top.",
  { nodeId: z.string(), parentId: z.string(), index: z.number().optional() },
  wrap(async (a) => text(await op("move", a) ?? "ok"))
);

server.tool(
  "reorder_nodes",
  "Change the stacking order of layers that share a parent: front, back, forward or backward (later siblings paint on top). One undo step. Prefer this to move_nodes for plain z-order changes.",
  { nodeIds: ids, to: z.enum(["front", "back", "forward", "backward"]) },
  wrap(async (a) => text((await op("reorder", a)) ? "ok" : "already there"))
);

server.tool(
  "group_nodes",
  "Group sibling nodes into one frame (layer 'Group'). The group moves and selects as a unit in the editor; the user double-clicks to reach the layers inside. Nodes must share a parent.",
  { nodeIds: ids },
  wrap(async (a) => text({ group: await op("group", a) }))
);
server.tool(
  "ungroup_nodes",
  "Dissolve frames or groups: their children move up into the parent. Absolutely positioned children keep their place.",
  { nodeIds: ids },
  wrap(async (a) => text({ freed: await op("ungroup", a) }))
);
server.tool(
  "split_text_from_box",
  "Split a text element that has its own background/border/padding (a button) into a box with a separate text layer inside, so the text can be moved and edited on its own.",
  { nodeId: z.string(), width: z.number().optional(), height: z.number().optional() },
  wrap(async (a) => text({ text: await op("splitText", a) }))
);

// ---- design system ----
server.tool("get_brand", "The project's brand kit: name, fonts (heading/body/mono), colours with their names, text styles, components. Call this before designing and use these values, not invented ones.", {}, wrap(async () => text(await op("getBrand"))));
server.tool(
  "set_brand",
  "Set the project's brand kit. fonts: Google Fonts family names. colors: named colours (same name = update). logo: a local file path or URL.",
  { name: z.string().optional(), fonts: z.object({ heading: z.string().optional(), body: z.string().optional(), mono: z.string().optional() }).optional(), colors: z.array(z.object({ name: z.string(), value: z.string() })).optional(), logo: z.string().optional(), notes: z.string().optional() },
  wrap(async (a) => text(await op("setBrand", a)))
);
server.tool(
  "create_style",
  "Create a colour style (value, e.g. #46DE46) or a text style (css: font-family, font-size, font-weight, line-height, letter-spacing, text-transform; or copy it from a layer with nodeId).",
  { kind: z.enum(["color", "text"]), name: z.string(), value: z.string().optional(), css: z.record(z.string()).optional(), nodeId: z.string().optional() },
  wrap(async (a) => text(await op("createStyle", a)))
);
server.tool(
  "apply_style",
  "Link a layer to a style, by style name. Changing the style later updates the layer. Colour styles apply to background-color (default), color or border-color.",
  { nodeIds: ids, style: z.string().describe("style name or id"), prop: z.enum(["background-color", "color", "border-color"]).optional() },
  wrap(async ({ nodeIds, style, prop }) => {
    const b = await op("getBrand");
    const hit = [...b.colors, ...b.textStyles].find((x) => x.id === style || x.name.toLowerCase() === style.toLowerCase());
    if (!hit) throw new Error(`No style "${style}". Styles: ${[...b.colors, ...b.textStyles].map((x) => x.name).join(", ") || "none yet"}.`);
    return text(await op("applyStyle", { nodeIds, styleId: hit.id, prop }));
  })
);
server.tool("list_components", "Components in this project (id, name, main layer id, how many instances).", {}, wrap(async () => text(await op("listComponents"))));
server.tool(
  "create_component",
  "Turn a layer or frame into a component. Instances follow it: edit the main layer and every instance updates (instances can still override text, images and colours).",
  { nodeId: z.string(), name: z.string().optional() },
  wrap(async (a) => text(await op("createComponent", a)))
);
server.tool(
  "create_instance",
  "Place an instance of a component into a frame or artboard. style: placement, e.g. {position:'absolute', left:'40px', top:'40px'}.",
  { componentId: z.string(), parentId: z.string(), index: z.number().optional(), style: z.record(z.string()).optional() },
  wrap(async (a) => text({ created: await op("createInstance", a) }))
);
server.tool("detach_instance", "Turn instances into plain layers (they stop following the component).", { nodeIds: ids }, wrap(async (a) => text(await op("detachInstance", a) ?? "ok")));

server.tool("undo", "Undo the last change.", {}, wrap(async () => text((await op("undo")) ? "undone" : "nothing to undo")));

server.tool(
  "get_screenshot",
  "PNG screenshot of the artboard containing nodeId (or of a specific node inside it). Use it to check your work.",
  { nodeId: z.string(), scale: z.number().optional().describe("1 or 2") },
  wrap(async ({ nodeId, scale = 1 }) => {
    await ensureServer();
    const r = await fetch(`${BASE}/api/screenshot?id=${encodeURIComponent(nodeId)}&scale=${scale}`);
    if (!r.ok) throw new Error((await r.json()).error);
    const buf = Buffer.from(await r.arrayBuffer());
    return { content: [{ type: "image", data: buf.toString("base64"), mimeType: "image/png" }] };
  })
);

server.tool(
  "export",
  "Save an artboard to a file. html: one standalone page. email: email-safe HTML (live tables and text; sections that tables can't express, like free-placed collages, become image slices with working links). email-zip: that email plus its images/ folder, for an ESP. eml: an unsent draft with inline images, to test-send from Outlook. png / jpg / webp: image at `scale` (1-4) and `quality` (jpg/webp). pdf: one page per artboard, exact size. slices: zip with each top-level section as an image. scope \"all\" exports every artboard (images, pdf as one multi-page file, html as zips). Returns the file path.",
  {
    nodeId: z.string().optional().describe("Artboard id (not needed with scope all)"),
    scope: z.enum(["one", "all"]).optional(),
    quality: z.number().optional(),
    format: z.enum(["html", "email", "email-zip", "eml", "png", "jpg", "webp", "pdf", "slices"]).optional(),
    fidelity: z.enum(["auto", "all-images", "tables-only"]).optional().describe("email only: auto (default) slices only what tables can't express; all-images slices every section; tables-only never uses images"),
    outPath: z.string().optional().describe("Absolute file path; default is ~/Downloads/<artboard name>.<ext>"),
    scale: z.number().optional(),
  },
  wrap(async ({ nodeId, scope = "one", quality = 90, format = "html", fidelity = "auto", outPath, scale = 2 }) => {
    await ensureServer();
    const info = await op("info");
    if (scope === "one" && !nodeId) throw new Error("Give a nodeId, or use scope \"all\".");
    const ab = info.artboards.find((a) => a.id === nodeId);
    const name = (scope === "all" ? "all-artboards" : ab ? ab.name : "design").replace(/[^\w\-]+/g, "-").replace(/^-+|-+$/g, "").toLowerCase();
    const ext = { html: ".html", email: "-email.html", "email-zip": "-email.zip", eml: ".eml", png: ".png", jpg: ".jpg", webp: ".webp", pdf: ".pdf", slices: "-slices.zip" }[format] + "";
    const isZip = scope === "all" && ["png", "jpg", "webp", "html"].includes(format);
    const file = outPath || path.join(process.env.HOME || ".", "Downloads", name + (isZip ? "-" + format + ".zip" : ext));
    const raster = { auto: "auto", "all-images": "all", "tables-only": "none" }[fidelity];
    const url = `${BASE}/api/export?${scope === "all" ? "scope=all" : "id=" + nodeId}&format=${format}&raster=${raster}&scale=${scale}&quality=${quality}`;
    const r = await fetch(url);
    if (!r.ok) throw new Error((await r.json()).error);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, Buffer.from(await r.arrayBuffer()));
    let warnings = [];
    try { warnings = JSON.parse(decodeURIComponent(r.headers.get("x-email-warnings") || "[]")); } catch {}
    return text({ saved: file, bytes: fs.statSync(file).size, ...(warnings.length ? { notes: warnings } : {}) });
  })
);

await server.connect(new StdioServerTransport());
