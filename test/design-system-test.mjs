// Design system suite (server level): components + instances + overrides, linked styles, brand kit. Also: nothing else is harmed.
// Run: node test/design-system-test.mjs
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "studio-ds-"));
const PORT = 4787, BASE = `http://127.0.0.1:${PORT}`;
const srv = spawn(process.execPath, [path.join(root, "server/server.js")], { env: { ...process.env, STUDIO_PORT: PORT, STUDIO_PROJECT: path.join(tmp, "proj") }, stdio: "ignore" });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
for (let i = 0; i < 40; i++) { try { await fetch(BASE + "/api/ping"); break; } catch { await sleep(150); } }
const op = async (name, args = {}) => { const r = await fetch(BASE + "/api/op", { method: "POST", body: JSON.stringify({ op: name, args }) }); const j = await r.json(); if (!r.ok) throw new Error(j.error); return j.result; };
const ok = (m) => console.log("  ✓", m);
const state = async () => (await (await fetch(BASE + "/api/doc")).json()).state;
const node = (id) => op("node", { nodeId: id });
const find = (n, id) => { if (n.id === id) return n; for (const c of n.children || []) { const r = find(c, id); if (r) return r; } return null; };
const findIn = async (id) => { const s = await state(); for (const a of s.artboards) { const r = find(a, id); if (r) return r; } return null; };
const txt = (n) => (n.children || []).map((c) => (c.tag === "#text" ? c.text : txt(c))).join("");
const rejects = async (fn, re) => { try { await fn(); } catch (e) { assert.match(e.message, re); return; } assert.fail("should have thrown " + re); };

try {
  const ab = await op("createArtboard", { name: "Lib", width: 800, height: 600 });
  const [card] = await op("insert", { parentId: ab.id, html: `
   <div layer-name="Card" style="display:flex;flex-direction:column;gap:8px;padding:20px;background-color:#eeeeee;border-radius:12px;width:240px">
     <p layer-name="Title" style="margin:0;font:700 20px Arial;color:#111111">Card title</p>
     <p layer-name="Body" style="margin:0;font:14px Arial;color:#555555">Body copy</p>
     <img layer-name="Pic" src="data:image/gif;base64,R0lGODlhAQABAAAAACw=" style="width:100px;height:40px">
   </div>` });
  const kids = Object.fromEntries((await op("children", { nodeId: card.id })).map((c) => [c.name, c.id]));

  // ---- components
  const comp = await op("createComponent", { nodeId: card.id, name: "Card" });
  await rejects(() => op("createComponent", { nodeId: card.id }), /already a component/);
  await rejects(() => op("createComponent", { nodeId: ab.id }), /Artboards/);
  const a2 = await op("createArtboard", { name: "Page", width: 800, height: 600 });
  const i1 = (await op("createInstance", { componentId: comp.id, parentId: a2.id, style: { position: "absolute", left: "40px", top: "40px" } }));
  const i2 = (await op("createInstance", { componentId: comp.id, parentId: a2.id, style: { position: "absolute", left: "340px", top: "40px" } }));
  let n1 = await findIn(i1.id);
  assert.equal(n1.instanceOf, comp.id); assert.equal(n1.style.left, "40px"); assert.equal(n1.name, "Card"); assert.ok(!n1.component, "an instance is not a master");
  assert.equal(txt(n1), "Card titleBody copy"); assert.notEqual(n1.children[0].id, kids.Title, "instance layers have their own ids");
  ok("a component has a main layer; instances are copies with their own ids and position");

  // editing the main updates every instance
  await op("updateStyles", { updates: [{ nodeIds: [card.id], styles: { "background-color": "#c0ffee" } }, { nodeIds: [kids.Title], styles: { color: "#ff0000" } }] });
  await op("setText", { nodeId: kids.Body, text: "New body" });
  for (const id of [i1.id, i2.id]) { const n = await findIn(id); assert.equal(n.style["background-color"], "#c0ffee"); assert.equal(n.children[0].style.color, "#ff0000"); assert.equal(txt(n), "Card titleNew body"); assert.equal(n.style.left.length > 0, true); }
  ok("changing the main component updates all instances (styles and text), instances keep their own position");

  // overrides: text in one instance survives main edits and does not touch the others
  n1 = await findIn(i1.id);
  await op("setText", { nodeId: n1.children[0].id, text: "Custom headline" });
  assert.equal(txt(await findIn(i2.id)).startsWith("Card title"), true, "other instances are untouched");
  await op("updateStyles", { updates: [{ nodeIds: [kids.Title], styles: { "font-size": "26px" } }] });
  n1 = await findIn(i1.id);
  assert.equal(txt(n1.children[0]), "Custom headline", "the override survives a main edit"); assert.equal(n1.children[0].style["font-size"], "26px", "…while other properties follow the main");
  ok("an instance can override text and keep it while still following the main for everything else");
  await op("updateStyles", { updates: [{ nodeIds: [n1.children[0].id], styles: { color: "#00aa00" } }] });
  await op("updateStyles", { updates: [{ nodeIds: [kids.Title], styles: { color: "#0000ff" } }] });
  n1 = await findIn(i1.id); assert.equal(n1.children[0].style.color, "#00aa00", "a style override sticks");
  assert.equal((await findIn(i2.id)).children[0].style.color, "#0000ff", "other instances follow the main's new colour");
  ok("style overrides stick on the instance that has them");
  // moving the instance itself is not an override of the master
  await op("updateStyles", { updates: [{ nodeIds: [i1.id], styles: { left: "70px", top: "90px" } }] });
  n1 = await findIn(i1.id); assert.equal(n1.style.left, "70px"); assert.equal(n1.style.top, "90px");
  await op("updateStyles", { updates: [{ nodeIds: [card.id], styles: { padding: "30px" } }] });
  n1 = await findIn(i1.id); assert.equal(n1.style.left, "70px"); assert.equal(n1.style.padding, "30px"); ok("placement belongs to the instance, everything else to the main");

  // structure: edits that add / remove layers detach the instance, the others carry on
  await op("remove", { nodeIds: [n1.children[2].id] });
  n1 = await findIn(i1.id); assert.ok(!n1.instanceOf, "removing a layer inside an instance detaches it"); assert.equal(n1.children.length, 2);
  await op("insert", { parentId: card.id, html: `<p layer-name="Extra" style="margin:0">Extra</p>` });
  assert.equal((await findIn(i2.id)).children.length, 4, "structural changes to the main reach the other instances"); assert.equal((await findIn(i1.id)).children.length, 2, "…but not the detached one");
  ok("changing the layers of an instance detaches it; adding layers to the main reaches the other instances");

  // undo restores it all in one step
  await op("undo"); assert.equal((await findIn(i2.id)).children.length, 3); await op("undo"); assert.ok((await findIn(i1.id)).instanceOf); ok("undo steps back through instance changes");

  // duplicating the main doesn't create a second main; deleting the main frees the instances
  const dup = await op("duplicate", { nodeIds: [card.id] });
  assert.ok(!(await findIn(dup[0].id)).component, "a duplicate of the main is a plain layer");
  assert.equal((await op("listComponents")).length, 1);
  assert.equal((await op("listComponents"))[0].instances, 2);
  await op("remove", { nodeIds: [card.id] });
  assert.deepEqual(await op("listComponents"), []); assert.ok(!(await findIn(i2.id)).instanceOf, "deleting the main turns instances into plain layers");
  assert.equal(txt(await findIn(i2.id)).startsWith("Card title"), true, "…and they keep their content");
  ok("duplicating keeps one main; deleting the main frees the instances without losing their content");

  // ---- styles
  const s = await op("createStyle", { kind: "color", name: "Brand green", value: "#0c3d3d" });
  const t = await op("createStyle", { kind: "text", name: "Headline", css: { "font-family": "Georgia", "font-size": "40px", "font-weight": "700" } });
  const a3 = await op("createArtboard", { name: "Styled", width: 600 });
  const [x, y] = await op("insert", { parentId: a3.id, html: `<div layer-name="Box" style="width:100px;height:100px;background:linear-gradient(red,blue)"></div><p layer-name="Head" style="margin:0;font:14px Arial">Hello</p>` });
  await op("applyStyle", { nodeIds: [x.id], styleId: s.id, prop: "background-color" });
  await op("applyStyle", { nodeIds: [y.id], styleId: t.id });
  let bx = await findIn(x.id), hy = await findIn(y.id);
  assert.equal(bx.style["background-color"], "#0c3d3d"); assert.ok(!bx.style.background && !bx.style["background-image"], "a colour style replaces a gradient"); assert.equal(hy.style["font-size"], "40px"); assert.equal(hy.refs.text, t.id);
  await op("updateStyle", { id: s.id, value: "#46de46" }); await op("updateStyle", { id: t.id, css: { "font-family": "Georgia", "font-size": "48px", "font-weight": "400" } });
  bx = await findIn(x.id); hy = await findIn(y.id);
  assert.equal(bx.style["background-color"], "#46de46"); assert.equal(hy.style["font-size"], "48px"); assert.equal(hy.style["font-weight"], "400");
  ok("colour and text styles link to layers, and changing the style updates every layer that uses it");
  await op("updateStyles", { updates: [{ nodeIds: [x.id], styles: { "background-color": "#ff00ff" } }] });
  bx = await findIn(x.id); assert.ok(!bx.refs, "editing a linked value unlinks it");
  await op("updateStyle", { id: s.id, value: "#000000" }); assert.equal((await findIn(x.id)).style["background-color"], "#ff00ff", "an unlinked layer is no longer touched");
  await op("updateStyles", { updates: [{ nodeIds: [y.id], styles: { "font-size": "20px" } }] }); assert.ok(!(await findIn(y.id)).refs, "editing text props unlinks the text style");
  ok("a manual edit unlinks a style, so styles never overwrite a deliberate change");
  await op("applyStyle", { nodeIds: [x.id], styleId: s.id, prop: "background-color" }); await op("deleteStyle", { id: s.id });
  bx = await findIn(x.id); assert.ok(!bx.refs); assert.equal(bx.style["background-color"], "#000000", "deleting a style keeps the colour"); ok("deleting a style keeps the layers' values");

  // ---- brand
  const br = await op("setBrand", { name: "AG1", fonts: { heading: "Newsreader", body: "Hanken Grotesk", mono: "DM Mono" }, colors: [{ name: "Teal", value: "#0C3D3D" }, { name: "Neon", value: "#46DE46" }], notes: "Editorial, calm." });
  assert.equal(br.brand.fonts.heading, "Newsreader"); assert.equal(br.colors.filter((c) => ["Teal", "Neon"].includes(c.name)).length, 2);
  const br2 = await op("setBrand", { colors: [{ name: "teal", value: "#023D3D" }] });
  assert.equal(br2.colors.filter((c) => c.name.toLowerCase() === "teal").length, 1, "same name updates, not duplicates"); assert.equal(br2.colors.find((c) => c.name.toLowerCase() === "teal").value, "#023D3D");
  assert.equal(br2.brand.fonts.body, "Hanken Grotesk"); assert.equal((await op("getBrand")).brand.name, "AG1");
  ok("brand kit: name, fonts, colours (by name), notes; read back as one object");

  // ---- survives a restart
  await sleep(700);
  srv.kill(); await sleep(500);
  const srv2 = spawn(process.execPath, [path.join(root, "server/server.js")], { env: { ...process.env, STUDIO_PORT: PORT, STUDIO_PROJECT: path.join(tmp, "proj") }, stdio: "ignore" });
  for (let i = 0; i < 40; i++) { try { await fetch(BASE + "/api/ping"); break; } catch { await sleep(150); } }
  const re = await op("getBrand"); assert.equal(re.brand.name, "AG1"); assert.ok(re.colors.length >= 2); assert.equal((await op("listComponents")).length, 0);
  srv2.kill(); ok("everything is saved with the project and survives a restart");

  console.log("\nDESIGN SYSTEM TESTS PASSED");
} catch (e) {
  console.error("\nFAILED:", e.stack?.split("\n").slice(0, 6).join("\n") || e.message); process.exitCode = 1;
} finally { srv.kill(); }
