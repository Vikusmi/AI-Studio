// Second editor suite: view (zoom/pan), group, artboard popover, resize, snapping, multi-drag, rich text, PNG, email export.
// Run: node test/editor2-test.mjs
import puppeteer from "puppeteer-core";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "studio-ed2-"));
const PORT = 4780, BASE = `http://127.0.0.1:${PORT}`;
const srv = spawn(process.execPath, [path.join(root, "server/server.js")], { env: { ...process.env, STUDIO_PORT: PORT, STUDIO_PROJECT: path.join(tmp, "proj") }, stdio: "ignore" });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
for (let i = 0; i < 40; i++) { try { await fetch(BASE + "/api/ping"); break; } catch { await sleep(150); } }
const op = async (name, args = {}) => { const r = await fetch(BASE + "/api/op", { method: "POST", body: JSON.stringify({ op: name, args }) }); const j = await r.json(); if (!r.ok) throw new Error(j.error); return j.result; };
const docState = async () => (await (await fetch(BASE + "/api/doc")).json()).state;
const ok = (m) => console.log("  ✓", m);
const CHROME = ["/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge"].find(fs.existsSync);
const browser = await puppeteer.launch({ executablePath: CHROME, headless: true, defaultViewport: { width: 1500, height: 900 } });
const page = await browser.newPage();
const errors = [];
page.on("pageerror", (e) => errors.push(e.message));
page.on("console", (m) => m.type() === "error" && !/fonts\.g|net::ERR/.test(m.text()) && errors.push(m.text()));

try {
  await page.goto(BASE + "/#/edit");
  const ab = await op("createArtboard", { name: "Board", width: 600 });
  const [hero] = await op("insert", { parentId: ab.id, html: `
   <div layer-name="Hero" style="display:flex;flex-direction:column;gap:14px;padding:30px;position:relative;min-height:480px">
     <p layer-name="Rich" style="margin:0;font:20px Arial">Hello <b>bold</b> world</p>
     <div layer-name="Card A" style="background:#eee;padding:20px;font:16px Arial">Card A</div>
     <div layer-name="Card B" style="background:#ddd;padding:20px;font:16px Arial">Card B</div>
     <div layer-name="Box" style="position:absolute;left:40px;top:300px;width:100px;height:60px;background:#0d8cff"></div>
     <div layer-name="Box2" style="position:absolute;left:220px;top:300px;width:100px;height:60px;background:#f33"></div>
   </div>` });
  await page.waitForSelector(".abw"); await sleep(300);
  const ids = Object.fromEntries((await op("children", { nodeId: hero.id })).map((c) => [c.name, c.id]));
  const byId = (id) => `[data-id="${id}"]`;
  const center = (sel) => page.$eval(sel, (e) => { const b = e.getBoundingClientRect(); return [b.x + b.width / 2, b.y + b.height / 2]; });
  const view = () => page.evaluate(() => JSON.parse(localStorage.getItem("studio-view")));
  const node = async (id) => (await op("node", { nodeId: id }));
  await page.click("#btn-fit"); await sleep(150);

  // ---- view: wheel pan, ctrl-wheel zoom around cursor, space-drag pan, ⌘0 / ⌘+ / ⌘-
  let v0 = await view();
  await page.mouse.move(700, 450); await page.mouse.wheel({ deltaY: 120, deltaX: 30 }); await sleep(100);
  let v1 = await view(); assert.equal(Math.round(v1.y - v0.y), -120); assert.equal(Math.round(v1.x - v0.x), -30); ok("trackpad scroll pans");
  const probe = async () => page.$eval(byId(ids["Card A"]), (e) => { const b = e.getBoundingClientRect(); return [b.x, b.y, b.width]; });
  const cx = 700, cy = 450;
  const [bx, by, bw] = await probe();
  const relX = (cx - bx) / bw, relY0 = cy - by;
  await page.evaluate(([x, y]) => document.querySelector("#viewport").dispatchEvent(new WheelEvent("wheel", { clientX: x, clientY: y, deltaY: -100, ctrlKey: true, bubbles: true, cancelable: true })), [cx, cy]);
  await sleep(100);
  const [ax, ay, aw] = await probe(); const v2 = await view();
  assert.ok(v2.z > v1.z, "zoomed in"); assert.ok(Math.abs((cx - ax) / aw - relX) < 0.001, "point under cursor stays put (x)");
  assert.ok(Math.abs((cy - ay) / (aw / bw) - relY0) < 1, "point under cursor stays put (y)"); ok(`pinch / ⌘-scroll zooms around the cursor (${Math.round(v1.z * 100)}% → ${Math.round(v2.z * 100)}%)`);
  await page.keyboard.down("Meta"); await page.keyboard.press("-"); await page.keyboard.up("Meta"); await sleep(80);
  const v3 = await view(); assert.ok(v3.z < v2.z); await page.keyboard.down("Meta"); await page.keyboard.press("="); await page.keyboard.up("Meta"); await sleep(80);
  assert.ok((await view()).z > v3.z); ok("⌘- and ⌘+ zoom");
  await page.click("#btn-fit"); await sleep(100);
  const boxBefore = (await node(ids["Box"])).style.left;
  const vb = await view(); const [px, py] = await center(byId(ids["Box"]));
  await page.keyboard.down("Space"); await page.mouse.move(px, py); await page.mouse.down(); await page.mouse.move(px + 80, py + 50, { steps: 5 }); await page.mouse.up(); await page.keyboard.up("Space"); await sleep(150);
  const va = await view(); assert.equal(Math.round(va.x - vb.x), 80); assert.equal(Math.round(va.y - vb.y), 50);
  assert.equal((await node(ids["Box"])).style.left, boxBefore); ok("Space+drag pans without moving the element under it");
  await page.mouse.move(1000, 800, { button: "middle" }); await page.mouse.down({ button: "middle" }); await page.mouse.move(940, 770, { steps: 4 }); await page.mouse.up({ button: "middle" }); await sleep(100);
  assert.equal(Math.round((await view()).x - va.x), -60); ok("middle-button drag pans");
  await page.keyboard.down("Meta"); await page.keyboard.press("0"); await page.keyboard.up("Meta"); await sleep(100);
  assert.ok((await view()).z <= 1); ok("⌘0 fits everything; view is remembered in localStorage");

  // ---- artboard popover
  await page.click("#btn-add-artboard"); await sleep(100);
  await page.$eval("#p-name", (e) => (e.value = "")); await page.type("#p-name", "Phone screen");
  await page.select("#p-preset", await page.$eval("#p-preset", (s) => [...s.options].find((o) => o.textContent.startsWith("Mobile ·")).value)); await page.click("#p-ok"); await sleep(500);
  let st = await docState(); const phone = st.artboards[1];
  assert.equal(phone.name, "Phone screen"); assert.equal(phone.style.width, "390px"); assert.equal(phone.style.height, "844px");
  assert.ok(phone.x > 600); ok("+ Artboard popover: name, Mobile preset 390×844, placed to the right");
  const z = (await view()).z; const pr = await page.$eval(byId(phone.id), (e) => { const b = e.getBoundingClientRect(); return { x: b.x, y: b.y, right: b.right, bottom: b.bottom }; });
  assert.ok(pr.x >= 250 && pr.right <= 1230 && pr.y >= 48 && pr.bottom <= 900, JSON.stringify(pr)); ok("new artboard gets focus (zoom to fit)");
  await page.click("#btn-add-artboard"); await page.$eval("#p-name", (e) => (e.value = "Auto")); await page.$eval("#p-h", (e) => (e.value = "")); await page.click("#p-ok"); await sleep(300);
  assert.equal((await docState()).artboards[2].style.height, "fit-content"); ok("empty height creates a fit-content artboard");
  await op("undo"); await op("undo"); await sleep(100); await page.click("#btn-fit"); await sleep(150);

  // ---- group (⌘G)
  await page.mouse.click(...(await center(byId(ids["Card B"])))); // select B first, then A: the group must still be A, B
  await page.keyboard.down("Shift"); await page.mouse.click(...(await center(byId(ids["Card A"])))); await page.keyboard.up("Shift"); await sleep(150);
  assert.equal((await fetch(BASE + "/api/doc").then((r) => r.json())).selection.length, 2, "two selected");
  await page.keyboard.down("Meta"); await page.keyboard.press("g"); await page.keyboard.up("Meta"); await sleep(300);
  const heroNow = (await docState()).artboards[0].children[0]; const grp = heroNow.children.find((c) => c.name === "Group");
  assert.ok(grp && grp.children.map((c) => c.name).join() === "Card A,Card B"); ok("⌘G wraps the selection in a Group frame (order kept)");
  await op("undo"); await sleep(150);

  // ---- rich text editing
  await page.mouse.click(...(await center(byId(ids["Rich"])))); await page.mouse.click(...(await center(byId(ids["Rich"]))), { count: 2 }); await sleep(150);
  assert.equal(await page.$eval(byId(ids["Rich"]), (e) => e.contentEditable), "true");
  await page.keyboard.press("End"); await page.keyboard.type("!!"); await page.keyboard.press("Enter"); await sleep(350);
  const rich = await node(ids["Rich"]); assert.match(rich.html, /<b[^>]*>bold<\/b>/); assert.match(rich.html, /world!!/); assert.ok(!rich.html.includes("data-id")); ok("text with <b> inside is editable in place and keeps its formatting");
  assert.ok((await page.$$eval(".lrow .nm", (e) => e.map((x) => x.textContent))).some((t) => t.startsWith("Rich")) );

  // ---- resize handles
  const zoom = async () => (await view()).z;
  await page.mouse.click(...(await center(byId(ids["Box"])))); await sleep(120);
  assert.equal(await page.$$eval(".handle", (e) => e.length), 8); ok("absolute element shows 8 resize handles");
  const handle = (h) => center(`.handle[data-h="${h}"]`);
  const dragH = async (h, dx, dy, shift) => { const [hx, hy] = await handle(h); const k = await zoom(); if (shift) await page.keyboard.down("Shift"); await page.mouse.move(hx, hy); await page.mouse.down(); await page.mouse.move(hx + dx * k, hy + dy * k, { steps: 6 }); await page.mouse.up(); if (shift) await page.keyboard.up("Shift"); await sleep(250); };
  await page.keyboard.down("Meta"); // no snapping while testing exact numbers (resize doesn't snap anyway)
  await page.keyboard.up("Meta");
  await dragH("se", 40, 20); let b = (await node(ids["Box"])).style; assert.equal(b.width, "140px"); assert.equal(b.height, "80px"); ok("se handle: 100×60 → 140×80");
  await dragH("w", -30, 0); b = (await node(ids["Box"])).style; assert.equal(b.width, "170px"); assert.equal(b.left, "10px"); ok("w handle grows leftwards and moves left (40 → 10)");
  await dragH("nw", 10, 10); b = (await node(ids["Box"])).style; assert.equal(b.width, "160px"); assert.equal(b.height, "70px"); assert.equal(b.top, "310px"); ok("corner handle resizes both axes");
  await dragH("se", 50, 5, true); b = (await node(ids["Box"])).style; assert.ok(Math.abs(parseInt(b.width) / parseInt(b.height) - 160 / 70) < 0.05, JSON.stringify(b)); ok("Shift on a corner keeps the aspect ratio");
  await page.mouse.click(...(await center(byId(ids["Card A"])))); await sleep(100);
  assert.equal(await page.$$eval(".handle", (e) => e.length), 8); await dragH("e", -100, 0); assert.equal((await node(ids["Card A"])).style.width, (await page.$eval(byId(ids["Card A"]), (e) => e.offsetWidth)) + "px"); ok("in-flow element: e/s/se handles set width/height");
  await page.mouse.click(...(await page.$eval(".ab-title", (e) => { const b = e.getBoundingClientRect(); return [b.x + 5, b.y + 5]; }))); await sleep(120);
  await dragH("e", 60, 0); assert.equal((await docState()).artboards[0].style.width, "660px"); ok("artboard width resized from its handle");
  await op("updateStyles", { updates: [{ nodeIds: [ab.id], styles: { width: "600px" } }] }); await sleep(150);

  // ---- multi-select drag of absolute elements + snapping guides
  await page.click("#btn-fit"); await sleep(120);
  const bOld = (await node(ids["Box"])).style, b2Old = (await node(ids["Box2"])).style;
  await page.mouse.click(...(await center(byId(ids["Box"])))); await page.keyboard.down("Shift"); await page.mouse.click(...(await center(byId(ids["Box2"])))); await page.keyboard.up("Shift"); await sleep(100);
  const k = await zoom(); const [mx, my] = await center(byId(ids["Box"]));
  await page.keyboard.down("Meta"); await page.mouse.move(mx, my); await page.mouse.down(); await page.mouse.move(mx + 33 * k, my + 17 * k, { steps: 6 }); await page.mouse.up(); await page.keyboard.up("Meta"); await sleep(300);
  const bN = (await node(ids["Box"])).style, b2N = (await node(ids["Box2"])).style;
  assert.equal(parseInt(bN.left) - parseInt(bOld.left), 33); assert.equal(parseInt(b2N.left) - parseInt(b2Old.left), 33); assert.equal(parseInt(b2N.top) - parseInt(b2Old.top), 17); ok("dragging one of several selected absolute elements moves them all");
  // snapping: drop Box so that its left edge is 3px off the parent's left edge -> snaps to 0 and shows a guide
  await page.mouse.click(...(await center(byId(ids["Box2"])))); await sleep(100);
  const hr = await page.$eval(byId(ids["Box"]), (e) => e.offsetParent.getBoundingClientRect().left); // parent left on screen
  await page.mouse.click(...(await center(byId(ids["Box"])))); await sleep(100);
  const br = await page.$eval(byId(ids["Box"]), (e) => { const r = e.getBoundingClientRect(); return [r.left, r.top + r.height / 2]; });
  const [sx0, sy0] = await center(byId(ids["Box"]));
  await page.mouse.move(sx0, sy0); await page.mouse.down();
  await page.mouse.move(sx0 - (br[0] - hr - 3 * k), sy0, { steps: 8 }); await sleep(60);
  const guides = await page.$$eval(".guide", (e) => e.length); await page.mouse.up(); await sleep(300);
  assert.ok(guides >= 1, "guide shown"); assert.equal((await node(ids["Box"])).style.left, "0px"); ok("snaps to the parent's edge (3px away → 0px) and draws a pink guide");

  // ---- keyboard selection, clipboard paste, replace image, layers rename/collapse/multi-select
  const selected = async () => (await fetch(BASE + "/api/doc").then((r) => r.json())).selection;
  await page.mouse.click(...(await center(byId(ids["Card A"])))); await sleep(100);
  await page.keyboard.down("Alt"); await page.keyboard.press("ArrowUp"); await page.keyboard.up("Alt"); await sleep(300);
  assert.deepEqual(await selected(), [hero.id]); ok("Alt+↑ selects the parent");
  const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAFElEQVR4nGP8z8Dwn4GBgYGJAQoAHhgCAh6X4CYAAAAASUVORK5CYII=";
  const kidsBefore = (await docState()).artboards[0].children[0].children.length;
  await page.evaluate((b64) => { const f = new File([Uint8Array.from(atob(b64), (c) => c.charCodeAt(0))], "pasted.png", { type: "image/png" }); const dt = new DataTransfer(); dt.items.add(f); window.dispatchEvent(new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true })); }, PNG);
  await sleep(600);
  const heroKids = (await docState()).artboards[0].children[0].children; assert.equal(heroKids.length, kidsBefore + 1); const pasted = heroKids.at(-1);
  assert.equal(pasted.tag, "img"); assert.match(pasted.attrs.src, /^assets\/pasted/); ok("pasting an image uploads it and inserts it into the selected frame");
  fs.writeFileSync(path.join(tmp, "new.png"), Buffer.from(PNG, "base64").toString("base64") && Buffer.from(PNG, "base64"));
  await page.mouse.click(...(await center(byId(pasted.id)))); await sleep(100);
  const [chooser] = await Promise.all([page.waitForFileChooser(), page.click("#swap-img")]);
  fs.writeFileSync(path.join(tmp, "swap me.png"), Buffer.from(PNG, "base64")); await chooser.accept([path.join(tmp, "swap me.png")]); await sleep(500);
  assert.match((await node(pasted.id)).attrs.src, /assets\/swap_me/); ok("Replace… in the inspector swaps the image source");
  const row = (id) => `.lrow[data-lid="${id}"]`;
  await page.click(row(ids["Card A"]) + " .nm"); await page.keyboard.down("Shift"); await page.click(row(ids["Card B"]) + " .nm"); await page.keyboard.up("Shift"); await sleep(150);
  assert.deepEqual((await selected()).sort(), [ids["Card A"], ids["Card B"]].sort()); ok("Shift-click in Layers multi-selects");
  await page.click(row(ids["Card A"]) + " .nm"); await page.click(row(ids["Card A"]) + " .nm", { count: 2 }); await sleep(100);
  await page.keyboard.down("Meta"); await page.keyboard.press("a"); await page.keyboard.up("Meta"); await page.keyboard.type("Renamed card"); await page.keyboard.press("Enter"); await sleep(300);
  assert.equal((await node(ids["Card A"])).name, "Renamed card"); ok("double-click a layer renames it");
  await page.click(row(hero.id) + " .tw"); await sleep(100);
  assert.equal(await page.$(row(ids["Card B"])), null); await page.click(row(hero.id) + " .tw"); await sleep(100); assert.ok(await page.$(row(ids["Card B"]))); ok("layer collapse arrow hides and shows children");

  // ---- exports
  const shotRes = await fetch(`${BASE}/api/screenshot?id=${ab.id}&scale=2`); const png = Buffer.from(await shotRes.arrayBuffer());
  assert.equal(png.subarray(1, 4).toString(), "PNG"); assert.equal(png.readUInt32BE(16), 1200); ok("PNG export: 2x → 1200px wide");
  assert.ok(await page.$("#btn-email"), "email button");

  // ---- moving is free: the layer follows the cursor, the rest of the layout doesn't change
  await page.click("#btn-fit"); await sleep(200);
  const rectOf = (id) => page.$eval(byId(id), (e) => { const b = e.getBoundingClientRect(); return { x: b.x, y: b.y, w: b.width, h: b.height }; });
  {
    const bBefore = await rectOf(ids["Card B"]);
    const [cx, cy] = await center(byId(ids["Card A"]));
    await page.keyboard.down("Meta");
    await page.mouse.move(cx, cy); await page.mouse.down(); await page.mouse.move(cx + 10, cy + 20, { steps: 3 }); await page.mouse.move(cx + 20, cy + 120, { steps: 5 });
    const live = await page.$eval(byId(ids["Card A"]), (e) => { const b = e.getBoundingClientRect(); return { cx: b.x + b.width / 2, cy: b.y + b.height / 2 }; });
    assert.ok(Math.abs(live.cx - (cx + 20)) <= 3 && Math.abs(live.cy - (cy + 120)) <= 3, `stays under the cursor: ${live.cx},${live.cy} vs ${cx + 20},${cy + 120}`);
    await page.mouse.up(); await page.keyboard.up("Meta"); await sleep(300);
    const bAfter = await rectOf(ids["Card B"]);
    assert.ok(Math.abs(bAfter.y - bBefore.y) <= 1 && Math.abs(bAfter.x - bBefore.x) <= 1, "the neighbour did not jump into the gap");
    assert.equal((await node(ids["Card A"])).style.position, "absolute");
    ok("the layer itself follows the cursor; the neighbour stays put");
    await op("undo"); await sleep(250);
  }
  {
    const before = await rectOf(ids["Card A"]);
    await page.click(byId(ids["Card A"])); await sleep(150);
    await page.select('[data-prop="position"]', "absolute"); await sleep(300);
    const after = await rectOf(ids["Card A"]);
    assert.ok(Math.abs(after.x - before.x) <= 2 && Math.abs(after.y - before.y) <= 2, "inspector absolute keeps the position");
    ok("Position → absolute in the inspector keeps the element where it is");
    await op("undo"); await sleep(250);
  }

  // email export must lay out like the browser version
  const [fx] = await op("insert", { parentId: (await op("createArtboard", { name: "Mail", width: 600 })).id, html: `
   <div layer-name="Bar" style="display:flex;justify-content:space-between;align-items:center;padding:20px 30px;background:#eeeeee"><span style="font:700 18px Arial">Left</span><span style="font:14px Arial">Right</span></div>
   <div layer-name="Buttons" style="display:flex;gap:12px;padding:20px 30px"><a href="https://x.test" style="background:#ff4400;padding:10px 20px;border-radius:8px;color:#ffffff;font:16px Arial;text-decoration:none">Btn A</a><a href="https://y.test" style="background:#222222;padding:10px 20px;border-radius:8px;color:#ffffff;font:16px Arial;text-decoration:none">Btn B</a></div>
   <div layer-name="Centered" style="display:flex;flex-direction:column;gap:10px;padding:0 30px 20px;align-items:center"><p style="margin:0;font:16px Arial">Centered one</p><p style="margin:0;font:16px Arial">Centered two</p></div>
   <img src="${(await (await fetch(BASE + "/api/upload?name=a.png", { method: "POST", body: Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAFElEQVR4nGP8z8Dwn4GBgYGJAQoAHhgCAh6X4CYAAAAASUVORK5CYII=", "base64") })).json()).src}" style="width:100%;height:80px;object-fit:cover">` });
  const mailId = (await docState()).artboards.find((a) => a.name === "Mail").id;
  const mail = await (await fetch(`${BASE}/api/export?id=${mailId}&format=email`)).text();
  const web = await (await fetch(`${BASE}/api/export?id=${mailId}`)).text();
  assert.ok(!/<div|display:flex|flex-direction|justify-content/.test(mail), "no divs/flex in email"); assert.ok(mail.includes("<table")); assert.ok(!/<script|class=/.test(mail)); assert.ok(mail.includes("bgcolor="));
  const measure = async (html) => { const p = await browser.newPage(); await p.setViewport({ width: 800, height: 600 }); await p.setContent(html, { waitUntil: "load" });
    const r = await p.evaluate(() => { const out = {}; for (const t of ["Left", "Right", "Btn A", "Btn B", "Centered one", "Centered two"]) { const el = [...document.querySelectorAll("*")].filter((e) => e.children.length === 0 && e.textContent.trim() === t)[0]; const rg = document.createRange(); rg.selectNodeContents(el); const b = rg.getBoundingClientRect(); out[t] = [Math.round(b.x), Math.round(b.y), Math.round(b.width)]; } out.h = document.documentElement.scrollHeight; return out; }); await p.close(); return r; };
  const A = await measure(web), B = await measure(mail);
  for (const key of Object.keys(A)) { if (key === "h") { assert.ok(Math.abs(A.h - B.h) <= 3, `page height ${A.h} vs ${B.h}`); continue; } for (let i = 0; i < 3; i++) assert.ok(Math.abs(A[key][i] - B[key][i]) <= 3, `${key}[${i}]: browser ${A[key]} vs email ${B[key]}`); }
  ok("email export has no div/flex, and every text lands within 3px of the browser layout");
  const mcpEmail = await fetch(`${BASE}/api/export?id=${mailId}&format=email&embed=0`); assert.match(mcpEmail.headers.get("content-disposition"), /mail-email\.html/); ok("email download filename");

  await page.reload(); await page.waitForSelector(".abw");
  assert.deepEqual(errors, []); ok("no console errors");
  console.log("\nEDITOR SUITE 2 PASSED");
} catch (e) {
  console.error("\nFAILED:", e.stack?.split("\n").slice(0, 4).join("\n") || e.message); await page.screenshot({ path: path.join(os.tmpdir(), "studio-editor2-fail.png") }).catch(() => {}); console.error("errors:", errors); process.exitCode = 1;
} finally { await browser.close(); srv.kill(); }
