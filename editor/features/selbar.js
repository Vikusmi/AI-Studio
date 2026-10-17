// Quick actions on what you select, in a small bar above it: tell Claude what to change, make variations, pin a note for your chat,
// remove an image's background or upscale it, review an artboard. Plus: picking a variation, the design review panel,
// resizing an artboard to other formats and saving it as a template.
const SEV = { high: "High", medium: "Medium", low: "Low" };

export function initSelbar(ctx, { ask }) {
  const { $, op, toast, esc, es, elFor, viewport, select, nodeOf, artboardOf, label, fit } = ctx;
  const bar = document.createElement("div"); bar.id = "selbar"; bar.hidden = true; viewport.appendChild(bar);
  const vlayer = document.createElement("div"); vlayer.id = "variant-layer"; viewport.appendChild(vlayer);
  const review = document.createElement("div"); review.id = "review"; review.hidden = true; document.body.appendChild(review);
  const dlg = document.createElement("div"); dlg.id = "qdlg"; dlg.hidden = true; document.body.appendChild(dlg);
  let mode = "buttons", running = false, available = null, forIds = "";
  for (const el of [bar, vlayer, review, dlg]) { el.addEventListener("pointerdown", (e) => e.stopPropagation()); el.addEventListener("keydown", (e) => e.stopPropagation()); }

  async function checkAvailable() { try { const r = await (await fetch("/api/ask")).json(); available = r.available; running = !!(r.run && r.run.running); } catch {} return available; }
  checkAvailable();
  const needClaude = () => { toast("Claude Code isn't installed here. Install it and run `claude` once in a terminal to sign in, or ask in your Claude chat."); };

  async function start(body) {
    if (available === false && !(await checkAvailable())) return needClaude();
    const r = await fetch("/api/ask", { method: "POST", body: JSON.stringify(body) }); const j = await r.json();
    if (!r.ok) { toast(j.error || "Couldn't start"); return false; }
    running = true; mode = "buttons"; draw();
    return true;
  }

  // ---- the bar ----
  const ICON = {
    edit: `<svg viewBox="0 0 24 24"><path d="M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8z"/></svg>`,
    vary: `<svg viewBox="0 0 24 24"><rect x="3.5" y="3.5" width="7" height="7" rx="1.5"/><rect x="13.5" y="3.5" width="7" height="7" rx="1.5"/><rect x="3.5" y="13.5" width="7" height="7" rx="1.5"/><rect x="13.5" y="13.5" width="7" height="7" rx="1.5"/></svg>`,
    note: `<svg viewBox="0 0 24 24"><path d="M5 4h14v11l-5 5H5z"/><path d="M14 20v-5h5"/></svg>`,
    cut: `<svg viewBox="0 0 24 24"><circle cx="12" cy="9" r="4"/><path d="M5 20c1.5-3.5 4-5 7-5s5.5 1.5 7 5"/><path d="M3 3l18 18" opacity=".5"/></svg>`,
    up: `<svg viewBox="0 0 24 24"><path d="M4 20h16M12 16V4M7 9l5-5 5 5"/></svg>`,
    check: `<svg viewBox="0 0 24 24"><path d="M4 12.5l5 5L20 6.5"/></svg>`,
  };
  function draw() {
    const sel = ctx.selection, n = sel.length === 1 ? nodeOf(sel[0]) : null;
    const img = n && (n.tag === "img" || n.crop);
    if (running) { bar.innerHTML = `<span class="sb-working"><span class="cdot"></span>Claude is working…</span><button data-sb="stop">Stop</button>`; return; }
    if (mode === "edit") {
      bar.innerHTML = `<span class="sb-mark">✦</span><input id="sb-text" placeholder="Tell Claude what to change… e.g. bolder, more space, warmer colours"><button data-sb="send" class="primary">Send ↵</button><button data-sb="cancel" class="x" title="Cancel">×</button>`;
      const t = $("#sb-text", bar); setTimeout(() => t.focus(), 0);
      t.onkeydown = (e) => { e.stopPropagation(); if (e.key === "Enter") { e.preventDefault(); send(); } if (e.key === "Escape") { mode = "buttons"; draw(); } };
      return;
    }
    if (mode === "vary") {
      bar.innerHTML = `<span class="sb-mark">✦</span><span class="muted">Variations</span><div class="seg small">${[2, 3, 4].map((k) => `<button data-count="${k}" class="${k === 3 ? "on" : ""}">${k}</button>`).join("")}</div><input id="sb-dir" placeholder="Direction (optional): bolder, minimal, playful…"><button data-sb="vary-go" class="primary">Make</button><button data-sb="cancel" class="x" title="Cancel">×</button>`;
      const t = $("#sb-dir", bar); setTimeout(() => t.focus(), 0);
      t.onkeydown = (e) => { e.stopPropagation(); if (e.key === "Enter") { e.preventDefault(); vary(); } if (e.key === "Escape") { mode = "buttons"; draw(); } };
      return;
    }
    const b = (k, ic, lab, tip) => `<button data-sb="${k}" title="${tip}">${ICON[ic]}<span>${lab}</span></button>`;
    const what = n ? (n.artboard ? n.name || "Artboard" : label(n)) : `${sel.length} layers`;
    bar.innerHTML = `<span class="sb-what" title="Claude's quick actions work on your selection">✦ ${esc(String(what).slice(0, 28))}</span>` + [
      b("edit", "edit", "Edit", "Tell Claude what to change here (it works on your selection)"),
      b("vary", "vary", "Variations", "Claude makes a few different versions side by side; you keep one"),
      b("note", "note", "Note", "Pin a note for Claude in your chat (N)"),
      img ? b("remove-bg", "cut", "Remove BG", "Remove the background (Claude with Magnific)") : "",
      img ? b("upscale", "up", "Upscale", "Upscale 2× (Claude with Magnific)") : "",
      n && n.artboard ? b("review", "check", "Review", "Check this artboard for problems: contrast, overflow, small text, blurry images…") : "",
    ].join("");
  }
  function send() {
    const t = $("#sb-text", bar), prompt = t && t.value.trim();
    if (!prompt) return t && t.focus();
    start({ prompt, selection: ctx.selection });
  }
  function vary() {
    const count = Number(bar.querySelector("[data-count].on")?.dataset.count || 3), dir = $("#sb-dir", bar)?.value.trim() || "";
    variations(ctx.selection, { count, direction: dir });
  }
  async function variations(ids, { count = 3, direction = "" } = {}) {
    ids = (ids || []).filter((id) => nodeOf(id));
    if (!ids.length) return toast("Select an artboard or a layer first.");
    const ab = artboardOf(ids[0]);
    if (await start({ mode: "variations", count, prompt: direction, selection: [ids[0]] })) {
      setTimeout(() => { const set = nodeOf(ab.id)?.variant?.set; if (set) fit(ctx.state.artboards.filter((a) => a.variant && a.variant.set === set).map((a) => a.id)); }, 500);
    }
  }
  bar.addEventListener("click", (e) => {
    const c = e.target.closest("[data-count]"); if (c) { bar.querySelectorAll("[data-count]").forEach((x) => x.classList.toggle("on", x === c)); return; }
    const b = e.target.closest("[data-sb]"); if (!b) return;
    const k = b.dataset.sb, sel = ctx.selection;
    if (k === "stop") return fetch("/api/ask/cancel", { method: "POST", body: "{}" });
    if (k === "cancel") { mode = "buttons"; return draw(); }
    if (k === "send") return send();
    if (k === "vary-go") return vary();
    if (k === "note") return ctx.notesCompose(sel);
    if (k === "review") return openReview(sel[0]);
    if (k === "remove-bg" || k === "upscale") return imageJob(sel[0], k);
    if ((k === "edit" || k === "vary") && available === false) return needClaude();
    mode = k; draw(); place();
  });
  async function imageJob(id, kind) { await start({ mode: kind, selection: [id] }); }

  // docked just above the tools at the bottom, so it never covers the design you're clicking on
  function place() {
    const sel = ctx.selection, d = ctx.drag;
    const hide = !sel.length || ctx.editing || ctx.cropping || (d && d.moved) || !$("#preview").hidden || !$("#home").hidden || document.querySelector("#present");
    if (hide && !running && mode === "buttons") { bar.hidden = true; return; }
    if (!sel.some((id) => elFor(id)) && !running) { bar.hidden = true; return; }
    const key = sel.join(",");
    if (key !== forIds) { forIds = key; if (!running) mode = "buttons"; draw(); }
    bar.hidden = false;
  }
  // ---- variations: pick one ----
  const chips = new Map();
  function placeVariants() {
    const vr = viewport.getBoundingClientRect(), live = new Set();
    for (const a of ctx.state.artboards) {
      if (!a.variant) continue;
      const el = elFor(a.id); if (!el) continue;
      live.add(a.id);
      let c = chips.get(a.id);
      if (!c) { c = document.createElement("div"); c.className = "vchip"; c.dataset.ab = a.id; vlayer.appendChild(c); chips.set(a.id, c); }
      const orig = a.variant.n === 0;
      const html = `${orig ? `<span>Original</span><button data-vk="pick">Keep original</button><button data-vk="discard" title="Remove all the variations">Discard all</button>` : `<span>Variation ${a.variant.n}</span><button data-vk="pick" class="primary">Use this</button>`}`;
      if (c.dataset.html !== html) { c.innerHTML = html; c.dataset.html = html; }
      const r = el.getBoundingClientRect();
      c.style.left = r.left - vr.left + "px"; c.style.top = r.bottom - vr.top + 10 + "px";
    }
    for (const [id, c] of chips) if (!live.has(id)) { c.remove(); chips.delete(id); }
  }
  vlayer.addEventListener("click", async (e) => {
    const b = e.target.closest("[data-vk]"); if (!b) return;
    const id = b.closest(".vchip").dataset.ab, a = nodeOf(id);
    if (!a || !a.variant) return;
    if (b.dataset.vk === "pick") { await op("pickVariant", { nodeId: id }); select([id]); setTimeout(() => fit([id]), 80); toast(a.variant.n === 0 ? "Kept the original." : `Kept variation ${a.variant.n}.`); }
    else ctx.confirmBox("Remove all the variations and keep the original?", "Discard", async () => { await op("discardVariants", { set: a.variant.set }); });
  });

  // ---- design review ----
  async function openReview(id) {
    const ab = artboardOf(id); if (!ab) return toast("Select an artboard to review.");
    review.hidden = false;
    review.innerHTML = `<div class="rv-head"><b>Review</b><span class="muted">${esc(ab.name || "Artboard")}</span><button class="x" title="Close">×</button></div><div class="rv-body"><div class="muted rv-loading">Checking contrast, overflow, text sizes, images, spacing…</div></div>`;
    review.querySelector(".x").onclick = () => (review.hidden = true);
    let r;
    try { r = await op("critique", { nodeId: ab.id }); } catch { review.hidden = true; return; }
    const body = review.querySelector(".rv-body");
    if (!r.issues.length) { body.innerHTML = `<div class="rv-ok">${ICON.check}<b>Looks good.</b><span class="muted">No problems found.</span></div>`; return; }
    body.innerHTML = `<div class="rv-sum">${["high", "medium", "low"].map((s) => r.summary[s] ? `<span class="sev ${s}">${r.summary[s]} ${SEV[s].toLowerCase()}</span>` : "").join("")}</div>
      <div class="rv-list">${r.issues.map((i, k) => `<button class="rv-item" data-k="${k}"><span class="sev-dot ${i.severity}"></span><span class="rv-msg">${esc(i.message)}${i.name ? `<span class="muted">${esc(i.name)}</span>` : ""}</span></button>`).join("")}</div>
      <div class="rv-foot"><button data-rv="again">Check again</button><button data-rv="fix" class="primary">✦ Ask Claude to fix</button></div>`;
    body.onclick = (e) => {
      const it = e.target.closest(".rv-item");
      if (it) { const i = r.issues[it.dataset.k]; if (i.nodeId && nodeOf(i.nodeId)) { select([i.nodeId]); ctx.reveal(i.nodeId); } return; }
      const b = e.target.closest("[data-rv]"); if (!b) return;
      if (b.dataset.rv === "again") return openReview(ab.id);
      const list = r.issues.filter((i) => i.severity !== "low").concat(r.issues.filter((i) => i.severity === "low")).slice(0, 25).map((i, k) => `${k + 1}. [${i.severity}] ${i.message}${i.nodeId ? ` (layer ${i.nodeId})` : ""}`).join("\n");
      start({ prompt: `Fix these problems found by a design review of the artboard “${ab.name}” (${ab.id}). Keep the design and content otherwise the same, then run critique again to confirm.\n${list}`, selection: [ab.id] });
      review.hidden = true;
    };
  }

  // ---- dialogs: resize to formats, save as template ----
  function dialog(html, wire) {
    dlg.hidden = false; dlg.innerHTML = `<div class="xbox">${html}</div>`;
    const close = () => (dlg.hidden = true);
    dlg.onclick = (e) => { if (e.target === dlg || e.target.closest("[data-close]")) close(); };
    dlg.onkeydown = (e) => { e.stopPropagation(); if (e.key === "Escape") close(); };
    wire(dlg, close);
  }
  function resize(id) {
    const ab = artboardOf(id); if (!ab) return;
    const w0 = parseInt(ab.style.width, 10) || 600, h0 = parseInt(ab.style.height, 10) || 0;
    const groups = ctx.PRESETS.filter(([g]) => g !== "Email");
    dialog(`<h3>Resize “${esc(ab.name || "Artboard")}” to other formats</h3><p class="muted">Copies at each size, placed to the right. Free-placed layers keep their place in the frame; everything scales evenly. A starting point: ask Claude to tidy each one.</p>
      <div class="rz-groups">${groups.map(([g, items]) => `<div class="rz-g"><h4>${g}</h4>${items.filter(([, w, h]) => !(w === w0 && h === h0)).map(([nm, w, h]) => `<label class="chk"><input type="checkbox" data-w="${w}" data-h="${h || ""}" data-n="${esc(nm)}"> ${esc(nm)} <span class="muted">${w}×${h || "auto"}</span></label>`).join("")}</div>`).join("")}</div>
      <div class="row"><div class="f"><label>Custom width</label><input id="rz-w" type="number" placeholder="px"></div><div class="f"><label>Custom height</label><input id="rz-h" type="number" placeholder="px"></div></div>
      <div class="row" style="justify-content:flex-end"><button data-close>Cancel</button><button id="rz-go" class="primary">Create copies</button></div>`, (box, close) => {
      box.querySelector("#rz-go").onclick = async () => {
        const sizes = [...box.querySelectorAll("input[type=checkbox]:checked")].map((c) => ({ width: +c.dataset.w, height: c.dataset.h ? +c.dataset.h : undefined, name: `${ab.name || "Artboard"} · ${c.dataset.n}` }));
        const cw = +box.querySelector("#rz-w").value, ch = +box.querySelector("#rz-h").value;
        if (cw) sizes.push({ width: cw, height: ch || undefined });
        if (!sizes.length) return toast("Pick at least one format.");
        close();
        const made = await op("resizeArtboard", { nodeId: ab.id, sizes });
        select(made.map((m) => m.id)); setTimeout(() => fit([ab.id, ...made.map((m) => m.id)]), 80);
        toast(`${made.length} cop${made.length === 1 ? "y" : "ies"} made. Ask Claude to tidy them, or adjust by hand.`);
      };
    });
  }
  function saveTemplate(id) {
    const ab = artboardOf(id); if (!ab) return;
    dialog(`<h3>Save as template</h3><p class="muted">Reuse this artboard in any project: from the home screen, or + Artboard. Claude can use it too.</p>
      <div class="f"><label>Name</label><input id="tp-name" value="${esc(ab.name || "Template")}"></div>
      <div class="row" style="justify-content:flex-end"><button data-close>Cancel</button><button id="tp-go" class="primary">Save template</button></div>`, (box, close) => {
      const inp = box.querySelector("#tp-name"); inp.focus(); inp.select();
      const go = async () => { close(); const t = await op("saveTemplate", { nodeId: ab.id, name: inp.value.trim() || ab.name }); toast(`Saved “${t.name}” as a template.`); };
      box.querySelector("#tp-go").onclick = go;
      inp.onkeydown = (e) => { e.stopPropagation(); if (e.key === "Enter") go(); if (e.key === "Escape") close(); };
    });
  }

  ctx.onOverlay(() => { place(); placeVariants(); });
  es.addEventListener("ask", (e) => {
    const ev = JSON.parse(e.data);
    if (ev.kind === "start") { running = true; draw(); place(); }
    if (["done", "error", "cancelled"].includes(ev.kind)) { running = false; mode = "buttons"; draw(); place(); }
  });
  // ⌘K with something selected: type the request right on the selection
  const edit = () => { if (available === false) return needClaude(); mode = "edit"; forIds = ctx.selection.join(","); draw(); place(); };
  return { variations, review: openReview, resize, saveTemplate, imageJob, draw, edit };
}
