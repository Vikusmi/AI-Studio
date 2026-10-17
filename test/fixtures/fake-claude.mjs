#!/usr/bin/env node
// A stand-in for `claude -p … --output-format stream-json`: records its arguments, edits the open project over HTTP like the Studio tools would,
// and prints the same kind of events. FAKE_MODE: ok (default) | slow | fail
import fs from "node:fs";
const args = process.argv.slice(2);
if (process.env.FAKE_ARGS_FILE) fs.writeFileSync(process.env.FAKE_ARGS_FILE, JSON.stringify(args));
const text = args[args.indexOf("-p") + 1] || "";
const cfg = JSON.parse(args[args.indexOf("--mcp-config") + 1]);
const port = cfg.mcpServers.studio.env.STUDIO_PORT;
const out = (o) => process.stdout.write(JSON.stringify(o) + "\n");
const op = async (name, a) => (await (await fetch(`http://127.0.0.1:${port}/api/op`, { method: "POST", body: JSON.stringify({ op: name, args: a }) })).json()).result;
const mode = process.env.FAKE_MODE || "ok";
out({ type: "system", subtype: "init", tools: ["mcp__studio__update_styles"], mcp_servers: [{ name: "studio", status: "connected" }] });
out({ type: "assistant", message: { content: [{ type: "tool_use", name: "mcp__studio__get_brand", input: {} }] } });
if (mode === "slow") { await new Promise((r) => setTimeout(r, 30000)); process.exit(0); }
if (mode === "fail") { out({ type: "result", subtype: "error", is_error: true, result: "Credit balance is too low" }); process.exit(1); }
const ids = [...text.matchAll(/\b(n\d+) \(/g)].map((m) => m[1]);
out({ type: "assistant", message: { content: [{ type: "tool_use", name: "mcp__studio__update_styles", input: {} }] } });
for (const id of ids) await op("updateStyles", { updates: [{ nodeIds: [id], styles: { "background-color": "#ff0000" } }] });
await op("updateStyles", { updates: [{ nodeIds: ids, styles: { opacity: "0.9" } }] });
out({ type: "assistant", message: { content: [{ type: "text", text: "Made it red." }] } });
out({ type: "result", subtype: "success", is_error: false, result: `Made ${ids.length} layer(s) red.`, total_cost_usd: 0.001 });
