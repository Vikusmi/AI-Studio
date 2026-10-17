// "Ask Claude": runs Claude Code headlessly with only the Studio tools, using the user's own Claude login (no API key is stored here).
// Progress is streamed to the editor; a run can be cancelled, and everything it changed can be undone in one go.
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export function findClaude() {
  // an explicit binary (used by tests) is the only one considered
  if (process.env.STUDIO_CLAUDE_BIN !== undefined) { try { return fs.statSync(process.env.STUDIO_CLAUDE_BIN).isFile() ? process.env.STUDIO_CLAUDE_BIN : null; } catch { return null; } }
  const home = os.homedir();
  const cands = [process.env.STUDIO_CLAUDE_BIN, path.join(home, ".local/bin/claude"), "/opt/homebrew/bin/claude", "/usr/local/bin/claude", path.join(home, ".claude/local/claude"), path.join(home, ".npm-global/bin/claude")].filter(Boolean);
  for (const p of (process.env.PATH || "").split(path.delimiter)) if (p) cands.push(path.join(p, "claude"));
  return cands.find((p) => { try { return fs.statSync(p).isFile(); } catch { return false; } }) || null;
}

const SYSTEM = `You are the design copilot inside Studio, a local design canvas. Everything you can do is done with the studio tools; they edit the open project live while the user watches.
- Call get_brand first and use its fonts and named colours. Follow the notes in it.
- Change only what was asked. Keep the existing structure, names and content unless the request says otherwise.
- After a layout change, check your work with get_screenshot.
- Never ask questions: make reasonable choices and finish. End with ONE short sentence saying what you changed.`;

const HUMAN = {
  get_basic_info: "Looking at the project", get_tree_summary: "Reading the layers", get_children: "Reading the layers", get_node_info: "Reading a layer", get_selection: "Checking your selection", get_brand: "Reading the brand kit", get_guide: "Reading the guide",
  get_screenshot: "Checking the result", update_styles: "Changing styles", set_text_content: "Rewriting text", write_html: "Adding layers", set_attributes: "Updating a layer", duplicate_nodes: "Duplicating", delete_nodes: "Removing layers", rename_nodes: "Renaming layers",
  move_nodes: "Moving layers", reorder_nodes: "Changing layer order", group_nodes: "Grouping layers", ungroup_nodes: "Ungrouping", apply_style: "Applying a style", create_style: "Creating a style", create_component: "Making a component", create_instance: "Adding an instance", create_artboard: "Creating an artboard", set_brand: "Updating the brand kit", split_text_from_box: "Separating text", undo: "Undoing", export: "Exporting",
};

export function createAsk({ port, mcpPath, getDoc, broadcast }) {
  let run = null;
  const emit = (ev) => { if (run) run.events.push(ev); broadcast({ id: run && run.id, ...ev }); };
  const view = () => (run ? { id: run.id, running: run.running, prompt: run.prompt, events: run.events, canUndo: !!run.canUndo, started: run.started } : null);

  function start({ prompt, selection = [] }) {
    const doc = getDoc();
    if (run && run.running) throw new Error("Claude is still working on the last request.");
    const bin = findClaude();
    if (!bin) throw new Error("Claude Code isn't installed. Install it and sign in once by running `claude` in a terminal; Studio then uses your own login.");
    const names = selection.map((id) => { try { const n = doc.need(id).node; return `${id} (${doc.label(n)})`; } catch { return null; } }).filter(Boolean);
    const text = `${names.length ? `The user has selected: ${names.join(", ")}.\n` : ""}Request: ${String(prompt).trim()}`;
    const cfg = JSON.stringify({ mcpServers: { studio: { command: process.execPath, args: [mcpPath], env: { STUDIO_PORT: String(port) } } } });
    const args = ["-p", text, "--output-format", "stream-json", "--verbose", "--mcp-config", cfg, "--strict-mcp-config", "--allowedTools", "mcp__studio", "--tools", "", "--permission-mode", "dontAsk", "--append-system-prompt", SYSTEM, "--no-session-persistence"];
    // Sonnet 5.5 at medium effort unless overridden (STUDIO_CLAUDE_MODEL / STUDIO_CLAUDE_EFFORT)
    args.push("--model", process.env.STUDIO_CLAUDE_MODEL || "claude-sonnet-5-5", "--effort", process.env.STUDIO_CLAUDE_EFFORT || "medium");
    run = { id: Math.random().toString(36).slice(2, 9), running: true, prompt: String(prompt).trim(), events: [], startDepth: doc.undoStack.length, started: Date.now(), canUndo: false };
    const r = run;
    const home = os.homedir();
    const child = spawn(bin, args, { cwd: os.tmpdir(), stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, PATH: [path.join(home, ".local/bin"), "/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin", process.env.PATH || ""].join(path.delimiter) } });
    r.child = child;
    let buf = "", err = "", finished = false;
    const finish = (ev) => {
      const doc = getDoc();
      if (finished) return; finished = true; r.running = false; clearTimeout(timer);
      r.endVersion = doc.version; r.canUndo = doc.undoStack.length > r.startDepth;
      emit({ ...ev, canUndo: r.canUndo });
    };
    const handle = (line) => {
      let j; try { j = JSON.parse(line); } catch { return; }
      if (j.type === "assistant") for (const b of (j.message && j.message.content) || []) {
        if (b.type === "tool_use") { const nm = String(b.name || "").replace(/^mcp__studio__/, ""); emit({ kind: "tool", text: HUMAN[nm] || nm.replace(/_/g, " ") }); }
        else if (b.type === "text" && b.text && b.text.trim()) emit({ kind: "text", text: b.text.trim() });
      } else if (j.type === "result") {
        if (j.is_error) finish({ kind: "error", text: String(j.result || "Claude couldn't finish this request.") });
        else finish({ kind: "done", text: String(j.result || "Done."), cost: j.total_cost_usd });
      }
    };
    child.stdout.on("data", (d) => { buf += d; let i; while ((i = buf.indexOf("\n")) >= 0) { const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1); if (line) handle(line); } });
    child.stderr.on("data", (d) => { err += d; });
    child.on("error", (e) => finish({ kind: "error", text: "Couldn't start Claude Code: " + e.message }));
    child.on("close", (code) => { if (buf.trim()) handle(buf.trim()); if (!finished) finish(r.cancelled ? { kind: "cancelled", text: "Stopped." } : { kind: "error", text: (err.trim().split("\n").pop() || `Claude exited with code ${code}.`).slice(0, 300) }); });
    const timer = setTimeout(() => { r.cancelled = false; try { child.kill("SIGTERM"); } catch {} finish({ kind: "error", text: "That took too long (6 minutes), so it was stopped." }); }, 6 * 60 * 1000);
    emit({ kind: "start", text: r.prompt });
    return view();
  }
  function cancel() {
    if (!run || !run.running) return false;
    run.cancelled = true;
    try { run.child.kill("SIGTERM"); } catch {}
    return true;
  }
  // everything the run changed, undone together (refused if you have changed things since, so your own edits are never lost)
  function undoRun() {
    const doc = getDoc();
    if (!run || run.running) throw new Error("Nothing to undo.");
    if (!run.canUndo) throw new Error("This request didn't change anything.");
    if (doc.version !== run.endVersion) throw new Error("You've edited since then. Use ⌘Z to step back through your own changes.");
    let n = 0;
    while (doc.undoStack.length > run.startDepth && doc.undo()) n++;
    run.canUndo = false;
    emit({ kind: "undone", text: `Undid ${n} change${n === 1 ? "" : "s"}.` });
    return n;
  }
  return { start, cancel, undoRun, view, available: () => !!findClaude() };
}
