// MCP server: lets Claude read and edit the canvas. Starts the app server if it is not running yet.
// Every tool that works on a document takes an optional projectId, so Claude can work on any project without opening it.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { spawn } from "node:child_process";
import { AsyncLocalStorage } from "node:async_hooks";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { codeHash } from "./upkeep.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const PORT = Number(process.env.STUDIO_PORT || 4777);
const BASE = `http://127.0.0.1:${PORT}`;
const SOURCE = process.env.STUDIO_SOURCE || "mcp"; // "ask" when Ask Claude in the app runs us
const call = new AsyncLocalStorage();              // the projectId of the tool call being handled

async function alive() {
  try {
    return (await fetch(BASE + "/api/ping")).ok;
  } catch {
    return false;
  }
}
let greeted = false;
async function ensureServer() {
  if (!(await alive())) {
    const child = spawn(process.execPath, [path.join(here, "server.js")], { detached: true, stdio: "ignore", env: process.env });
    child.unref();
    let up = false;
    for (let i = 0; i < 40 && !up; i++) { await new Promise((r) => setTimeout(r, 150)); up = await alive(); }
    if (!up) throw new Error("Could not start the Studio server.");
  }
  if (!greeted) {
    greeted = true;
    // tell the app Claude is connected; a server still running older code from this same folder restarts itself
    try {
      const r = await (await fetch(BASE + "/api/op", { method: "POST", body: JSON.stringify({ op: "hello", args: { hash: codeHash(root), root, source: SOURCE } }) })).json();
      if (r.result && r.result.restarting) { await new Promise((res) => setTimeout(res, 1200)); for (let i = 0; i < 40 && !(await alive()); i++) await new Promise((res) => setTimeout(res, 150)); }
    } catch {}
  }
}
async function op(name, args = {}) {
  await ensureServer();
  const projectId = call.getStore()?.projectId;
  const r = await fetch(BASE + "/api/op", { method: "POST", body: JSON.stringify({ op: name, args, source: SOURCE, ...(projectId ? { projectId } : {}) }) });
  const j = await r.json();
  if (!r.ok) throw new Error(j.error || "Request failed");
  return j.result;
}
const projectQ = () => { const p = call.getStore()?.projectId; return p ? `&project=${encodeURIComponent(p)}` : ""; };
async function shot(nodeId, { scale = 1, pad = 0, region, state } = {}) {
  await ensureServer();
  const r = await fetch(`${BASE}/api/screenshot?id=${encodeURIComponent(nodeId)}&scale=${scale}${pad ? `&pad=${pad}` : ""}${region ? `&region=${[region.x, region.y, region.width, region.height].join(",")}` : ""}${state ? `&state=${state}` : ""}${projectQ()}`);
  if (!r.ok) throw new Error((await r.json()).error);
  return { type: "image", data: Buffer.from(await r.arrayBuffer()).toString("base64"), mimeType: "image/png" };
}

const text = (v) => ({ content: [{ type: "text", text: typeof v === "string" ? v : JSON.stringify(v, null, 2) }] });
const wrap = (fn) => async (args) => {
  args = args || {};
  try {
    return await call.run({ projectId: args.projectId }, () => fn(args));
  } catch (e) {
    return { isError: true, content: [{ type: "text", text: e.message }] };
  }
};

const GUIDE = `AI Studio: how to design here

Studio is a design canvas on the user's Mac. You design with these tools; the user watches the canvas live and can point at things.

Workflow
1. get_basic_info: the open project, its artboards, the user's selection and how many notes are waiting. New piece of work? create_project first.
   Work on another project without switching the user's window: pass projectId (see list_projects) to any tool.
2. get_brand, then create_artboard (pick a preset) and write_html into it. Or start from a template: list_templates / use_template.
3. Check your work: get_screenshot (zoom in with pad/region/scale), then critique, which lists concrete problems (overflowing or cut-off text,
   overlaps, low contrast, tiny text, blurry or heavy images, uneven spacing, off-brand colours and fonts, missing alt text, empty links). Fix them.
4. Tell the user what you made in one or two sentences. They keep or undo your changes from a bar in the app (every run of changes saves a version first).
5. Export when asked: html, email / email-zip / eml, png / jpg / webp (scale 1-4), pdf, slices; scope "all" for every artboard.

What the user points at
- get_selection returns what is selected in the editor, with a picture of it: "make this bigger" means those layers.
- Notes: the user pins requests to layers ("bolder", "swap this photo"). When they say "do my notes" (or similar), call get_requests, do each one,
  then resolve_request with a short reply. leave_note pins a note for the user (e.g. "needs a real product photo").

Making more
- make_variations copies an artboard (or the artboard holding a layer) into a row of variants; redesign each copy (focusId says which layer).
  The user picks one in the app (or call pick_variation).
- resize_to_formats makes copies of an artboard at other sizes (story, banner, ads…) as a starting point; then fix each with screenshots.
- save_template keeps an artboard for reuse in any project.

HTML rules (so the result exports cleanly as an email or page)
- Use inline style="" on every element. No <style> blocks, no classes, no scripts.
- Lay out with flexbox (display:flex, flex-direction, gap, align-items, justify-content). Prefer padding over margin.
- Set layer-name="Hero" on frames so the layers panel is readable.
- Images: place_image downloads a URL (e.g. from an image generator) or copies a local file into the project and places it, or swaps an existing image
  (replaceNodeId). In write_html, <img src="/absolute/local/path.jpg"> or an https URL also works.
- Icons: search_icons then insert_icon (Lucide line icons, any size and colour), instead of drawing them or using emoji.
- Fonts: use Google Fonts family names in font-family (e.g. 'Inter Tight', 'Caveat'); they load automatically. Custom fonts are in list_fonts.
- Absolute positioning works inside a position:relative parent: good for stickers and overlays.
- SVG is supported (kept as written).
- Text lives in span/p/h1-h6/div elements; to change text use set_text_content. Links: set_link (works on text, frames and images).

Brand, styles and components
- get_brand first: use the project's fonts and named colours instead of inventing. No brand yet and the user names a website? brand_from_url.
- apply_style links a layer to a colour or text style so a later change to the style updates it.
- Repeated pieces (cards, buttons, headers): create_component once, then create_instance. Edit the main layer and every instance follows.

Editing
- update_styles takes nodeIds and a styles object (null removes a property). On an artboard, left/top move it on the canvas.
- duplicate_nodes, move_nodes (new parent + index), delete_nodes, rename_nodes, reorder_nodes, group_nodes, set_hidden, set_locked.
- save_version before a big redesign if the user may want to compare; list_versions / restore_version go back.

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

const server = new McpServer({ name: "ai-studio", version: "0.2.0" });
const ids = z.array(z.string()).min(1);
// tools about projects as a whole don't take a projectId; every other tool can be pointed at any project
const GLOBAL = new Set(["get_guide", "list_projects", "open_project", "create_project", "rename_project", "duplicate_project", "trash_project", "list_trash", "restore_projects", "list_templates", "search_icons", "brand_from_url"]);
const tool = (name, desc, schema, handler) => server.tool(name, desc, GLOBAL.has(name) ? schema : { ...schema, projectId: z.string().optional().describe("Work on this project (id from list_projects) without opening it. Omit for the open project.") }, wrap(handler));

tool("get_guide", "How to use this design tool and the HTML conventions. Read once before designing.", {}, async () => text(GUIDE));

// ---- projects ----
tool("list_projects", "All design projects (each holds its own artboards), which one is open in the app, and how many notes wait in each.", {}, async () => text((await op("projects")).map(({ id, name, artboards, current, updated, kind, notes }) => ({ id, name, artboards, kind, open: current, notesWaiting: notes, edited: new Date(updated).toISOString() }))));
tool("open_project", "Switch the app to another project. The user's window follows. To work on a project without switching, pass projectId to the other tools instead.", { projectId: z.string() }, async ({ projectId }) => text(await op("openProject", { id: projectId })));
tool(
  "create_project",
  "Create a new project. By default it opens (the user's window switches to it). open:false creates it in the background. template: start from a saved template (list_templates).",
  { name: z.string(), open: z.boolean().optional(), template: z.string().optional() },
  async ({ name, open = true, template }) => text(await op("createProject", { name, open, template }))
);
tool("rename_project", "Rename a project (default: the open one).", { id: z.string().optional(), name: z.string() }, async (a) => text(await op("renameProject", a)));
tool("duplicate_project", "Copy a project (default: the open one). Returns the copy's id.", { id: z.string().optional(), name: z.string().optional() }, async (a) => text(await op("duplicateProject", a)));
tool("trash_project", "Move a project to the trash (it can be restored; nothing is erased).", { id: z.string() }, async ({ id }) => text((await op("deleteProject", { id })) ? "moved to the trash" : "nothing changed"));
tool("list_trash", "Projects in the trash.", {}, async () => text(await op("trash")));
tool("restore_projects", "Restore projects from the trash (entry or project ids from list_trash).", { ids: ids }, async (a) => text(await op("restoreProjects", a)));

tool("get_basic_info", "Project, canvas URL, all artboards (id, name, size, position), the user's current selection and how many notes are waiting.", {}, async () => text(await op("info")));
tool("get_tree_summary", "Indented outline of an artboard or node: id, name, tag, nested to a depth.", { nodeId: z.string().optional().describe("Omit for all artboards"), depth: z.number().optional() }, async (a) => text(await op("tree", a)));
tool("get_children", "List the direct children of a node (or the artboards when nodeId is omitted).", { nodeId: z.string().optional() }, async (a) => text(await op("children", a)));
tool("get_node_info", "Styles, attributes, link and HTML of one node.", { nodeId: z.string() }, async (a) => text(await op("node", a)));

tool("get_selection", "What the user has selected in the editor right now: each layer's id, name, styles and HTML, plus a picture of it (up to 3).", {}, async () => {
  const info = await op("info");
  const out = [];
  for (const id of info.selection) out.push(await op("node", { nodeId: id }).catch(() => null));
  const list = out.filter(Boolean);
  if (!list.length) return text("Nothing is selected.");
  const content = [{ type: "text", text: JSON.stringify(list.map((n) => ({ id: n.id, name: n.name, tag: n.tag, artboard: n.artboard, style: n.style, ...(n.link ? { link: n.link } : {}), html: n.html.slice(0, 1500) })), null, 2) }];
  for (const n of list.slice(0, 3)) { try { content.push(await shot(n.id, { pad: 8 })); } catch {} }
  return { content };
});

const PRESETS = {
  email: [600], "instagram-post": [1080, 1080], "instagram-portrait": [1080, 1350], story: [1080, 1920], tiktok: [1080, 1920], "facebook-post": [1200, 630], "linkedin-post": [1200, 627], "x-post": [1600, 900], "youtube-thumbnail": [1280, 720], "pinterest-pin": [1000, 1500],
  "ad-300x250": [300, 250], "ad-728x90": [728, 90], "ad-300x600": [300, 600], "ad-160x600": [160, 600], "ad-970x250": [970, 250], "ad-320x50": [320, 50], "ad-320x100": [320, 100],
  "slide-16x9": [1920, 1080], "slide-4x3": [1024, 768], desktop: [1440, 900], laptop: [1280, 800], tablet: [768, 1024], mobile: [390, 844], a4: [794, 1123], letter: [816, 1056], "business-card": [1050, 600],
};
tool(
  "create_artboard",
  "Create a named artboard. Pick a preset (instagram-post, story, ad-300x250, slide-16x9, a4, email …; see get_guide) or give width/height in px. Omit height to grow with content.",
  { name: z.string().describe("Artboard name"), preset: z.enum(Object.keys(PRESETS)).optional(), width: z.number().optional(), height: z.number().optional(), backgroundColor: z.string().optional() },
  async ({ backgroundColor, preset, projectId, ...a }) => {
    if (preset) { const [w, h] = PRESETS[preset]; a.width = a.width || w; if (h && !a.height) a.height = h; }
    return text(await op("createArtboard", { ...a, style: backgroundColor ? { "background-color": backgroundColor } : {} }));
  }
);
tool(
  "write_html",
  "Add HTML into an artboard/frame (insert-children) or swap a node for new HTML (replace). Inline styles and flexbox; see get_guide.",
  { targetNodeId: z.string(), html: z.string(), mode: z.enum(["insert-children", "replace"]).optional(), index: z.number().optional().describe("Position among children for insert-children; default is the end") },
  async (a) => text({ created: await op("insert", { parentId: a.targetNodeId, html: a.html, mode: a.mode, index: a.index }) })
);
tool(
  "update_styles",
  "Change CSS on nodes. styles is {property: value}; null removes. camelCase or kebab-case. On an artboard, left/top move it on the canvas.",
  { updates: z.array(z.object({ nodeIds: ids, styles: z.record(z.union([z.string(), z.number(), z.null()])) })) },
  async (a) => text({ updated: await op("updateStyles", { updates: a.updates }) })
);
tool("set_attributes", "Set attributes such as src or alt on a node (null removes). For links use set_link.", { nodeId: z.string(), attrs: z.record(z.union([z.string(), z.null()])) }, async (a) => text((await op("setAttrs", { nodeId: a.nodeId, attrs: a.attrs })) ?? "ok"));
tool("set_text_content", "Replace the text of a node.", { nodeId: z.string(), text: z.string() }, async (a) => text((await op("setText", { nodeId: a.nodeId, text: a.text })) ?? "ok"));
tool("set_link", "Make a layer a link (text, frame, button or image), change its address, or remove it (href null).", { nodeId: z.string(), href: z.string().nullable() }, async (a) => text(await op("setLink", { nodeId: a.nodeId, href: a.href })));
tool("rename_nodes", "Rename layers or artboards.", { items: z.array(z.object({ nodeId: z.string(), name: z.string() })) }, async (a) => text((await op("rename", { items: a.items })) ?? "ok"));
tool("delete_nodes", "Delete nodes or artboards.", { nodeIds: ids }, async (a) => text((await op("remove", { nodeIds: a.nodeIds })) ?? "ok"));
tool("duplicate_nodes", "Duplicate nodes or artboards.", { nodeIds: ids }, async (a) => text({ created: await op("duplicate", { nodeIds: a.nodeIds }) }));
tool("move_nodes", "Move a node into a parent at an index (reorder or reparent). To reposition an artboard use update_styles left/top.", { nodeId: z.string(), parentId: z.string(), index: z.number().optional() }, async (a) => text((await op("move", { nodeId: a.nodeId, parentId: a.parentId, index: a.index })) ?? "ok"));
tool(
  "reorder_nodes",
  "Change the stacking order of layers that share a parent: front, back, forward or backward (later siblings paint on top). One undo step. Prefer this to move_nodes for plain z-order changes.",
  { nodeIds: ids, to: z.enum(["front", "back", "forward", "backward"]) },
  async (a) => text((await op("reorder", { nodeIds: a.nodeIds, to: a.to })) ? "ok" : "already there")
);
tool(
  "group_nodes",
  "Group sibling nodes into one frame (layer 'Group'). The group moves and selects as a unit in the editor; the user double-clicks to reach the layers inside. Nodes must share a parent.",
  { nodeIds: ids },
  async (a) => text({ group: await op("group", { nodeIds: a.nodeIds }) })
);
tool("ungroup_nodes", "Dissolve frames or groups: their children move up into the parent. Absolutely positioned children keep their place.", { nodeIds: ids }, async (a) => text({ freed: await op("ungroup", { nodeIds: a.nodeIds }) }));
tool(
  "split_text_from_box",
  "Split a text element that has its own background/border/padding (a button) into a box with a separate text layer inside, so the text can be moved and edited on its own.",
  { nodeId: z.string(), width: z.number().optional(), height: z.number().optional() },
  async (a) => text({ text: await op("splitText", { nodeId: a.nodeId, width: a.width, height: a.height }) })
);
tool("set_hidden", "Hide or show layers (hidden layers are left out of exports).", { nodeIds: ids, hidden: z.boolean() }, async (a) => text((await op("setHidden", { nodeIds: a.nodeIds, hidden: a.hidden })) ?? "ok"));
tool("set_locked", "Lock layers so they can't be selected or moved on the canvas by accident (e.g. a background), or unlock them.", { nodeIds: ids, locked: z.boolean() }, async (a) => text({ locked: a.locked, nodeIds: await op("setLocked", { nodeIds: a.nodeIds, locked: a.locked }) }));
tool(
  "set_auto_layout",
  "Turn auto layout on or off for a frame: on, it lays its layers out in a row or column (use update_styles for flex-direction, gap, padding, alignment); off, its layers are placed freely.",
  { nodeId: z.string(), auto: z.boolean() },
  async (a) => text((await op("setAutoLayout", { nodeId: a.nodeId, auto: a.auto })) ?? "ok")
);
tool("set_guides", "Set an artboard's ruler guides: [{axis:'x'|'y', at:px}].", { nodeId: z.string(), guides: z.array(z.object({ axis: z.enum(["x", "y"]), at: z.number() })) }, async (a) => text(await op("setGuides", { nodeId: a.nodeId, guides: a.guides.map((g) => ({ a: g.axis, p: g.at })) })));

// ---- seeing the result ----
tool(
  "get_screenshot",
  "PNG of the artboard containing nodeId, or of a node inside it. Zoom in on details with scale (up to 4), pad (px of context around the node) or region ({x,y,width,height} inside the node). state 'before' shows how it looked before your current run of changes.",
  { nodeId: z.string(), scale: z.number().optional().describe("0.5 to 4"), pad: z.number().optional(), region: z.object({ x: z.number(), y: z.number(), width: z.number(), height: z.number() }).optional(), state: z.enum(["now", "before"]).optional() },
  async ({ nodeId, scale = 1, pad, region, state }) => ({ content: [await shot(nodeId, { scale, pad, region, state: state === "before" ? "before" : undefined })] })
);
tool(
  "critique",
  "Review an artboard like a design lead: renders it and lists concrete problems with the layer each is on (overflowing or cut-off text, overlapping text, low contrast, text too small for the format, blurry or heavy images, uneven spacing, off-brand fonts/colours, missing alt text, empty links, placeholder copy). Run it after building or changing something, then fix the high and medium issues.",
  { nodeId: z.string().optional().describe("Any node of the artboard; default the first artboard") },
  async (a) => {
    const r = await op("critique", { nodeId: a.nodeId });
    if (!r.issues.length) return text(`“${r.artboard.name}”: no problems found.`);
    return text({ artboard: r.artboard, summary: r.summary, issues: r.issues.map(({ severity, kind, nodeId, name, message }) => ({ severity, kind, nodeId, name, message })) });
  }
);

// ---- notes: what the user pinned for you, and notes you leave them ----
tool("get_requests", "The user's open notes: requests pinned to layers in the editor (\"make this bolder\"). Each has the layers it points at and a picture of them. Do them, then resolve_request each.", { includeDone: z.boolean().optional() }, async ({ includeDone }) => {
  const list = (await op("notes", includeDone ? {} : { status: "open" })).filter((n) => n.author !== "claude" || includeDone);
  if (!list.length) return text("No open notes.");
  const content = [{ type: "text", text: JSON.stringify(list.map((n) => ({ id: n.id, text: n.text, status: n.status, created: new Date(n.created).toISOString(), layers: n.targets })), null, 2) }];
  let pics = 0;
  for (const n of list) { const t = n.targets.find((x) => !x.missing); if (t && pics < 4) { try { content.push({ type: "text", text: `Note ${n.id} points at:` }, await shot(t.id, { pad: 12 })); pics++; } catch {} } }
  return { content };
});
tool("resolve_request", "Mark a note as done, with a short reply the user sees on the canvas (what you changed).", { id: z.string(), reply: z.string() }, async (a) => text(await op("resolveNote", { id: a.id, reply: a.reply })));
tool("leave_note", "Pin a note for the user to layers (something they need to decide or provide, e.g. 'needs a real product photo').", { nodeIds: z.array(z.string()), text: z.string() }, async (a) => text(await op("addNote", { nodeIds: a.nodeIds, text: a.text, author: "claude" })));

// ---- images and icons ----
tool(
  "place_image",
  "Put an image on the canvas: src is a local file path, an https URL (e.g. a generated image) or a data: URL; it's copied into the project so it works offline. Either insert it into parentId (style for placement/size, e.g. {position:'absolute', left:'0px', top:'0px', width:'1080px', height:'1080px', objectFit:'cover'}) or swap the picture of an existing image layer with replaceNodeId.",
  { src: z.string(), parentId: z.string().optional(), replaceNodeId: z.string().optional(), style: z.record(z.string()).optional(), name: z.string().optional(), alt: z.string().optional(), index: z.number().optional() },
  async ({ projectId, ...a }) => text(await op("placeImage", a))
);
tool("search_icons", "Search the built-in icon library (Lucide line icons) by name or keyword, e.g. 'arrow right', 'shopping cart', 'check'.", { query: z.string(), limit: z.number().optional() }, async (a) => text(await op("searchIcons", a)));
tool(
  "insert_icon",
  "Insert a library icon (name from search_icons) as an SVG layer into parentId, at size px in colour (its line colour). style for placement, e.g. {position:'absolute', left:'40px', top:'40px'}.",
  { name: z.string(), parentId: z.string(), size: z.number().optional(), color: z.string().optional(), strokeWidth: z.number().optional(), style: z.record(z.string()).optional(), index: z.number().optional() },
  async ({ projectId, ...a }) => text({ created: await op("insertIcon", a) })
);

// ---- more versions of a design ----
tool(
  "make_variations",
  "Copy an artboard (or the artboard holding nodeId) count times into a row, tagged as one set of variations. Returns each copy and, when nodeId is a layer, the id of that layer in each copy (focusId) for you to redesign. The user picks one in the app; pick_variation does it for them.",
  { nodeId: z.string(), count: z.number().optional().describe("1-8, default 3") },
  async (a) => text(await op("makeVariants", { nodeId: a.nodeId, count: a.count }))
);
tool("pick_variation", "Keep one artboard of a set of variations (it takes the original's place and name); the other copies are removed.", { nodeId: z.string() }, async (a) => text(await op("pickVariant", { nodeId: a.nodeId })));
tool(
  "resize_to_formats",
  "Make copies of an artboard at other sizes, e.g. a post as a story and banners. Free-placed layers keep their place relative to the frame and everything scales evenly: a starting point. Screenshot each copy and fix the layout after. Use presets (names from create_artboard) and/or sizes.",
  { nodeId: z.string(), presets: z.array(z.enum(Object.keys(PRESETS))).optional(), sizes: z.array(z.object({ width: z.number(), height: z.number().optional(), name: z.string().optional() })).optional() },
  async ({ nodeId, presets = [], sizes = [] }) => {
    const all = [...presets.map((p) => ({ width: PRESETS[p][0], height: PRESETS[p][1], name: undefined, preset: p })), ...sizes];
    if (!all.length) throw new Error("Give presets or sizes.");
    const info = await op("info"), ab = info.artboards.find((a) => a.id === nodeId);
    return text({ created: await op("resizeArtboard", { nodeId, sizes: all.map((s) => ({ width: s.width, height: s.height, name: s.name || (s.preset && ab ? `${ab.name} · ${s.preset}` : undefined) })) }) });
  }
);

// ---- templates ----
tool("list_templates", "Saved templates (artboards kept for reuse in any project).", {}, async () => text(await op("listTemplates")));
tool("save_template", "Save an artboard as a template (with its images and fonts) to reuse in any project.", { nodeId: z.string(), name: z.string().optional() }, async (a) => text(await op("saveTemplate", { nodeId: a.nodeId, name: a.name })));
tool("use_template", "Add a template's artboard to the project, placed to the right of the existing ones.", { templateId: z.string(), name: z.string().optional() }, async (a) => text(await op("useTemplate", { templateId: a.templateId, name: a.name })));

// ---- design system ----
tool("get_brand", "The project's brand kit: name, fonts (heading/body/mono), colours with their names, text styles, components. Call this before designing and use these values, not invented ones.", {}, async () => text(await op("getBrand")));
tool(
  "set_brand",
  "Set the project's brand kit. fonts: Google Fonts family names. colors: named colours (same name = update). logo: a local file path or URL.",
  { name: z.string().optional(), fonts: z.object({ heading: z.string().optional(), body: z.string().optional(), mono: z.string().optional() }).optional(), colors: z.array(z.object({ name: z.string(), value: z.string() })).optional(), logo: z.string().optional(), notes: z.string().optional() },
  async ({ projectId, ...a }) => text(await op("setBrand", a))
);
tool(
  "brand_from_url",
  "Read a brand from a website: name, logo, main colours and fonts (heuristics over the page and its stylesheets). apply:true also sets it as the project's brand kit (pass projectId for another project).",
  { url: z.string(), apply: z.boolean().optional(), projectId: z.string().optional() },
  async ({ url, apply }) => text(apply ? await op("setBrandFromUrl", { url }) : await op("brandFromUrl", { url }))
);
tool(
  "create_style",
  "Create a colour style (value, e.g. #46DE46) or a text style (css: font-family, font-size, font-weight, line-height, letter-spacing, text-transform; or copy it from a layer with nodeId).",
  { kind: z.enum(["color", "text"]), name: z.string(), value: z.string().optional(), css: z.record(z.string()).optional(), nodeId: z.string().optional() },
  async ({ projectId, ...a }) => text(await op("createStyle", a))
);
tool(
  "apply_style",
  "Link a layer to a style, by style name. Changing the style later updates the layer. Colour styles apply to background-color (default), color or border-color.",
  { nodeIds: ids, style: z.string().describe("style name or id"), prop: z.enum(["background-color", "color", "border-color"]).optional() },
  async ({ nodeIds, style, prop }) => {
    const b = await op("getBrand");
    const hit = [...b.colors, ...b.textStyles].find((x) => x.id === style || x.name.toLowerCase() === style.toLowerCase());
    if (!hit) throw new Error(`No style "${style}". Styles: ${[...b.colors, ...b.textStyles].map((x) => x.name).join(", ") || "none yet"}.`);
    return text(await op("applyStyle", { nodeIds, styleId: hit.id, prop }));
  }
);
tool("list_components", "Components in this project (id, name, main layer id, how many instances).", {}, async () => text(await op("listComponents")));
tool(
  "create_component",
  "Turn a layer or frame into a component. Instances follow it: edit the main layer and every instance updates (instances can still override text, images and colours).",
  { nodeId: z.string(), name: z.string().optional() },
  async (a) => text(await op("createComponent", { nodeId: a.nodeId, name: a.name }))
);
tool(
  "create_instance",
  "Place an instance of a component into a frame or artboard. style: placement, e.g. {position:'absolute', left:'40px', top:'40px'}.",
  { componentId: z.string(), parentId: z.string(), index: z.number().optional(), style: z.record(z.string()).optional() },
  async ({ projectId, ...a }) => text({ created: await op("createInstance", a) })
);
tool("detach_instance", "Turn instances into plain layers (they stop following the component).", { nodeIds: ids }, async (a) => text((await op("detachInstance", { nodeIds: a.nodeIds })) ?? "ok"));
tool("list_fonts", "Custom fonts uploaded to this project (use them by family name in font-family).", {}, async () => text(await op("listFonts")));

// ---- history ----
tool("list_versions", "Saved versions of the project (named ones, automatic ones, and the one saved before each run of your changes).", {}, async () => text(await op("historyList")));
tool("save_version", "Save the project as a named version (a milestone the user can go back to).", { name: z.string() }, async (a) => text(await op("historySave", { name: a.name })));
tool("restore_version", "Go back to a saved version (the current state is saved as a version first, and ⌘Z undoes the restore).", { id: z.string() }, async (a) => text((await op("historyRestore", { id: a.id })) ? "restored" : "nothing changed"));
tool("undo", "Undo the last change.", {}, async () => text((await op("undo")) ? "undone" : "nothing to undo"));
tool("redo", "Redo the last undone change.", {}, async () => text((await op("redo")) ? "redone" : "nothing to redo"));

tool(
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
  async ({ nodeId, scope = "one", quality = 90, format = "html", fidelity = "auto", outPath, scale = 2 }) => {
    await ensureServer();
    const info = await op("info");
    if (scope === "one" && !nodeId) throw new Error("Give a nodeId, or use scope \"all\".");
    const ab = info.artboards.find((a) => a.id === nodeId);
    const name = (scope === "all" ? "all-artboards" : ab ? ab.name : "design").replace(/[^\w\-]+/g, "-").replace(/^-+|-+$/g, "").toLowerCase();
    const ext = { html: ".html", email: "-email.html", "email-zip": "-email.zip", eml: ".eml", png: ".png", jpg: ".jpg", webp: ".webp", pdf: ".pdf", slices: "-slices.zip" }[format] + "";
    const isZip = scope === "all" && ["png", "jpg", "webp", "html"].includes(format);
    const file = outPath || path.join(process.env.HOME || ".", "Downloads", name + (isZip ? "-" + format + ".zip" : ext));
    const raster = { auto: "auto", "all-images": "all", "tables-only": "none" }[fidelity];
    const url = `${BASE}/api/export?${scope === "all" ? "scope=all" : "id=" + nodeId}&format=${format}&raster=${raster}&scale=${scale}&quality=${quality}${projectQ()}`;
    const r = await fetch(url);
    if (!r.ok) throw new Error((await r.json()).error);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, Buffer.from(await r.arrayBuffer()));
    let warnings = [];
    try { warnings = JSON.parse(decodeURIComponent(r.headers.get("x-email-warnings") || "[]")); } catch {}
    return text({ saved: file, bytes: fs.statSync(file).size, ...(warnings.length ? { notes: warnings } : {}) });
  }
);

await server.connect(new StdioServerTransport());
// say hello right away, so the app shows Claude as connected (and an outdated server restarts) before the first tool call
ensureServer().catch(() => {});
