// "Ask Claude" server tests, with a fake `claude` so nothing is spent and the result is deterministic.
// Run: node test/ask-test.mjs
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "studio-ask-"));
const FAKE = path.join(root, "test/fixtures/fake-claude.mjs"), ARGS = path.join(tmp, "args.json");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ok = (m) => console.log("  ✓", m);
const boot = async (port, env) => {
  const srv = spawn(process.execPath, [path.join(root, "server/server.js")], { env: { ...process.env, STUDIO_PORT: port, STUDIO_PROJECT: path.join(tmp, "proj" + port), ...env }, stdio: "ignore" });
  for (let i = 0; i < 40; i++) { try { await fetch(`http://127.0.0.1:${port}/api/ping`); break; } catch { await sleep(150); } }
  return srv;
};
const api = (port) => ({
  op: async (name, args = {}) => { const r = await fetch(`http://127.0.0.1:${port}/api/op`, { method: "POST", body: JSON.stringify({ op: name, args }) }); const j = await r.json(); if (!r.ok) throw new Error(j.error); return j.result; },
  post: async (p, body = {}) => { const r = await fetch(`http://127.0.0.1:${port}${p}`, { method: "POST", body: JSON.stringify(body) }); return { status: r.status, ...(await r.json()) }; },
  get: async (p) => (await fetch(`http://127.0.0.1:${port}${p}`)).json(),
  node: async (id) => (await (await fetch(`http://127.0.0.1:${port}/api/op`, { method: "POST", body: JSON.stringify({ op: "node", args: { nodeId: id } }) })).json()).result,
});
// collect SSE "ask" events
function listen(port) {
  const events = []; const ac = new AbortController();
  (async () => {
    const r = await fetch(`http://127.0.0.1:${port}/api/events`, { signal: ac.signal }); const rd = r.body.getReader(); const dec = new TextDecoder(); let buf = "";
    try { for (;;) { const { value, done } = await rd.read(); if (done) break; buf += dec.decode(value); let i; while ((i = buf.indexOf("\n\n")) >= 0) { const blk = buf.slice(0, i); buf = buf.slice(i + 2); if (blk.startsWith("event: ask")) events.push(JSON.parse(blk.split("data: ")[1])); } } } catch {}
  })();
  return { events, stop: () => ac.abort(), until: async (kinds, ms = 8000) => { const t = Date.now(); while (Date.now() - t < ms) { if (events.some((e) => kinds.includes(e.kind))) return events.find((e) => kinds.includes(e.kind)); await sleep(50); } throw new Error("timed out waiting for " + kinds + " (got " + events.map((e) => e.kind) + ")"); } };
}

let srv;
try {
  // ---------- not installed ----------
  srv = await boot(4791, { STUDIO_CLAUDE_BIN: path.join(tmp, "nope") });
  let a = api(4791);
  assert.equal((await a.get("/api/ask")).available, false);
  const r0 = await a.post("/api/ask", { prompt: "hi" }); assert.equal(r0.status, 400); assert.match(r0.error, /Claude Code isn't installed/);
  ok("without Claude Code installed: clear message, nothing breaks"); srv.kill(); await sleep(300);

  // ---------- a normal run ----------
  srv = await boot(4792, { STUDIO_CLAUDE_BIN: FAKE, FAKE_ARGS_FILE: ARGS });
  a = api(4792);
  assert.equal((await a.get("/api/ask")).available, true);
  const ab = await a.op("createArtboard", { name: "A", width: 400 });
  const [box] = await a.op("insert", { parentId: ab.id, html: `<div layer-name="Hero" style="width:100px;height:50px;background-color:#00ff00;opacity:1"></div>` });
  const ev = listen(4792); await sleep(200);
  assert.equal((await a.post("/api/ask", { prompt: "   " })).status, 400);
  const started = await a.post("/api/ask", { prompt: "make it red", selection: [box.id] }); assert.equal(started.ok, true);
  assert.equal((await a.post("/api/ask", { prompt: "again" })).status, 400, "only one run at a time");
  const done = await ev.until(["done", "error"]); assert.equal(done.kind, "done"); assert.match(done.text, /red/); assert.equal(done.canUndo, true);
  const kinds = ev.events.map((e) => e.kind); assert.equal(kinds[0], "start"); assert.ok(kinds.includes("tool") && kinds.includes("text"));
  assert.ok(ev.events.some((e) => e.kind === "tool" && e.text === "Reading the brand kit") && ev.events.some((e) => e.kind === "tool" && e.text === "Changing styles"), "tool calls are shown in plain words");
  assert.equal((await a.node(box.id)).style["background-color"], "#ff0000"); ok("a request streams its progress (start, plain-language tool steps, answer) and edits the open project");
  const args = JSON.parse(fs.readFileSync(ARGS, "utf8"));
  assert.ok(args.includes("--strict-mcp-config") && args[args.indexOf("--tools") + 1] === "" && args[args.indexOf("--allowedTools") + 1] === "mcp__studio" && args[args.indexOf("--permission-mode") + 1] === "dontAsk");
  assert.match(args[args.indexOf("-p") + 1], new RegExp(`${box.id} \\(Hero\\)`)); assert.match(args[args.indexOf("-p") + 1], /Request: make it red/);
  assert.match(args[args.indexOf("--append-system-prompt") + 1], /get_brand first/); assert.ok(!args.some((x) => /api[_-]?key/i.test(x)));
  assert.equal(args[args.indexOf("--model") + 1], "claude-sonnet-5-5"); assert.equal(args[args.indexOf("--effort") + 1], "medium");
  ok("it only gets the Studio tools (no files, no shell, no other servers), is told the selection, and no API key is involved");
  // undo the whole run
  const u = await a.post("/api/ask/undo"); assert.equal(u.status, 200); assert.equal(u.undone, 2, "all changes of the run undone together");
  assert.equal((await a.node(box.id)).style["background-color"], "#00ff00"); assert.equal((await a.node(box.id)).style.opacity, "1");
  assert.equal((await a.post("/api/ask/undo")).status, 400); ok("“Undo” steps back through everything the run changed, once");
  // run again, then edit by hand: undo is refused so your own edit is never lost
  ev.events.length = 0;
  await a.post("/api/ask", { prompt: "again", selection: [box.id] }); await ev.until(["done"]);
  await a.op("updateStyles", { updates: [{ nodeIds: [box.id], styles: { width: "300px" } }] });
  const refused = await a.post("/api/ask/undo"); assert.equal(refused.status, 400); assert.match(refused.error, /edited since/); assert.equal((await a.node(box.id)).style.width, "300px");
  ok("undo is refused after you edited by hand (your changes are never thrown away)");
  ev.stop(); srv.kill(); await sleep(300);

  // ---------- cancel ----------
  srv = await boot(4793, { STUDIO_CLAUDE_BIN: FAKE, FAKE_MODE: "slow" }); a = api(4793); const ev2 = listen(4793); await sleep(200);
  await a.post("/api/ask", { prompt: "take your time" }); await ev2.until(["tool"]);
  assert.equal((await a.post("/api/ask/cancel")).ok, true); const c = await ev2.until(["cancelled", "error"]); assert.equal(c.kind, "cancelled");
  assert.equal((await a.get("/api/ask")).run.running, false); assert.equal((await a.post("/api/ask", { prompt: "next" })).status, 200); ok("a run can be stopped, and the next one starts fine");
  ev2.stop(); srv.kill(); await sleep(300);

  // ---------- failure ----------
  srv = await boot(4794, { STUDIO_CLAUDE_BIN: FAKE, FAKE_MODE: "fail" }); a = api(4794); const ev3 = listen(4794); await sleep(200);
  await a.post("/api/ask", { prompt: "x" }); const f = await ev3.until(["error", "done"]); assert.equal(f.kind, "error"); assert.match(f.text, /Credit balance/); assert.equal((await a.get("/api/ask")).run.running, false);
  ok("a failed run shows Claude's own message and leaves the app usable");
  ev3.stop();

  console.log("\nASK TESTS PASSED");
} catch (e) {
  console.error("\nFAILED:", e.stack?.split("\n").slice(0, 6).join("\n") || e.message); process.exitCode = 1;
} finally { try { srv && srv.kill(); } catch {} }
