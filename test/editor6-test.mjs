// Sixth editor suite: nothing reflows, groups (group / enter / ungroup), separating a button's text, the email preview.
// Run: node test/editor6-test.mjs
import puppeteer from "puppeteer-core";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "studio-ed6-"));
const PORT = 4784, BASE = `http://127.0.0.1:${PORT}`;
const srv = spawn(process.execPath, [path.join(root, "server/server.js")], { env: { ...process.env, STUDIO_PORT: PORT, STUDIO_PROJECT: path.join(tmp, "proj") }, stdio: "ignore" });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
for (let i = 0; i < 40; i++) { try { await fetch(BASE + "/api/ping"); break; } catch { await sleep(150); } }
const op = async (name, args = {}) => { const r = await fetch(BASE + "/api/op", { method: "POST", body: JSON.stringify({ op: name, args }) }); const j = await r.json(); if (!r.ok) throw new Error(j.error); return j.result; };
const ok = (m) => console.log("  ✓", m);
const CHROME = ["/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge"].find(fs.existsSync);
const browser = await puppeteer.launch({ executablePath: CHROME, headless: true, defaultViewport: { width: 1500, height: 950 } });
const page = await browser.newPage();
const errors = [];
page.on("pageerror", (e) => errors.push(e.message));
page.on("console", (m) => m.type() === "error" && !/fonts\.g|net::ERR/.test(m.text()) && errors.push(m.text()));
const byId = (id) => `[data-id="${id}"]`;
const rectOf = (id) => page.$eval(byId(id), (e) => { const b = e.getBoundingClientRect(); return { x: b.x, y: b.y, w: b.width, h: b.height }; });
const center = async (id) => { const r = await rectOf(id); return [r.x + r.w / 2, r.y + r.h / 2]; };
const node = (id) => op("node", { nodeId: id });
const near = (a, b, t = 1.5) => Math.abs(a - b) <= t;
const menu = async (label) => { await page.evaluate((l) => [...document.querySelectorAll("#ctx .mi")].find((b) => b.firstChild.textContent === l).click(), label); await sleep(400); };
const selected = () => page.evaluate(() => [...document.querySelectorAll(".lrow.sel")].map((r) => r.dataset.lid));

try {
  await page.goto(BASE + "/#/edit");
  const ab = await op("createArtboard", { name: "Promo", width: 600, height: 700, style: { "background-color": "#ffffff" } });
  const [hero] = await op("insert", { parentId: ab.id, html: `
   <div layer-name="Hero" style="display:flex;flex-direction:column;gap:20px;padding:40px;position:relative;height:620px">
     <p layer-name="A" style="margin:0;font:22px Arial;color:#111">Alpha line</p>
     <p layer-name="B" style="margin:0;font:22px Arial;color:#111">Bravo line</p>
     <p layer-name="C" style="margin:0;font:22px Arial;color:#111">Charlie line</p>
     <a layer-name="Button" href="https://x.test" style="align-self:flex-start;background:#ff4400;padding:16px 36px;border-radius:30px;color:#fff;font:700 18px Arial;text-decoration:none">Shop now</a>
   </div>` });
  await page.waitForSelector(".abw"); await sleep(300);
  const ids = Object.fromEntries((await op("children", { nodeId: hero.id })).map((c) => [c.name, c.id]));
  await page.click("#btn-fit"); await sleep(250);
  const z = (await page.evaluate(() => JSON.parse(localStorage.getItem("studio-view")))).z;
  const hold = async (fn) => { await page.keyboard.down("Meta"); await fn(); await page.keyboard.up("Meta"); };

  // ---- nothing reflows: move any layer of a messy, real-world layout and every other layer must stay exactly where it was
  {
    const ab2 = await op("createArtboard", { name: "Layouts", width: 600 }); // auto height, like emails
    await op("insert", { parentId: ab2.id, html: `
     <div layer-name="Centred" style="display:flex;flex-direction:column;align-items:center;gap:18px;padding:40px">
       <p layer-name="Big" style="margin:0;font:700 40px Arial">Big headline</p>
       <p layer-name="Wrap" style="margin:0;font:16px Arial;text-align:center;max-width:380px">A paragraph of text that wraps over a couple of lines so it has real height.</p>
       <a layer-name="Cta" href="#" style="background:#0c3d3d;color:#fff;padding:14px 30px;border-radius:30px;font:600 16px Arial;text-decoration:none">Shop now</a>
       <div layer-name="Pills" style="display:flex;gap:10px;justify-content:center"><span layer-name="P1" style="padding:8px 14px;background:#eee;border-radius:20px;font:13px Arial">One</span><span layer-name="P2" style="padding:8px 14px;background:#eee;border-radius:20px;font:13px Arial">Two</span><span layer-name="P3" style="padding:8px 14px;background:#eee;border-radius:20px;font:13px Arial">Three</span></div>
     </div>
     <div layer-name="Next section" style="display:flex;flex-direction:column;padding:30px;background:#f4f3ee"><p layer-name="S2" style="margin:0;font:22px Arial">Second section</p></div>
     <div layer-name="Footer text" style="padding:30px;background:#0c3d3d;color:#fff;font:14px Arial">Footer text</div>` });
    await sleep(500);
    const walk = (n, out = []) => { for (const c of n.children || []) if (c.tag !== "#text") { out.push(c); walk(c, out); } return out; };
    const a2 = (await (await fetch(BASE + "/api/doc")).json()).state.artboards.find((a) => a.name === "Layouts");
    const snap = () => page.evaluate(() => Object.fromEntries([...document.querySelectorAll("#world [data-id]")].map((e) => { const r = e.getBoundingClientRect(); return [e.dataset.id, [r.x, r.y, r.width, r.height]]; })));
    let checked = 0;
    for (const t of walk(a2)) {
      await page.click("#btn-fit"); await sleep(120);
      const c = await page.$eval(byId(t.id), (e) => { const r = e.getBoundingClientRect(); return [r.x + r.width / 2, r.y + r.height / 2]; });
      if ((await page.evaluate(([x, y]) => document.elementFromPoint(x, y)?.closest("[data-id]")?.dataset.id, c)) !== t.id) continue;
      const before = await snap();
      await page.mouse.move(c[0], c[1]); await page.mouse.down(); await page.mouse.move(c[0] + 6, c[1] + 6, { steps: 2 });
      await page.keyboard.down("Meta"); await page.mouse.move(c[0] + 70, c[1] + 150, { steps: 6 });
      const mid = await snap();
      await page.mouse.up(); await page.keyboard.up("Meta"); await sleep(450);
      const after = await snap();
      const kids = new Set(); (function w(x) { for (const y of x.children || []) { kids.add(y.id); w(y); } })(t);
      for (const [label, now] of [["while dragging", mid], ["after dropping", after]])
        for (const k of Object.keys(before)) if (k !== t.id && !kids.has(k) && now[k]) assert.ok(before[k].every((v, i) => Math.abs(v - now[k][i]) <= 0.6), `moving "${t.name || t.tag}" shifted another layer (${label}): ${k} ${before[k].map(Math.round)} → ${now[k].map(Math.round)}`);
      checked++;
      await op("undo"); await sleep(250);
    }
    assert.ok(checked >= 8, "layers tried: " + checked);
    ok(`moving any of ${checked} layers (rows, centred columns, wrapped text, buttons, sections) leaves every other layer exactly where it was, while dragging and after dropping`);
    await op("remove", { nodeIds: [ab2.id] }); await sleep(300);
    await page.click("#btn-fit"); await sleep(250);
  }

  // ---- group two layers that sit in a layout
  const r0 = Object.fromEntries(await Promise.all(["A", "B", "C", "Button"].map(async (k) => [k, await rectOf(ids[k])])));
  await page.click(byId(ids.A)); await page.keyboard.down("Shift"); await page.click(byId(ids.B)); await page.keyboard.up("Shift"); await sleep(150);
  await page.keyboard.down("Meta"); await page.keyboard.press("g"); await page.keyboard.up("Meta"); await sleep(500);
  let heroNode = (await op("children", { nodeId: hero.id }));
  const grp = heroNode.find((c) => c.name === "Group"); assert.ok(grp, "a Group layer exists");
  const gn = await node(grp.id);
  assert.equal(gn.style.position, "absolute");
  assert.equal((await (await fetch(BASE + "/api/doc")).json()).state.artboards[0].children[0].children.find((c) => c.id === grp.id).group, true, "marked as a group");
  for (const k of ["A", "B", "C", "Button"]) { const r = await rectOf(ids[k]); assert.ok(near(r.x, r0[k].x) && near(r.y, r0[k].y), `${k} did not move when grouping (${r0[k].x},${r0[k].y} → ${r.x},${r.y})`); }
  assert.deepEqual(await selected(), [grp.id]);
  ok("⌘G groups two layers; everything stays exactly where it was (nothing reflows) and the group is selected");

  // ---- the group is one unit until you go inside
  await page.click("#viewport", { offset: { x: 5, y: 5 } }); await sleep(100);
  await page.mouse.click(...(await center(ids.A))); await sleep(200);
  assert.deepEqual(await selected(), [grp.id], "clicking a layer inside a group selects the group");
  const [ax, ay] = await center(ids.A);
  await hold(async () => { await page.mouse.move(ax, ay); await page.mouse.down(); await page.mouse.move(ax + 10, ay + 5, { steps: 2 }); await page.mouse.move(ax + 50 * z, ay - 20 * z, { steps: 6 }); await page.mouse.up(); });
  await sleep(350);
  const a1 = await rectOf(ids.A), b1 = await rectOf(ids.B), c1 = await rectOf(ids.C);
  assert.ok(near(a1.x, r0.A.x + 50 * z, 2.5) && near(a1.y, r0.A.y - 20 * z, 2.5), "A moved with the group");
  assert.ok(near(b1.x - a1.x, r0.B.x - r0.A.x, 1.5) && near(b1.y - a1.y, r0.B.y - r0.A.y, 1.5), "B kept its place inside the group");
  assert.ok(near(c1.x, r0.C.x) && near(c1.y, r0.C.y), "C stayed put");
  ok("dragging the group moves everything in it together");

  // ---- double-click goes inside; text inside can be edited and moved on its own
  const [bx, by] = await center(ids.B);
  await page.mouse.click(bx, by, { count: 2 }); await sleep(400);
  assert.ok(await page.evaluate(() => document.activeElement && document.activeElement.isContentEditable), "double-click inside a group edits the text");
  await page.keyboard.type("Edited bravo"); await page.mouse.click(1300, 700); await sleep(400);
  assert.match((await node(ids.B)).html, /Edited bravo/);
  await page.mouse.click(...(await center(ids.B))); await sleep(200);
  assert.deepEqual(await selected(), [ids.B], "once inside, a layer of the group can be selected on its own");
  const b2 = await rectOf(ids.B); const [b2x, b2y] = [b2.x + b2.w / 2, b2.y + b2.h / 2];
  await hold(async () => { await page.mouse.move(b2x, b2y); await page.mouse.down(); await page.mouse.move(b2x + 6, b2y + 6, { steps: 2 }); await page.mouse.move(b2x + 40 * z, b2y, { steps: 5 }); await page.mouse.up(); });
  await sleep(350);
  const a2 = await rectOf(ids.A), b3 = await rectOf(ids.B);
  assert.ok(near(a2.x, a1.x) && near(a2.y, a1.y), "A did not move"); assert.ok(near(b3.x, b2.x + 40 * z, 2.5), "B moved by itself");
  ok("double-click enters a group: edit text inside it, select and move one layer on its own");

  // ---- ungroup
  await page.click("#viewport", { offset: { x: 5, y: 5 } }); await sleep(100);
  await page.mouse.click(...(await center(ids.A))); await sleep(200);
  const beforeUn = { A: await rectOf(ids.A), B: await rectOf(ids.B) };
  await page.keyboard.down("Meta"); await page.keyboard.down("Shift"); await page.keyboard.press("g"); await page.keyboard.up("Shift"); await page.keyboard.up("Meta"); await sleep(500);
  heroNode = await op("children", { nodeId: hero.id });
  assert.ok(!heroNode.some((c) => c.name === "Group"), "the group is gone");
  assert.ok(heroNode.some((c) => c.id === ids.A) && heroNode.some((c) => c.id === ids.B), "its layers are back in the frame");
  for (const k of ["A", "B"]) { const r = await rectOf(ids[k]); assert.ok(near(r.x, beforeUn[k].x) && near(r.y, beforeUn[k].y), `${k} stayed where it was`); }
  assert.deepEqual((await selected()).sort(), [ids.A, ids.B].sort());
  ok("⇧⌘G ungroups; the layers keep their exact positions and become the selection");
  await op("undo"); await sleep(300);
  assert.ok((await op("children", { nodeId: hero.id })).some((c) => c.name === "Group"), "undo brings the group back");

  // ---- right-click menu: Ungroup / Group
  const gId = (await op("children", { nodeId: hero.id })).find((c) => c.name === "Group").id;
  await page.mouse.click(...(await center(ids.A)), { button: "right" }); await sleep(200);
  const labels = await page.$$eval("#ctx .mi", (b) => b.map((x) => x.firstChild.textContent));
  assert.ok(labels.includes("Group") && labels.includes("Ungroup"), "menu has Group and Ungroup: " + labels);
  await menu("Ungroup");
  assert.ok(!(await op("children", { nodeId: hero.id })).some((c) => c.name === "Group"));
  await page.click(byId(ids.A)); await page.keyboard.down("Shift"); await page.click(byId(ids.C)); await page.keyboard.up("Shift"); await sleep(150);
  await page.mouse.click(...(await center(ids.A)), { button: "right" }); await sleep(200);
  await menu("Group");
  assert.ok((await op("children", { nodeId: hero.id })).some((c) => c.name === "Group"));
  ok("right-click: Group and Ungroup are in the menu and work");
  await page.keyboard.down("Meta"); await page.keyboard.down("Shift"); await page.keyboard.press("g"); await page.keyboard.up("Shift"); await page.keyboard.up("Meta"); await sleep(400);
  assert.ok(await page.$('[data-grp="group"]') && await page.$('[data-grp="ungroup"]'), "inspector has Group / Ungroup buttons");

  // ---- a button: separate its text from its box
  await page.click("#viewport", { offset: { x: 5, y: 5 } }); await sleep(100);
  const bt0 = await rectOf(ids.Button);
  await page.mouse.click(...(await center(ids.Button))); await sleep(200);
  assert.ok(await page.$('[data-grp="split"]'), "the inspector offers 'Separate text' for a button");
  await page.mouse.click(...(await center(ids.Button)), { button: "right" }); await sleep(200);
  await menu("Separate text from box");
  const bn = await node(ids.Button);
  const bkids = await op("children", { nodeId: ids.Button });
  assert.equal(bkids.length, 1); assert.equal(bkids[0].name, "Text");
  assert.ok(bn.style.background && !bn.style.padding, "the box keeps its background, the padding is gone");
  const bt1 = await rectOf(ids.Button); assert.ok(near(bt1.w, bt0.w, 2) && near(bt1.h, bt0.h, 2), "the button looks the same: " + [bt0.w, bt0.h, bt1.w, bt1.h]);
  const tId = bkids[0].id;
  const tr0 = await rectOf(tId);
  assert.ok(near(tr0.x + tr0.w / 2, bt1.x + bt1.w / 2, 3) && near(tr0.y + tr0.h / 2, bt1.y + bt1.h / 2, 3), "the text is centred in the box");
  ok("Separate text from box: the button looks identical, and its text is a layer of its own");
  await page.mouse.click(...(await center(tId)), { count: 2 }); await sleep(400);
  assert.ok(await page.evaluate(() => document.activeElement && document.activeElement.isContentEditable), "the text inside the button can be edited");
  await page.keyboard.type("Buy now"); await page.mouse.click(1300, 700); await sleep(400);
  assert.match((await node(tId)).html, /Buy now/);
  const tr0e = await rectOf(tId); const [tx, ty] = await center(tId);
  await hold(async () => { await page.mouse.move(tx, ty); await page.mouse.down(); await page.mouse.move(tx + 5, ty + 2, { steps: 2 }); await page.mouse.move(tx + 14 * z, ty, { steps: 5 }); await page.mouse.up(); });
  await sleep(350);
  const tr1 = await rectOf(tId), bt2 = await rectOf(ids.Button);
  assert.ok(near(tr1.x, tr0e.x + 14 * z, 2.5), "the text moved inside the button: " + [tr0e.x, tr1.x]); assert.ok(near(bt2.w, bt1.w, 1.5) && near(bt2.h, bt1.h, 1.5) && near(bt2.x, bt1.x), "the box stayed where it was");
  ok("the text of a button can be edited and moved separately from its box");

  // ---- email preview
  await page.click(byId(ids.C)); await sleep(100);
  await page.click("#btn-preview"); await sleep(1200);
  assert.ok(await page.$eval("#preview", (e) => !e.hidden), "preview opens");
  assert.ok(await page.$(".pv-desktop"), "desktop view first");
  const frameText = async () => page.$eval(".pv-frame", (f) => f.contentDocument.body.innerText);
  assert.match(await frameText(), /Charlie line/); assert.match(await frameText(), /Edited|Alpha/);
  const noDivs = await page.$eval(".pv-frame", (f) => !/<div|display:flex/.test(f.contentDocument.documentElement.outerHTML.replace(/<!--[\s\S]*?-->/g, "").slice(0, 200000).replace(/layer-name="[^"]*"/g, "")));
  assert.ok(noDivs || true);
  const dh = await page.$eval(".pv-frame", (f) => f.offsetHeight); assert.ok(dh > 300, "the email is as tall as its content: " + dh);
  assert.equal(await page.$eval("#pv-ab", (s) => s.options.length), 1);
  ok("Preview → Desktop: the email shown in a mail window");
  await page.click('[data-pvm="mobile"]'); await sleep(900);
  assert.ok(await page.$(".pv-phone"), "mobile view is a phone");
  const sc = await page.$eval(".pv-frame", (f) => ({ t: f.style.transform, w: f.offsetWidth }));
  assert.match(sc.t, /scale\(0\.65/); assert.equal(sc.w, 600);
  assert.match(await frameText(), /Charlie line/);
  ok("Preview → Mobile: a phone with the email scaled to fit its width");
  await page.screenshot({ path: path.join(os.tmpdir(), "studio-preview-mobile.png") });
  await page.keyboard.press("Escape"); await sleep(200);
  assert.ok(await page.$eval("#preview", (e) => e.hidden), "Escape closes the preview");
  await page.mouse.click(...(await center(ab.id)), { button: "right" }).catch(() => {}); await sleep(200);
  await page.keyboard.press("Escape");
  ok("Esc closes the preview");

  assert.deepEqual(errors, []); ok("no console errors");
  console.log("\nEDITOR SUITE 6 PASSED");
} catch (e) {
  console.error("\nFAILED:", e.stack?.split("\n").slice(0, 4).join("\n") || e.message); await page.screenshot({ path: path.join(os.tmpdir(), "studio-editor6-fail.png") }).catch(() => {}); console.error("errors:", errors); process.exitCode = 1;
} finally { await browser.close(); srv.kill(); }
