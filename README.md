# AI Studio

A local AI design studio. You ask Claude in your chat (Claude Code) and it designs on this canvas through MCP, live:
social posts, emails, decks, ads, posters, web pages. You point at things to change them, pin notes for Claude, try
variations side by side, and keep or undo every run of Claude's changes. Layers, inspector, artboards, components,
templates, and exports to HTML, email, PNG/JPG/WebP and PDF.

No accounts, no cloud, no API keys, no telemetry. Node.js 20+ and the Chrome you already have.

## Install and run

```bash
cd studio
npm install
npm start          # http://127.0.0.1:4777
```

Open <http://127.0.0.1:4777>. Projects live in `~/Library/Application Support/Studio/projects/`, one folder each
(`doc.json` + `assets/` + `meta.json`); the Mac app, `npm start` and Claude all share them. The first run adds the demo.
Other folder: `STUDIO_PROJECTS=/path npm start`. Pin a single project (tests): `STUDIO_PROJECT=/path/to/folder`. Port: `STUDIO_PORT=4800`.

### The Mac app

```bash
npm run make-app   # → ~/Applications/Studio.app
```

A native window (Swift + WebKit, `mac/Studio.swift`) with its own Dock icon and menu bar (File → New Project ⌘N, All Projects ⇧⌘H,
Show Projects in Finder; View → Present ⌥⌘P, Full Screen). Exports open a Save dialog, Image opens a file picker. It bundles a copy of
the code, starts the server (or reuses one Claude already started) and stops it on quit. Rebuild after changing the code.
Needs Node and the Xcode Command Line Tools (`xcode-select --install`); without the Swift compiler it falls back to a Chrome app window.

## Connect Claude Code

```bash
claude mcp add ai-studio -- node "/absolute/path/to/studio/server/mcp.js"
```

The MCP server starts the app server by itself if it isn't running, so you never have to run `npm start` first.
Then ask Claude things like *"create a 600px welcome email called Welcome email and show me a screenshot"*, or select
something on the canvas and say *"make this bigger"* (Claude reads your selection with `get_selection`).

Screenshots and PNG export use your installed Chrome (Chrome, Chromium and Edge are auto-detected on macOS;
set `CHROME_PATH` to override). Nothing is downloaded.

### How you work with Claude

- **Ask in the chat.** "Create a 1080×1080 post announcing our summer sale", "make a story and three ad sizes from it",
  "read the brand from example.com". Claude builds it in Studio while you watch; layers it touches flash violet and the
  chip in the top bar says what it's doing.
- **Keep or undo.** When Claude pauses, a bar says how many changes it made: **Keep** or **Undo** (back to before the run,
  one ⌘Z step). Every run saves a version first ("Before Claude's changes" in History).
- **Point at things.** Select layers and Claude sees them (`get_selection`, with a picture). Or press **N** to pin a note
  ("make this bolder"), then say **"do my notes"** in the chat: Claude does each one and replies on the note.
- **Quick actions in the app.** The bar above the tools works on your selection: **Edit** (type a request), **Variations**
  (2–4 different versions side by side; *Use this* keeps one), **Note**, **Review** (an artboard's problems, with
  *Ask Claude to fix*), and for images **Remove BG** / **Upscale** (Claude with your Magnific connector). These run
  Claude Code on your own login.
- **Background work.** Claude can work on any project without switching your window (every tool takes a `projectId`);
  a notice offers to open it.

### MCP tools

Projects: `list_projects`, `open_project`, `create_project` (also in the background, or from a template), `rename_project`,
`duplicate_project`, `trash_project`, `list_trash`, `restore_projects`.
Reading: `get_guide`, `get_basic_info`, `get_tree_summary`, `get_children`, `get_node_info`, `get_selection`,
`get_screenshot` (zoom with `scale`/`pad`/`region`, `state: "before"` for before/after), `critique`.
Building: `create_artboard`, `write_html`, `update_styles`, `set_attributes`, `set_text_content`, `set_link`, `rename_nodes`,
`delete_nodes`, `duplicate_nodes`, `move_nodes`, `reorder_nodes`, `group_nodes`, `ungroup_nodes`, `split_text_from_box`,
`set_hidden`, `set_locked`, `set_auto_layout`, `set_guides`, `place_image`, `search_icons`, `insert_icon`.
More versions: `make_variations`, `pick_variation`, `resize_to_formats`, `save_template`, `list_templates`, `use_template`.
Notes: `get_requests`, `resolve_request`, `leave_note`.
Brand and system: `get_brand`, `set_brand`, `brand_from_url`, `create_style`, `apply_style`, `list_components`,
`create_component`, `create_instance`, `detach_instance`, `list_fonts`.
History and output: `list_versions`, `save_version`, `restore_version`, `undo`, `redo`, `export`.

A test (`agent-test.mjs`) fails when an app operation has no tool, so Claude can always do what you can.

Images can be absolute local paths (spaces are fine), `file://`, `paper-asset://`, `https://` or `data:` URLs.
Local files are copied into `assets/` (deduplicated by content).

## Using the editor

| | |
|---|---|
| Pan | trackpad scroll, Space+drag, or drag empty canvas |
| Zoom | pinch or ⌘+scroll (around the cursor), ⌘+ / ⌘−, ⌘0 fits everything |
| Select | click (deepest element), Shift-click adds, Esc clears, Alt+↑ selects the parent |
| Home | the app opens on your projects: live thumbnails, search, open / rename / duplicate / move to trash (right-click or •••). **Start something new** makes a project with an Instagram post, story, presentation, email, ad, YouTube thumbnail or A4 poster artboard. The grid button (⇧⌘H) goes back home; click the project name to rename it |
| Tools | the floating bar at the bottom: Move V, Frame F, Rectangle R, Oval O, Text T, Image I, + Artboard |
| Right-click | on a layer: copy, paste, duplicate, delete, crop / replace image, edit text, bring to front / forward, send backward / to back, group, hide, rename, select parent. On an artboard: rename, duplicate, export, present, delete. On empty canvas: paste, new artboard, zoom to fit |
| Move | click inside any layer and drag: **everything is free**. Nothing reflows. The first time a layer in a layout moves (or is resized, nudged or aligned), its neighbours are pinned exactly where they are, so no layer ever jumps into a gap; one undo puts it all back. Pink guides snap to the parent's and siblings' edges and centres; the **Snap** button in the top bar (or holding ⌘) turns that off. Arrow keys nudge 1px, Shift+arrow 10px. Artboards: drag their title |
| Groups | **⌘G** groups the selected layers into one frame that moves, resizes and selects as a unit; **⇧⌘G** ungroups, and everything stays exactly where it was. **Double-click a group to go inside**: the layer under the cursor is selected (text is edited), and you can move it on its own. Also in the right-click menu and under Align in the inspector |
| Buttons | a button is one element with a background and text, so its text couldn't be moved on its own. Right-click → **Separate text from box** (or the inspector button) splits it into a box with a text layer inside: the button looks identical, and the text can be edited and moved separately |
| Preview | the eye button in the top bar (⌥⌘E, View → Preview Email…, or right-click an artboard). **Desktop** shows a mail window, **Mobile** a phone; either way the email is laid out at its real width and scaled to the screen it's shown on (a 1080px artboard fits the window instead of being cut off). **Design** shows the artboard exactly as you drew it; **Email-safe** shows the table-based export, i.e. what Gmail and Outlook can really show. A note explains when free-placed layers will be stacked by email apps |
| Theme | the sun / moon button in the top bar cycles **Auto** (follows macOS), **Light** and **Dark**. The whole editor, the home screen, menus and the preview change; your artboards keep their own colours. In the Mac app the title bar follows too (View → Switch Theme, ⇧⌘L) |
| Side panels | drag the edge of the Layers or Design panel to resize it (double-click the edge to reset). The chevron in each panel header collapses it to a thin rail, click the rail to bring it back; dragging an edge past its minimum collapses it too. **⌘\\** hides or shows both (View → Hide / Show Side Panels). Widths and the collapsed state are remembered |
| Select | click; Shift-click to add. Drag on the empty canvas to box-select artboards, or on an artboard's background to box-select its layers. Pan with Space+drag, the middle button, or scrolling |
| Copy / paste | **⌘C / ⌘V** copy layers and paste them next to the original (or into the selected frame); ⌘D duplicates |
| Fill | Solid / Linear / Radial. Drag gradient stops along the bar, set the angle, add or remove stops |
| Effects | blur, brightness, contrast, saturation, grayscale and hue sliders (CSS filters), blend mode, clip content, shadow, radius |
| Images | double-click an image to **crop**: drag the picture inside its frame, drag the edges to change the crop, Enter or Esc to finish. Crop-to buttons: 1:1, 4:5, 16:9, 9:16. Replace… swaps the file |
| Present | plays the artboards full screen as slides (top to bottom, left to right); ← → or click to move, Esc to leave |
| Draw | **R** rectangle, **O** oval, **T** text (click, then type), **F** frame: drag on the canvas. Esc or **V** goes back to Move |
| Align | the bar at the top of the inspector aligns the selection to its parent (one element) or to each other (several), and distributes three or more evenly |
| Measure | hold **Alt** and point at another element to see the pixel distances to the selection |
| Layer order | the Layers panel lists the **front-most layer first**, like Figma. **⌘]** brings forward one step, **⌘[** sends backward, with Shift for the very front / back; works on several layers at once (they keep their order) and is one undo step. Also in the right-click menu and by dragging rows: above a row = in front of it. Claude has `reorder_nodes` for the same |
| Resize | drag the blue edge itself or the dots: 4 edges and 8 handles for absolute elements, east/south edges and east/south/south-east dots for elements in the flow and artboards. Shift on a corner keeps the aspect ratio |
| Edit text | double-click, Enter commits, Esc cancels. Works for text with inline formatting too (`<b>`, `<a>`, `<span>`…), which keeps it |
| Images | paste, drop a file on the canvas, double-click an image to replace it |
| Artboards | `+ Artboard` with presets: email, Instagram post / portrait / story, TikTok, Facebook, LinkedIn, X, YouTube thumbnail, Pinterest, IAB ad sizes, 16:9 and 4:3 slides, desktop / tablet / mobile, A4, Letter, business card, poster. Double-click the title to rename, ⌘D duplicates |
| Ask Claude | the sparkle button (⌘K) opens a panel: type what you want (“make the headline punchier”), or use a quick chip. Claude works on the layers you have selected (or the whole project), you watch it edit the canvas live, and **Undo this run** reverts everything it changed in one step. It runs the `claude` command with only the Studio tools, on **your own Claude login**: nothing is stored here and no API key is needed. Without Claude Code installed the panel says so |
| Export | **Export…** (⇧⌘E) picks this artboard or all of them, and PNG / JPG / WebP at 1–4× (JPG and WebP with a quality slider), **PDF** (one page per artboard, each exactly its size, text stays selectable), **Slices** (every top-level section as its own image, in a zip) or HTML. Email formats stay in the Export menu |
| Versions | the clock button: **Save version** (with a name) for a milestone; Studio also saves one automatically about every 10 minutes while you work (the last 40 are kept). **Restore** goes back; your current design is saved as a version first and ⌘Z undoes the restore. Versions live in the project's `history/` folder |
| Fonts | Assets → Fonts → ＋ uploads a .woff2 / .woff / .ttf / .otf file (one file per weight, same name for the same family). It's saved in the project, used by typing its name in a Font field, and embedded in HTML exports, PNG/PDF and screenshots. Google Fonts are cached on this Mac after first use, so designs keep their fonts offline |
| Tooltips | hover any icon-only button for a moment and a small label names it (with its shortcut); moving along a toolbar shows the next one quickly |
| Notes | select layers, press **N**, write the request: a numbered pin sits on the layer. The **Notes** tab (or the note button in the top bar) lists them; Claude's replies and the notes Claude leaves you (violet ✦) show there too |
| Lock | the lock in a layer's row (or right-click → Lock): locked layers can't be clicked or dragged on the canvas, so a background stays put |
| Link | the **Link** field in the Design panel makes any text, frame, button or image a link |
| Variations | the selection bar or right-click → Variations…: copies in a row, each with *Use this* under it; the original has *Keep original* / *Discard all* |
| Formats | right-click an artboard → **Resize to formats…**: copies at other sizes (story, banner, ads, slides…) placed to the right |
| Templates | right-click an artboard → **Save as template…**. Start from one on the home screen (Templates), or under **+ Artboard** |
| Icons | Assets → Icons: search 1,500 line icons (Lucide, offline) and click to add one |
| Brand | Assets → Brand → **From website…** reads a site's name, colours, fonts and logo into the brand kit |
| Settings | the gear on the home screen: Claude's connection and the command to connect it, daily backups (folder, how many to keep, Back up now), and the app's code version |
| Other | Delete removes, ⌘Z / ⇧⌘Z undo/redo (shared with Claude), ⌘G groups |

**Email HTML** exports email-safe markup: flex layouts become nested tables, gaps become cell padding, backgrounds/radius/padding move onto `<td>`, buttons become table buttons. Absolute positioning and grid can't exist in email and are reported in a comment at the top. `export` with `format: "email"` does the same from MCP.

**Download HTML** saves the selected artboard (or the first) as one file: doctype, charset, viewport, `<title>`,
Google Fonts link, inline styles only, every image embedded as base64 (local and remote). Hidden layers are left out.

## First design

```bash
npm run demo
```

Builds "Welcome email" (600px: header, hero image, headline, CTA button) through the MCP tools and writes
`demo/welcome-email.png`. Open the app afterwards and it is there to edit.

## Tests

```bash
npm test
```

- `test/mcp-test.mjs` calls every MCP tool over stdio against a throwaway project: app-server auto-start, images, undo, html/email/png export.
- `test/editor-test.mjs` drives the editor in headless Chrome: selection, inspector focus, text editing, flow / absolute / artboard / layers drags, undo/redo, image drop, and opens the downloaded HTML with the network off.
- `test/ask-test.mjs` + `editor10-test.mjs`: Ask Claude with a fake `claude` (nothing is spent): streaming, plain-language steps, undo, stop, failure, not installed; plus the export dialog, version history and font upload in the editor.
- `test/exports-test.mjs`: PNG/JPG/WebP pixel sizes, PDF page sizes, slices, all-artboard zips. `history-test.mjs`: save / automatic / restore / undo. `fonts-test.mjs`: custom fonts in renders, HTML and PDF; the Google Fonts cache.
- `test/vector-test.mjs`, `spacing-test.mjs`, `canvas-features-test.mjs`, `editor9-test.mjs`: pen paths, spacing guides, rulers / guides / grid, auto layout, rotation, crop zoom, point editing.
- `test/editor7-test.mjs`: dark mode (cycle, remember, follow the system, home and menus), resizing / collapsing / ⌘\\ for the side panels, Design vs Email-safe preview, wide artboards fitting the preview.
- `test/editor6-test.mjs`: nothing reflows when you move, groups (⌘G, drag, double-click in, edit text inside, ungroup, undo, menu), separating a button's text, the desktop and mobile email preview.
- `test/editor5-test.mjs`: home screen, new-from-preset, project rename / duplicate / trash / search, live thumbnails, project switching by Claude, right-click / export / zoom menus, the bottom toolbar.
- `test/editor4-test.mjs`: presets, the sliding Flow reorder, gradients (stops, angle, radial), solid fill, effects, image crop and ratios, copy/paste, box select, Present.
- `test/editor3-test.mjs`: free drag with centre guides, edge resizing, the R/O/T/F draw tools, align and distribute, layer order, Alt measuring.
- `test/agent-test.mjs`: Claude's side over MCP: every operation has a tool, background projects, runs (version first, keep / undo, refusing after your edits), notes, links, locking, images, icons, resize, variations, templates, critique, brand from a website, zoomed and before/after screenshots, backups.
- `test/studio-ui-test.mjs`: the studio in the browser: home (filters, settings, backups, templates, activity), the selection bar (Edit and Variations through a fake `claude`), Claude's highlights and the Keep / Undo bar, the notice for other projects, notes, lock, link, review, resize to formats, icons, and that only changed artboards are redrawn.
- `test/editor2-test.mjs`: scroll pan, ⌘-scroll zoom around the cursor, Space-drag pan, ⌘0/⌘±, the + Artboard popover, ⌘G, rich-text editing, resize handles, multi-drag, snapping, Alt+↑, clipboard paste, replace image, layers rename/collapse/multi-select, PNG size, and that the email export lays out within 3px of the browser version.

## How it fits together

```
server/doc.js     document model, operations, HTML in/out, history, autosave
server/server.js  http server: editor files, SSE live updates, POST /api/op, export, screenshot
server/shot.js    puppeteer-core + system Chrome
server/mcp.js     MCP wrapper over the HTTP API
editor/           plain ES modules, no build step (home screen + editor)
mac/Studio.swift  the native Mac app window
```

The editor and Claude both call `POST /api/op {op, args}`, so there is one code path and one undo stack.
Everything binds to 127.0.0.1 only.

## Known limitations

- **Single user, one open project at a time.** No multiplayer. The app and Claude share the open project; when Claude opens another one, your window follows.
- **PNG export and Claude's screenshots use Google Chrome** (headless). The Mac app itself doesn't need Chrome.
- **Undo is whole-document snapshots** (100 steps): fine for email-sized documents, heavy for huge ones. It is shared with Claude, so ⌘Z can undo Claude's last change.
- **The whole canvas re-renders on every change.** Fast for normal designs; very large documents may feel it.
- **Email export is a conversion, not a guarantee.** It follows email-client rules (tables, inline styles, bulletproof buttons) and matches the browser layout within a few pixels in tests, but I haven't run it through Outlook or Gmail themselves. Images are embedded as base64 by default, which Gmail blocks: use hosted `https://` images (or `embed=0`) for real sends. `flex: 1` / `flex-grow` sizing, wrapping rows (`flex-wrap`), `object-fit`, and `min-height` on text aren't converted.
- **HTML is inline-only.** `<style>`, classes, scripts, `<link>`, `<meta>` are dropped on import; no hover states or media queries.
- **Remote images are fetched at export time.** If a URL is dead or you are offline, the original URL stays in the file.
- **Google Fonts need the network the first time** a family is used; after that they come from the cache on this Mac. Custom fonts are not available inside email HTML (mail apps ignore them): text set in one falls back to the next font in the list, unless that section is exported as an image.
- **Ask Claude needs Claude Code** installed and signed in (run `claude` once in a terminal). It uses your own plan; each request counts against it.
- **Version history is local**: it lives in the project folder, so it's backed up only if you back up the project.
- **Screenshots come from a separate page**, not your live canvas, so they exclude editor overlays.
