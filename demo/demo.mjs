// First design, built the way Claude builds it: through the MCP tools over stdio.
// Run: npm run demo   (builds "Welcome email" in the default project and saves demo/welcome-email.png)
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const client = new Client({ name: "demo", version: "1" });
await client.connect(new StdioClientTransport({ command: process.execPath, args: [path.join(here, "../server/mcp.js")], env: process.env }));
const call = async (name, args = {}) => {
  const r = await client.callTool({ name, arguments: args });
  if (r.isError) throw new Error(r.content[0].text);
  return r.content[0];
};
const json = async (...a) => JSON.parse((await call(...a)).text);

const ab = await json("create_artboard", { name: "Welcome email", width: 600, backgroundColor: "#faf7f2" });
await call("write_html", {
  targetNodeId: ab.id,
  html: `
<div layer-name="Header" style="display:flex;align-items:center;justify-content:space-between;padding:24px 40px">
  <span layer-name="Logo" style="font-family:'Inter Tight',sans-serif;font-weight:700;font-size:20px;letter-spacing:-0.02em;color:#111">Studio.</span>
  <span style="font-family:'Inter Tight',sans-serif;font-size:13px;color:#77776f">Welcome aboard</span>
</div>
<img layer-name="Hero image" src="${path.join(here, "hero.png")}" alt="Abstract sunrise" style="width:100%;height:240px;object-fit:cover">
<div layer-name="Body" style="display:flex;flex-direction:column;gap:16px;padding:40px 40px 32px">
  <h1 style="margin:0;font-family:'Instrument Serif',serif;font-weight:400;font-size:48px;line-height:1.05;letter-spacing:-0.01em;color:#111">Your first design is waiting.</h1>
  <p style="margin:0;font-family:'Inter Tight',sans-serif;font-size:17px;line-height:1.55;color:#4a4a45">Thanks for joining. Open the canvas, ask Claude for a layout, then drag things around until it feels right. Everything exports as one clean HTML file.</p>
  <div layer-name="CTA row" style="display:flex;padding-top:12px">
    <a href="https://example.com/start" layer-name="CTA button" style="font-family:'Inter Tight',sans-serif;font-weight:600;font-size:16px;color:#fff;background:#ff4f1f;padding:16px 32px;border-radius:999px;text-decoration:none">Start designing →</a>
  </div>
</div>
<div layer-name="Footer" style="display:flex;flex-direction:column;gap:4px;padding:24px 40px 32px;border-top:1px solid #e8e3d9">
  <span style="font-family:'Inter Tight',sans-serif;font-size:12px;color:#77776f">You received this because you signed up for Studio.</span>
</div>`,
});
const shot = await call("get_screenshot", { nodeId: ab.id, scale: 2 });
const out = path.join(here, "welcome-email.png");
fs.writeFileSync(out, Buffer.from(shot.data, "base64"));
console.log("artboard", ab.id, "-> screenshot saved to", out);
await client.close();
