// The Assets tab (components, colour styles, text styles, brand kit) and the inspector bits that go with them.
// Everything here talks to the server through ctx.op, so Claude and the editor share one set of operations.

const TEXT_KEYS = ["font-family", "font-size", "font-weight", "font-style", "line-height", "letter-spacing", "text-transform", "text-decoration"];

// what the layer really looks like (handles `font:` shorthands and inherited fonts); defaults are left out
function textSpec(el) {
  if (!el) return null;
  const cs = getComputedStyle(el), out = {};
  for (const k of TEXT_KEYS) {
    const v = cs.getPropertyValue(k).trim();
    if (!v || ["normal", "none", "0px", "start"].includes(v) || (k === "text-decoration" && /^none/.test(v))) continue;
    out[k] = k === "text-decoration" ? v.split(" ")[0] : v;
  }
  return out["font-family"] || out["font-size"] ? out : null;
}

export function initAssets(ctx) {
  const { $, op, toast, esc } = ctx;
  const box = $("#assets");
  const tabs = document.querySelectorAll("[data-ptab]");
  let tab = "layers";
  try { tab = localStorage.getItem("studio-ptab") || "layers"; } catch {}

  function setTab(t) {
    tab = t;
    try { localStorage.setItem("studio-ptab", t); } catch {}
    tabs.forEach((b) => b.classList.toggle("on", b.dataset.ptab === t));
    $("#layers-list").hidden = t !== "layers";
    box.hidden = t !== "assets";
    const np = $("#notes-panel"); if (np) np.hidden = t !== "notes";
    if (t === "assets") render();
    window.dispatchEvent(new CustomEvent("studio-tab", { detail: t }));
  }
  tabs.forEach((b) => (b.onclick = () => setTab(b.dataset.ptab)));

  const styles = () => ctx.state.styles || {};
  const colors = () => Object.entries(styles()).filter(([, s]) => s.kind === "color").map(([id, s]) => ({ id, ...s }));
  const texts = () => Object.entries(styles()).filter(([, s]) => s.kind === "text").map(([id, s]) => ({ id, ...s }));
  const comps = () => Object.entries(ctx.state.components || {}).map(([id, c]) => {
    let main = null, uses = 0;
    const walk = (n) => { if (n.component === id) main = n; if (n.instanceOf === id) uses++; (n.children || []).forEach(walk); };
    ctx.state.artboards.forEach(walk);
    return { id, name: c.name, main, uses };
  });
  const brand = () => ctx.state.brand || { name: "", fonts: { heading: "", body: "", mono: "" }, logo: null, notes: "" };
  const src = (u) => (u && u.startsWith("assets/") ? "/" + u : u);

  // ---------- rendering ----------
  function render() {
    if (box.hidden) return;
    const b = brand(), cs = colors(), ts = texts(), cp = comps();
    box.innerHTML = `
      <div class="asec"><div class="ahead"><h4>Components</h4><button data-new-comp title="Make the selected layer a component">＋</button></div>
        ${cp.length ? cp.map((c) => `<div class="aitem" draggable="true" data-comp="${c.id}" title="Click to add an instance · drag onto the canvas"><span class="aic">◆</span><b>${esc(c.name)}</b><span class="muted">${c.uses} use${c.uses === 1 ? "" : "s"}</span></div>`).join("") : `<p class="ahint">Select a layer or frame and press ＋ (or right-click → Create component). Instances follow the main layer.</p>`}
      </div>
      <div class="asec"><div class="ahead"><h4>Colours</h4><button data-new-color title="New colour style from the selection's fill">＋</button></div>
        ${cs.length ? `<div class="aswatches">${cs.map((c) => `<button class="sw" data-style="${c.id}" title="${esc(c.name)} · ${esc(c.value)}" style="background:${esc(c.value)}"></button>`).join("")}</div>
        <div class="alist">${cs.map((c) => `<div class="aitem" data-style="${c.id}"><i class="swc" style="background:${esc(c.value)}"></i><b>${esc(c.name)}</b><span class="muted">${esc(c.value)}</span></div>`).join("")}</div>
        <p class="ahint">Click = fill · ⇧ text colour · ⌥ border. Right-click to edit.</p>` : `<p class="ahint">Colour styles you link to layers: change one and everything using it follows.</p>`}
      </div>
      <div class="asec"><div class="ahead"><h4>Text styles</h4><button data-new-text title="New text style from the selected text">＋</button></div>
        ${ts.length ? ts.map((t) => `<div class="aitem" data-style="${t.id}"><span class="tspec" style="font-family:${esc(t.css["font-family"] || "inherit")};font-weight:${esc(t.css["font-weight"] || 400)}">Aa</span><b>${esc(t.name)}</b><span class="muted">${esc(t.css["font-size"] || "")} ${esc((t.css["font-family"] || "").split(",")[0].replace(/['"]/g, ""))}</span></div>`).join("") : `<p class="ahint">Select a text layer and press ＋ to save its fonts as a style.</p>`}
      </div>
      <div class="asec"><div class="ahead"><h4>Fonts</h4><button data-add-font title="Upload a font file (.woff2, .woff, .ttf, .otf)">＋</button></div>
        ${fontsHtml()}
      </div>
      <div class="asec"><div class="ahead"><h4>Brand</h4><button data-brand-url class="atext" title="Read the name, colours, fonts and logo from a website">From website…</button></div>
        <div class="f full"><label>Brand name</label><input data-brand="name" value="${esc(b.name)}" placeholder="e.g. AG1"></div>
        <div class="grid2">
          <div class="f"><label>Heading font</label><input data-brand-font="heading" list="fonts" value="${esc(b.fonts.heading)}"></div>
          <div class="f"><label>Body font</label><input data-brand-font="body" list="fonts" value="${esc(b.fonts.body)}"></div>
          <div class="f full"><label>Mono / label font</label><input data-brand-font="mono" list="fonts" value="${esc(b.fonts.mono)}"></div>
        </div>
        <div class="f full"><label>Logo</label>
          <div class="logoslot">${b.logo ? `<img src="${esc(src(b.logo))}" alt="logo">` : `<span class="muted">No logo yet</span>`}</div>
          <div class="row2"><button data-logo-set>${b.logo ? "Replace…" : "Upload…"}</button><button data-logo-insert ${b.logo ? "" : "disabled"}>Insert</button>${b.logo ? `<button data-logo-clear title="Remove logo">×</button>` : ""}</div>
        </div>
        <div class="f full"><label>Notes for Claude (tone, rules)</label><textarea data-brand="notes" rows="3" placeholder="Editorial, calm, no emojis…">${esc(b.notes)}</textarea></div>
      </div>`;
    box.appendChild(iconSec);
  }

  // ---------- icons: the built-in library (kept between renders, so the search survives Claude's edits) ----------
  const iconSec = document.createElement("div"); iconSec.className = "asec icons";
  iconSec.innerHTML = `<div class="ahead"><h4>Icons</h4><span class="muted">Lucide</span></div><input type="search" data-icon-q placeholder="Search 1,500 icons: arrow, cart, star…"><div class="icon-grid"></div><p class="ahint">Click to add to the selected frame. The line colour follows the layer's text colour.</p>`;
  const iconGrid = iconSec.querySelector(".icon-grid"), iconQ = iconSec.querySelector("[data-icon-q]");
  let iconT;
  async function searchIcons() {
    const list = await op("searchIcons", { query: iconQ.value, limit: 48 });
    iconGrid.innerHTML = list.map((i) => `<button data-icon="${esc(i.name)}" title="${esc(i.name)}"><img src="/api/icon?name=${encodeURIComponent(i.name)}&size=20" alt=""></button>`).join("") || `<span class="muted">No icon matches.</span>`;
  }
  iconQ.addEventListener("input", () => { clearTimeout(iconT); iconT = setTimeout(searchIcons, 120); });
  iconQ.addEventListener("keydown", (e) => e.stopPropagation());
  iconGrid.addEventListener("click", async (e) => {
    const b = e.target.closest("[data-icon]"); if (!b) return;
    const parent = ctx.insertTarget(); if (!parent) return toast("Create an artboard first.");
    try { const r = await op("insertIcon", { name: b.dataset.icon, parentId: parent, size: 32, color: "#161616" }); ctx.select(r.map((x) => x.id)); } catch {}
  });
  window.addEventListener("studio-tab", (e) => { if (e.detail === "assets" && !iconGrid.children.length) searchIcons(); });
  window.addEventListener("studio-refresh", () => { if (!box.hidden) render(); fontList(); });

  const fontsHtml = () => {
    const fs = ctx.state.fonts || [];
    if (!fs.length) return `<p class="ahint">Upload your own font files (a brand typeface, say). They are saved inside the project and work in every export.</p>`;
    const fam = [...new Set(fs.map((f) => f.family))];
    return fam.map((f) => `<div class="aitem" data-font="${esc(f)}"><span class="tspec" style="font-family:'${esc(f)}'">Aa</span><b>${esc(f)}</b><span class="muted">${fs.filter((x) => x.family === f).map((x) => x.weight + (x.style === "italic" ? "i" : "")).join(" ")}</span><button data-del-font="${esc(f)}" title="Remove">×</button></div>`).join("") + `<p class="ahint">Type the name in a text layer's Font field to use it.</p>`;
  };
  function addFont() {
    const inp = document.createElement("input"); inp.type = "file"; inp.accept = ".woff2,.woff,.ttf,.otf";
    inp.onchange = () => {
      const file = inp.files[0]; if (!file) return;
      const pop = ctx.pop; pop.hidden = false; pop.style.left = "260px"; pop.style.top = "120px";
      const guess = file.name.replace(/\.[^.]+$/, "").replace(/[-_](regular|bold|italic|light|medium|semibold|black|thin|extrabold)\b.*$/i, "").replace(/[-_]+/g, " ");
      const w = /thin/i.test(file.name) ? "100" : /extralight/i.test(file.name) ? "200" : /light/i.test(file.name) ? "300" : /medium/i.test(file.name) ? "500" : /semibold/i.test(file.name) ? "600" : /extrabold/i.test(file.name) ? "800" : /black/i.test(file.name) ? "900" : /bold/i.test(file.name) ? "700" : "400";
      pop.innerHTML = `<div class="f"><label>Font name</label><input id="ft-name" value="${esc(guess)}"></div><div class="grid2"><div class="f"><label>Weight</label><select id="ft-w">${[100,200,300,400,500,600,700,800,900].map((n) => `<option ${String(n) === w ? "selected" : ""}>${n}</option>`).join("")}</select></div><div class="f"><label>Style</label><select id="ft-s"><option>normal</option><option ${/italic/i.test(file.name) ? "selected" : ""}>italic</option></select></div></div>
        <div class="muted" style="font-size:11px">One file = one weight. Add the other weights the same way, with the same name.</div>
        <div class="row" style="justify-content:flex-end"><button id="ft-no">Cancel</button><button id="ft-ok" class="primary">Add font</button></div>`;
      $("#ft-no").onclick = () => (pop.hidden = true);
      pop.onkeydown = (e) => { e.stopPropagation(); if (e.key === "Escape") pop.hidden = true; if (e.key === "Enter") $("#ft-ok").click(); };
      $("#ft-ok").onclick = async () => {
        const q = new URLSearchParams({ family: $("#ft-name").value, weight: $("#ft-w").value, style: $("#ft-s").value, name: file.name });
        const r = await fetch("/api/font?" + q, { method: "POST", body: file }); const j = await r.json();
        if (!r.ok) return toast(j.error || "Couldn't add the font");
        pop.hidden = true; toast(`“${j.font.family}” added. Type it in a Font field to use it.`);
      };
      $("#ft-name").focus(); $("#ft-name").select();
    };
    inp.click();
  }

  // the brand kit read from a website: name, colours, fonts, logo
  function brandFromUrl() {
    const pop = ctx.pop; pop.hidden = false; pop.style.left = "260px"; pop.style.top = "120px";
    pop.innerHTML = `<div class="f"><label>Website</label><input id="bu-url" placeholder="e.g. drinkag1.com"></div><div class="muted" style="font-size:11px">Studio reads the site's name, main colours, fonts and logo into this project's brand kit. Check them after.</div><div class="row" style="justify-content:flex-end"><button id="bu-no">Cancel</button><button id="bu-ok" class="primary">Read brand</button></div>`;
    const inp = $("#bu-url"); inp.focus();
    $("#bu-no").onclick = () => (pop.hidden = true);
    const go = async () => {
      if (!inp.value.trim()) return inp.focus();
      $("#bu-ok").disabled = true; $("#bu-ok").textContent = "Reading…";
      try { const b = await op("setBrandFromUrl", { url: inp.value.trim() }); pop.hidden = true; toast(`Brand kit set from ${b.brand.name || "the website"}: ${b.colors.length} colours, ${b.brand.fonts.heading || "no"} / ${b.brand.fonts.body || "no"} fonts.`); }
      catch { $("#bu-ok").disabled = false; $("#bu-ok").textContent = "Read brand"; }
    };
    $("#bu-ok").onclick = go;
    pop.onkeydown = (e) => { e.stopPropagation(); if (e.key === "Enter") go(); if (e.key === "Escape") pop.hidden = true; };
  }

  // brand fonts lead the font suggestions
  function fontList() {
    const dl = $("#fonts"); if (!dl) return;
    const f = brand().fonts || {};
    const mine = [f.heading, f.body, f.mono].filter(Boolean);
    const base = ctx.FONTS.filter((x) => !mine.includes(x));
    const html = [...new Set([...mine, ...(ctx.state.fonts || []).map((x) => x.family), ...base])].map((x) => `<option value="${esc(x)}">`).join("");
    if (dl.dataset.sig !== html) { dl.innerHTML = html; dl.dataset.sig = html; }
  }

  // ---------- actions ----------
  const sel = () => ctx.selection.filter((id) => ctx.nodeOf(id));
  async function insertInstance(cid, at) {
    let parent = at && at.parentId ? at.parentId : ctx.insertTarget();
    if (!parent) return toast("Create an artboard first.");
    // never inside the component itself: step out to the frame the main layer sits in
    const main = comps().find((c) => c.id === cid)?.main;
    if (main) {
      const inside = parent === main.id || !!ctx.find(parent, main.children || []);
      if (inside) { const r = ctx.find(main.id); parent = r && r.parent ? r.parent.id : parent; }
    }
    try {
      const r = await op("createInstance", { componentId: cid, parentId: parent, ...(at && at.style ? { style: at.style } : {}) });
      ctx.select([r.id]);
    } catch {}
  }
  async function makeComponent(id) {
    const n = ctx.nodeOf(id);
    if (!n || n.artboard) return toast("Select a layer or a frame to make a component.");
    if (n.instanceOf) return toast("That layer is an instance already. Detach it first.");
    if (n.component) return toast("That layer is already a component.");
    try { const r = await op("createComponent", { nodeId: id }); toast(`“${r.name}” is a component now. Add more from the Assets tab.`); setTab("assets"); } catch {}
  }
  async function newColor() {
    const id = sel()[0], n = id && ctx.nodeOf(id), st = (n && n.style) || {};
    let v = st["background-color"] || st.color || "";
    if (!/^#|rgb|hsl/.test(v)) v = "#0c3d3d";
    try { await op("createStyle", { kind: "color", name: "Colour " + (colors().length + 1), value: v }); } catch {}
  }
  async function newText() {
    const id = sel()[0], css = id && textSpec(ctx.elFor(id));
    if (!css) return toast("Select a layer with text to save its fonts as a style.");
    try { await op("createStyle", { kind: "text", name: "Text " + (texts().length + 1), css }); } catch {}
  }
  async function applyColor(sid, e) {
    const ids = sel(); if (!ids.length) return toast("Select a layer first.");
    try { await op("applyStyle", { nodeIds: ids, styleId: sid, prop: e.shiftKey ? "color" : e.altKey ? "border-color" : "background-color" }); } catch {}
  }
  async function applyText(sid) {
    const ids = sel(); if (!ids.length) return toast("Select a text layer first.");
    try { await op("applyStyle", { nodeIds: ids, styleId: sid }); } catch {}
  }
  function editStyle(sid) {
    const s = styles()[sid]; if (!s) return;
    const pop = ctx.pop;
    pop.hidden = false;
    pop.style.left = Math.min(innerWidth - 290, 260) + "px"; pop.style.top = "120px";
    pop.innerHTML = `<div class="f"><label>Name</label><input id="st-name" value="${esc(s.name)}"></div>
      ${s.kind === "color" ? `<div class="f"><label>Colour</label><div class="colorrow"><input type="color" id="st-col" value="${/^#[0-9a-f]{6}$/i.test(s.value) ? s.value : "#000000"}"><input type="text" id="st-val" value="${esc(s.value)}"></div></div>`
        : `<div class="f"><label>Fonts</label><div class="muted" style="font-size:12px;line-height:1.5">${Object.entries(s.css).map(([k, v]) => `${esc(k)}: ${esc(v)}`).join("<br>")}</div></div><button id="st-from">Update from the selected text</button>`}
      <div class="row" style="justify-content:space-between"><button id="st-del" class="danger-text">Delete</button><button id="st-ok" class="primary">Done</button></div>`;
    const close = () => (pop.hidden = true);
    $("#st-ok").onclick = async () => { const nm = $("#st-name").value.trim(); if (nm && nm !== s.name) await op("updateStyle", { id: sid, name: nm }); close(); };
    $("#st-del").onclick = async () => { close(); await op("deleteStyle", { id: sid }); toast("Style deleted. Layers keep their values."); };
    if (s.kind === "color") {
      $("#st-col").oninput = (e) => { $("#st-val").value = e.target.value; };
      $("#st-col").onchange = (e) => op("updateStyle", { id: sid, value: e.target.value });
      $("#st-val").onchange = (e) => e.target.value.trim() && op("updateStyle", { id: sid, value: e.target.value.trim() });
    } else {
      $("#st-from").onclick = async () => {
        const css = sel()[0] && textSpec(ctx.elFor(sel()[0]));
        if (!css) return toast("Select a text layer first.");
        await op("updateStyle", { id: sid, css }); close();
      };
    }
    pop.onkeydown = (e) => { e.stopPropagation(); if (e.key === "Escape") close(); if (e.key === "Enter" && e.target.id !== "st-from") $("#st-ok").click(); };
    $("#st-name").focus(); $("#st-name").select();
  }
  function compMenu(x, y, cid) {
    const c = comps().find((k) => k.id === cid); if (!c) return;
    ctx.openMenu(x, y, [
      ["Add instance", () => insertInstance(cid)],
      ["Go to main component", () => { if (c.main) { ctx.select([c.main.id]); ctx.fit([c.main.id]); } }, { disabled: !c.main }], "-",
      ["Rename…", () => renameComp(cid)],
      ["Delete component", () => ctx.confirmBox(`Delete the component “${c.name}”? Its ${c.uses} instance${c.uses === 1 ? "" : "s"} become${c.uses === 1 ? "s" : ""} plain layers.`, "Delete", () => op("deleteComponent", { componentId: cid })), { danger: true }],
    ]);
  }
  function renameComp(cid) {
    const row = box.querySelector(`[data-comp="${cid}"] b`); if (!row) return;
    const input = document.createElement("input"); input.value = row.textContent; input.className = "rename"; input.style.width = "100%";
    row.replaceWith(input); input.focus(); input.select();
    let done = false;
    const finish = async (ok) => { if (done) return; done = true; if (ok && input.value.trim()) await op("renameComponent", { componentId: cid, name: input.value.trim() }); else render(); };
    input.onkeydown = (e) => { e.stopPropagation(); if (e.key === "Enter") finish(true); if (e.key === "Escape") finish(false); };
    input.onblur = () => finish(true);
  }

  // ---------- events (delegated) ----------
  box.addEventListener("click", async (e) => {
    const t = e.target;
    if (t.closest("[data-add-font]")) return addFont();
    const df = t.closest("[data-del-font]"); if (df) return op("removeFont", { family: df.dataset.delFont }).then(() => toast("Font removed. ⌘Z brings it back.")).catch((er) => toast(er.message));
    if (t.closest("[data-new-comp]")) { const id = sel()[0]; return id ? makeComponent(id) : toast("Select a layer or a frame first."); }
    if (t.closest("[data-new-color]")) return newColor();
    if (t.closest("[data-new-text]")) return newText();
    if (t.closest("[data-logo-set]")) return ctx.pickImage(async (s) => { try { await op("setBrand", { logo: s }); } catch {} });
    if (t.closest("[data-brand-url]")) return brandFromUrl();
    if (t.closest("[data-logo-clear]")) return op("setBrand", { logo: "" });
    if (t.closest("[data-logo-insert]")) { const l = brand().logo; return l && ctx.insertHtml(`<img layer-name="Logo" src="${l}" style="height:40px;width:auto;display:block">`); }
    const it = t.closest("[data-comp]"); if (it && !t.closest("input")) return insertInstance(it.dataset.comp);
    const si = t.closest("[data-style]");
    if (si) { const s = styles()[si.dataset.style]; if (s) return s.kind === "color" ? applyColor(si.dataset.style, e) : applyText(si.dataset.style); }
  });
  box.addEventListener("dblclick", (e) => { const si = e.target.closest("[data-style]"); if (si) editStyle(si.dataset.style); const c = e.target.closest("[data-comp]"); if (c) renameComp(c.dataset.comp); });
  box.addEventListener("contextmenu", (e) => {
    const si = e.target.closest("[data-style]"), c = e.target.closest("[data-comp]");
    if (!si && !c) return;
    e.preventDefault();
    if (c) return compMenu(e.clientX, e.clientY, c.dataset.comp);
    ctx.openMenu(e.clientX, e.clientY, [["Edit…", () => editStyle(si.dataset.style)], ["Delete style", () => op("deleteStyle", { id: si.dataset.style }), { danger: true }]]);
  });
  box.addEventListener("change", (e) => {
    const t = e.target;
    if (t.dataset.brand) return op("setBrand", { [t.dataset.brand]: t.value });
    if (t.dataset.brandFont) return op("setBrand", { fonts: { [t.dataset.brandFont]: t.value.trim() } });
  });
  box.addEventListener("keydown", (e) => e.stopPropagation());
  // drag a component onto the canvas: an instance lands where you drop it
  box.addEventListener("dragstart", (e) => { const c = e.target.closest("[data-comp]"); if (!c) return; e.dataTransfer.setData("text/studio-component", c.dataset.comp); e.dataTransfer.effectAllowed = "copy"; });

  setTab(tab);
  fontList();
  return { render, makeComponent, insertInstance, setTab, comps, styles, colors, texts };
}

// ---- inspector pieces ----
export function componentBanner(ctx, n) {
  const c = (ctx.state.components || {});
  if (n.component && c[n.component]) return `<div class="compbar"><span class="aic">◆</span><b>Component · ${ctx.esc(c[n.component].name)}</b><span class="muted">edits reach every instance</span></div>`;
  if (n.instanceOf && c[n.instanceOf]) return `<div class="compbar inst"><span class="aic">◇</span><b>Instance of ${ctx.esc(c[n.instanceOf].name)}</b><button data-comp-go="${n.instanceOf}">Go to main</button><button data-comp-detach>Detach</button></div>`;
  return "";
}
export function styleSelect(ctx, n, prop, label) {
  const cs = Object.entries(ctx.state.styles || {}).filter(([, s]) => s.kind === "color");
  if (!cs.length) return "";
  const cur = n.refs && n.refs[prop];
  return `<div class="f full"><label>${label}</label><select data-cstyle="${prop}"><option value="">None (custom)</option>${cs.map(([id, s]) => `<option value="${id}" ${cur === id ? "selected" : ""}>${ctx.esc(s.name)} · ${ctx.esc(s.value)}</option>`).join("")}</select></div>`;
}
export function textStyleSelect(ctx, n) {
  const ts = Object.entries(ctx.state.styles || {}).filter(([, s]) => s.kind === "text");
  if (!ts.length) return "";
  const cur = n.refs && n.refs.text;
  return `<div class="f full"><label>Text style</label><select data-tstyle><option value="">None (custom)</option>${ts.map(([id, s]) => `<option value="${id}" ${cur === id ? "selected" : ""}>${ctx.esc(s.name)}</option>`).join("")}</select></div>`;
}
export function wireInspector(ctx, n, root) {
  const { op } = ctx;
  root.querySelectorAll("[data-cstyle]").forEach((s) => (s.onchange = () => (s.value ? op("applyStyle", { nodeIds: ctx.selection, styleId: s.value, prop: s.dataset.cstyle }) : op("detachStyle", { nodeIds: ctx.selection, prop: s.dataset.cstyle }))));
  root.querySelectorAll("[data-tstyle]").forEach((s) => (s.onchange = () => (s.value ? op("applyStyle", { nodeIds: ctx.selection, styleId: s.value }) : op("detachStyle", { nodeIds: ctx.selection, prop: "text" }))));
  root.querySelectorAll("[data-comp-go]").forEach((b) => (b.onclick = () => { let main = null; const w = (x) => { if (x.component === b.dataset.compGo) main = x; (x.children || []).forEach(w); }; ctx.state.artboards.forEach(w); if (main) { ctx.select([main.id]); ctx.fit([main.id]); } }));
  root.querySelectorAll("[data-comp-detach]").forEach((b) => (b.onclick = () => op("detachInstance", { nodeIds: ctx.selection })));
}
