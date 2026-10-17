// Version history: save, auto snapshots, restore (undoable and non-destructive), rename, delete, pruning.
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "studio-hist-"));
const PORT = 4797, BASE = `http://127.0.0.1:${PORT}`;
const srv = spawn(process.execPath, [path.join(root, "server/server.js")], { env: { ...process.env, STUDIO_PORT: PORT, STUDIO_PROJECT: path.join(tmp, "proj"), STUDIO_HISTORY_TICK_MS: "300", STUDIO_HISTORY_EVERY_MS: "1" }, stdio: "ignore" });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
for (let i = 0; i < 40; i++) { try { await fetch(BASE + "/api/ping"); break; } catch { await sleep(150); } }
const op = async (name, args = {}) => { const r = await fetch(BASE + "/api/op", { method: "POST", body: JSON.stringify({ op: name, args }) }); const j = await r.json(); if (!r.ok) throw new Error(j.error); return j.result; };
const ok = (m) => console.log("  ✓", m);
const names = async () => (await (await fetch(BASE + "/api/doc")).json()).state.artboards.map((a) => a.name);
try {
  await assert.rejects(op("historySave", {}), /Nothing to save/); ok("an empty project has nothing to save");
  await op("createArtboard", { name: "One", width: 300 });
  const v1 = await op("historySave", { name: "First draft" }); assert.equal(v1.name, "First draft"); assert.equal(v1.auto, false);
  await op("createArtboard", { name: "Two", width: 300 });
  await sleep(1200); // the timer takes an automatic one because something changed
  let list = await op("historyList"); assert.ok(list.some((v) => v.auto), "an automatic snapshot was taken"); assert.equal(list.find((v) => v.name === "First draft").artboards, 1); ok("named and automatic versions are listed with what they contain");
  const n = list.length; await sleep(1000); assert.equal((await op("historyList")).length, n, "no new snapshot while nothing changes"); ok("nothing is saved again until something changes");
  await op("historyRestore", { id: v1.id });
  assert.deepEqual(await names(), ["One"]);
  list = await op("historyList"); assert.ok(list.some((v) => v.name === "Before restoring" && v.artboards === 2)); ok("restoring goes back, and keeps the design you had as a version");
  await op("undo"); assert.deepEqual(await names(), ["One", "Two"]); ok("and ⌘Z undoes a restore");
  const r = await op("historyRename", { id: list.find((v) => v.name === "Before restoring").id, name: "Two boards" }); assert.equal(r.auto, false);
  await op("historyDelete", { id: v1.id }); assert.ok(!(await op("historyList")).some((v) => v.id === v1.id)); ok("rename and delete");
  await assert.rejects(op("historyRestore", { id: "../../etc" }), /Unknown version/); await assert.rejects(op("historyRestore", { id: "zzzz" }), /no longer exists/); ok("bad ids are refused");
  console.log("\nHISTORY PASSED");
} catch (e) { console.error("\nFAILED:", e.stack?.split("\n").slice(0, 6).join("\n")); process.exitCode = 1; } finally { srv.kill(); }
