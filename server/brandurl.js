// A brand kit read from a website: its name, logo, main colours and fonts. Heuristics over the page and its stylesheets
// (theme colour, the colours used most that aren't grey, the font families declared most, a logo image or icon).
const UA = { "user-agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15", accept: "text/html,text/css,*/*" };

async function get(url, ms = 12000) {
  const ac = new AbortController(); const t = setTimeout(() => ac.abort(), ms);
  try { const r = await fetch(url, { headers: UA, signal: ac.signal, redirect: "follow" }); if (!r.ok) throw new Error(`${r.status}`); return { text: await r.text(), url: r.url || url }; }
  finally { clearTimeout(t); }
}
const hex2 = (n) => n.toString(16).padStart(2, "0");
function norm(c) {
  c = c.trim().toLowerCase();
  let m = /^#([0-9a-f]{3})$/.exec(c); if (m) return "#" + m[1].split("").map((x) => x + x).join("");
  m = /^#([0-9a-f]{6})(?:[0-9a-f]{2})?$/.exec(c); if (m) return "#" + m[1];
  m = /^rgba?\(\s*(\d+)[\s,]+(\d+)[\s,]+(\d+)(?:[\s,/]+([\d.]+%?))?\s*\)$/.exec(c);
  if (m) { if (m[4] !== undefined && parseFloat(m[4]) < (m[4].endsWith("%") ? 50 : 0.5)) return null; return "#" + [m[1], m[2], m[3]].map((x) => hex2(Math.min(255, +x))).join(""); }
  return null;
}
const rgb = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
const sat = (h) => { const [r, g, b] = rgb(h).map((x) => x / 255); const mx = Math.max(r, g, b), mn = Math.min(r, g, b); return mx === 0 ? 0 : (mx - mn) / mx; };
const lum = (h) => { const [r, g, b] = rgb(h); return (0.299 * r + 0.587 * g + 0.114 * b) / 255; };
const dist = (a, b) => { const x = rgb(a), y = rgb(b); return Math.hypot(x[0] - y[0], x[1] - y[1], x[2] - y[2]); };
const GENERIC = /^(inherit|initial|unset|sans-serif|serif|monospace|cursive|fantasy|system-ui|ui-sans-serif|ui-serif|ui-monospace|-apple-system|blinkmacsystemfont|segoe ui|roboto|helvetica neue|helvetica|arial|noto sans|apple color emoji|segoe ui emoji|segoe ui symbol|noto color emoji|var\(.*|.*icon.*|.*awesome.*|.*glyph.*|times new roman|times|courier new|courier|menlo|monaco|consolas)$/i;

export async function brandFromUrl(url) {
  if (!/^https?:\/\//i.test(url)) url = "https://" + String(url).trim();
  const page = await get(url);
  const html = page.text, origin = page.url;
  const abs = (u) => { try { return new URL(u.replace(/&amp;/g, "&"), origin).href; } catch { return null; } };
  const attr = (tag, a) => { const m = new RegExp(`\\b${a}\\s*=\\s*("([^"]*)"|'([^']*)')`, "i").exec(tag); return m ? m[2] ?? m[3] : null; };
  const tags = (name) => [...html.matchAll(new RegExp(`<${name}\\b[^>]*>`, "gi"))].map((m) => m[0]);
  const metas = tags("meta"), links = tags("link"), imgs = tags("img");
  const metaOf = (k) => { const t = metas.find((m) => (attr(m, "property") || attr(m, "name") || "").toLowerCase() === k); return t ? attr(t, "content") : null; };

  // stylesheets: inline <style> blocks, style="" attributes and up to four linked sheets
  let css = [...html.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style>/gi)].map((m) => m[1]).join("\n") + "\n" + [...html.matchAll(/style\s*=\s*"([^"]*)"/gi)].map((m) => m[1]).join(";\n");
  const sheets = links.filter((l) => /stylesheet/i.test(attr(l, "rel") || "")).map((l) => abs(attr(l, "href") || "")).filter(Boolean);
  const googleFamilies = [];
  for (const s of sheets) { if (/fonts\.googleapis\.com/.test(s)) for (const m of s.matchAll(/family=([^&:]+)/g)) googleFamilies.push(decodeURIComponent(m[1]).replace(/\+/g, " ")); }
  const own = sheets.filter((s) => !/fonts\.googleapis\.com|use\.typekit|cdnjs|jsdelivr/.test(s)).slice(0, 4);
  const got = await Promise.allSettled(own.map((s) => get(s, 8000)));
  for (const g of got) if (g.status === "fulfilled") css += "\n" + g.value.text.slice(0, 1_500_000);

  // colours: frequency, without greys (except one dark and one light neutral), similar ones merged
  const counts = new Map();
  for (const m of css.matchAll(/#[0-9a-f]{3,8}\b|rgba?\([^)]*\)/gi)) { const c = norm(m[0]); if (c) counts.set(c, (counts.get(c) || 0) + 1); }
  const theme = norm(metaOf("theme-color") || "") || null;
  const vivid = [...counts].filter(([c]) => sat(c) > 0.18 && lum(c) > 0.06 && lum(c) < 0.97).sort((a, b) => b[1] - a[1]);
  const picked = [];
  for (const [c] of [...(theme && sat(theme) > 0.18 ? [[theme, 1e9]] : []), ...vivid]) { if (picked.every((p) => dist(p, c) > 48)) picked.push(c); if (picked.length >= 5) break; }
  const neutrals = [...counts].filter(([c]) => sat(c) <= 0.18).sort((a, b) => b[1] - a[1]).map(([c]) => c);
  const dark = neutrals.find((c) => lum(c) < 0.25) || "#111111", light = neutrals.find((c) => lum(c) > 0.93 && c !== "#ffffff") || "#ffffff";
  const colors = [...picked.map((value, i) => ({ name: i === 0 ? "Primary" : i === 1 ? "Secondary" : `Accent ${i - 1}`, value })), { name: "Ink", value: dark }, { name: "Paper", value: light }];

  // fonts: the families declared most, headings first when we can tell
  const fam = new Map(), headFam = new Map();
  for (const m of css.matchAll(/([^{}]*)\{[^{}]*?font-family\s*:\s*([^;}]+)/gi)) {
    const first = m[2].split(",").map((x) => x.trim().replace(/^['"]|['"]$/g, "").replace(/\s*!important$/, "")).find((x) => x && !GENERIC.test(x));
    if (!first) continue;
    fam.set(first, (fam.get(first) || 0) + 1);
    if (/\bh[1-3]\b|heading|title|display|hero/i.test(m[1])) headFam.set(first, (headFam.get(first) || 0) + 1);
  }
  for (const g of googleFamilies) fam.set(g, (fam.get(g) || 0) + 3);
  const byCount = (m) => [...m].sort((a, b) => b[1] - a[1]).map(([f]) => f);
  const body = byCount(fam)[0] || "";
  const heading = byCount(headFam).find((f) => f !== body) || byCount(fam).find((f) => f !== body) || body;

  // logo: an image that says logo, else the apple-touch-icon, else the og:image
  const logoImg = imgs.find((t) => /logo/i.test((attr(t, "src") || "") + " " + (attr(t, "alt") || "") + " " + (attr(t, "class") || "") + " " + (attr(t, "id") || "")));
  const icon = links.find((l) => /apple-touch-icon/i.test(attr(l, "rel") || "")) || links.find((l) => /\bicon\b/i.test(attr(l, "rel") || ""));
  const logo = (logoImg && abs(attr(logoImg, "src") || "")) || (icon && abs(attr(icon, "href") || "")) || (metaOf("og:image") && abs(metaOf("og:image"))) || null;
  const title = (/<title[^>]*>([\s\S]*?)<\/title>/i.exec(html) || [])[1] || "";
  const name = (metaOf("og:site_name") || title.split(/[|–—·:-]/)[0] || new URL(origin).hostname.replace(/^www\./, "")).trim().slice(0, 60);
  const description = (metaOf("og:description") || metaOf("description") || "").trim().slice(0, 300);
  return { url: origin, name, description, colors, fonts: { heading, body }, logo, notes: description ? `From ${new URL(origin).hostname}: ${description}` : `From ${new URL(origin).hostname}` };
}
