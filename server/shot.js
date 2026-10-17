// Screenshots through the Chrome already on this machine (no browser download needed).
import fs from "node:fs";
import puppeteer from "puppeteer-core";
import { planSlices } from "./slices.js";

const CANDIDATES = [
  process.env.CHROME_PATH,
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/Applications/Chromium.app/Contents/MacOS/Chromium",
  "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
  "/usr/bin/google-chrome",
  "/usr/bin/chromium",
  "/usr/bin/chromium-browser",
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
].filter(Boolean);

let browser;
async function getBrowser() {
  if (browser && browser.connected) return browser;
  const executablePath = CANDIDATES.find((p) => fs.existsSync(p));
  if (!executablePath) throw new Error("Chrome not found. Set CHROME_PATH to your Chrome/Chromium executable.");
  browser = await puppeteer.launch({ executablePath, headless: true, args: ["--no-sandbox", "--hide-scrollbars"] });
  return browser;
}
export async function closeBrowser() {
  if (browser) await browser.close().catch(() => {});
  browser = null;
}

// type: png | jpeg | webp. nodeIds: render several elements of the same page (slices) and return an array of buffers.
export async function screenshot(html, { nodeId, nodeIds, width = 600, scale = 1, type = "png", quality = 90 }) {
  const b = await getBrowser();
  const page = await b.newPage();
  try {
    await page.setViewport({ width: Math.round(width), height: 900, deviceScaleFactor: scale });
    await page.setContent(html, { waitUntil: "networkidle0", timeout: 20000 });
    await page.evaluate(() => document.fonts && document.fonts.ready);
    const shoot = async (id) => {
      const el = await page.$(`[data-node-id="${id}"]`);
      if (!el) throw new Error("Could not find that node on the page.");
      return Buffer.from(await el.screenshot({ type, ...(type !== "png" ? { quality: Math.max(1, Math.min(100, Math.round(quality))) } : {}) }));
    };
    if (nodeIds) { const out = []; for (const id of nodeIds) out.push(await shoot(id)); return out; }
    return await shoot(nodeId);
  } finally {
    await page.close();
  }
}

// One PDF, one page per block, each page exactly the size of its artboard (Chrome's named @page sizes).
// html contains <section data-pg="ID"> wrappers; sizes are measured first, then the page rules are added.
export async function renderPdf(html) {
  const b = await getBrowser();
  const page = await b.newPage();
  try {
    await page.setViewport({ width: 1200, height: 900 });
    await page.setContent(html, { waitUntil: "networkidle0", timeout: 30000 });
    await page.evaluate(() => document.fonts && document.fonts.ready);
    const sizes = await page.evaluate(() => [...document.querySelectorAll("section[data-pg]")].map((s) => { const r = s.getBoundingClientRect(); return { id: s.dataset.pg, w: Math.ceil(r.width), h: Math.ceil(r.height) }; }));
    if (!sizes.length) throw new Error("Nothing to export.");
    const css = sizes.map((z, i) => `@page p${i}{size:${z.w}px ${z.h}px;margin:0}section[data-pg="${z.id}"]{page:p${i}}`).join("") + `section[data-pg]{break-after:page;break-inside:avoid}section[data-pg]:last-of-type{break-after:auto}html,body{background:#fff!important}`;
    await page.addStyleTag({ content: css });
    return Buffer.from(await page.pdf({ preferCSSPageSize: true, printBackground: true }));
  } finally {
    await page.close();
  }
}

// Render one block (an artboard or a section) and cut it into slices around its links, for image-based email.
// Returns { width, height, rows: [{ y, h, cells: [{ x, w, href?, alt, buf }] }] } with the images rendered at `scale`x.
export async function renderSliced(html, { nodeId, width = 600, scale = 2, bg = "#ffffff", format = "jpeg", quality = 88 } = {}) {
  const b = await getBrowser();
  const page = await b.newPage();
  try {
    await page.setViewport({ width: Math.max(1, Math.round(width)), height: 900, deviceScaleFactor: scale });
    await page.setContent(html, { waitUntil: "networkidle0", timeout: 25000 });
    await page.addStyleTag({ content: `html,body{background:${bg}!important;margin:0!important;padding:0!important}body>*{margin:0!important}` });
    await page.evaluate(() => document.fonts && document.fonts.ready);
    const info = await page.evaluate((id) => {
      const root = document.querySelector(`[data-node-id="${id}"]`);
      if (!root) return null;
      const rr = root.getBoundingClientRect();
      const rel = (r) => ({ x: r.left - rr.left, y: r.top - rr.top, w: r.width, h: r.height });
      const links = [...root.querySelectorAll("a[href]")].map((a) => ({ href: a.getAttribute("href"), ...rel(a.getBoundingClientRect()) }));
      const texts = [];
      const walk = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
      for (let n = walk.nextNode(); n; n = walk.nextNode()) {
        const t = n.textContent.replace(/\s+/g, " ").trim();
        if (!t) continue;
        const r = document.createRange(); r.selectNodeContents(n);
        texts.push({ t, ...rel(r.getBoundingClientRect()) });
      }
      return { w: rr.width, h: rr.height, links, texts, x: rr.left, y: rr.top };
    }, nodeId);
    if (!info) throw new Error("Could not find that block on the page.");
    const rows = planSlices(info.w, info.h, info.links);
    for (const row of rows) {
      for (const c of row.cells) {
        const inside = info.texts.filter((t) => t.x + t.w / 2 >= c.x && t.x + t.w / 2 < c.x + c.w && t.y + t.h / 2 >= row.y && t.y + t.h / 2 < row.y + row.h).map((t) => t.t);
        c.alt = [...new Set(inside)].join(" ").slice(0, 240);
        c.buf = Buffer.from(await page.screenshot({ type: format, ...(format === "jpeg" ? { quality } : {}), clip: { x: info.x + c.x, y: info.y + row.y, width: c.w, height: row.h }, captureBeyondViewport: true }));
      }
    }
    return { width: Math.round(info.w), height: Math.round(info.h), rows, format };
  } finally {
    await page.close();
  }
}
