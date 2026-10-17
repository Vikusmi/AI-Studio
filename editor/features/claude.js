// Claude in the editor: what it's doing right now (the chip in the top bar, highlights on the layers it touches), a Keep / Undo bar
// when it pauses after changing things, a notice when it works on another project, and a banner when the app runs outdated code.
export function initClaude(ctx) {
  const { $, op, toast, esc, es, elFor, viewport, confirmBox } = ctx;
  const layer = document.createElement("div"); layer.id = "ai-layer"; viewport.appendChild(layer);
  const bar = document.createElement("div"); bar.id = "runbar"; bar.hidden = true; viewport.appendChild(bar);
  const bg = document.createElement("div"); bg.id = "bg-note"; bg.hidden = true; document.body.appendChild(bg);
  const banner = document.createElement("div"); banner.id = "stale"; banner.hidden = true; document.body.appendChild(banner);
  const chip = $("#claude-chip");
  // the canvas captures the pointer on pointerdown: keep it away from these controls
  for (const el of [bar, bg, banner]) el.addEventListener("pointerdown", (e) => e.stopPropagation());
  let run = null, lastOp = 0, lastLabel = "", connected = null;
  const marks = new Map(); // node id -> { box, until }
  let tag = null;

  // ---- what Claude touches, as it happens ----
  function place() {
    const vr = viewport.getBoundingClientRect(), now = Date.now();
    let first = null;
    for (const [id, m] of marks) {
      const el = elFor(id);
      if (!el || m.until < now) { m.box.remove(); marks.delete(id); continue; }
      const r = el.getBoundingClientRect();
      Object.assign(m.box.style, { left: r.left - vr.left + "px", top: r.top - vr.top + "px", width: r.width + "px", height: r.height + "px" });
      if (!first || r.top < first.top) first = { top: r.top - vr.top, left: r.left - vr.left };
    }
    if (tag) { if (first && now - lastOp < 2500) { tag.hidden = false; tag.style.left = first.left + "px"; tag.style.top = first.top + "px"; } else tag.hidden = true; }
  }
  ctx.onOverlay(place);
  function highlight(ids, label) {
    const until = Date.now() + 1800;
    for (const id of ids) {
      if (!elFor(id)) continue;
      let m = marks.get(id);
      if (m) { m.box.remove(); }
      const box = document.createElement("div"); box.className = "ai-box";
      layer.appendChild(box);
      marks.set(id, { box, until });
    }
    if (!tag) { tag = document.createElement("div"); tag.className = "ai-tag"; layer.appendChild(tag); }
    tag.textContent = "✦ Claude · " + label;
    place();
    clearTimeout(highlight.t); highlight.t = setTimeout(() => { place(); drawChip(); drawBar(); }, 1900);
    setTimeout(place, 2600);
  }

  // ---- the chip in the top bar ----
  function drawChip() {
    if (!chip) return;
    const working = Date.now() - lastOp < 2500;
    chip.className = "claude-chip" + (working ? " working" : connected ? " on" : "");
    chip.innerHTML = `<span class="cdot"></span><span class="clab">${working ? `Claude · ${esc(lastLabel)}` : connected ? "Claude connected" : "Claude"}</span>`;
    chip.title = working ? "Claude is changing this project" : connected ? "Claude Code is connected through MCP: ask in your chat and it designs here" : "Connect Claude Code to design from your chat (see the home screen)";
  }
  async function refreshConnection() {
    try { const c = await op("connection"); connected = !!(c.hello || c.configured); if (c.stale) showStale(c.stale); drawChip(); return c; } catch { return null; }
  }
  if (chip) chip.onclick = () => { if (run && run.open && run.ops) bar.hidden = false; else toast(connected ? "Ask Claude in your chat; it designs here. Select something and press N to pin a note it can read." : "Connect Claude Code from the home screen to design from your chat."); };

  // ---- keep or undo, when Claude pauses ----
  function drawBar() {
    const working = Date.now() - lastOp < 1500;
    if (!run || !run.open || !run.ops || working || run.projectId !== ctx.project?.id) { bar.hidden = true; return; }
    const labels = (run.labels || []).slice(-3).join(", ");
    bar.innerHTML = `<span class="rb-mark">✦</span><span class="rb-text"><b>Claude made ${run.ops} change${run.ops === 1 ? "" : "s"}</b><span class="muted">${esc(labels)}</span></span><button data-rb="undo">Undo</button><button data-rb="keep" class="primary">Keep</button>`;
    bar.hidden = false;
  }
  bar.onclick = async (e) => {
    const b = e.target.closest("[data-rb]"); if (!b) return;
    if (b.dataset.rb === "keep") { await op("agentKeep"); bar.hidden = true; return; }
    try { await op("agentUndo"); bar.hidden = true; toast("Undone. ⌘Z brings Claude's changes back."); }
    catch (err) {
      if (!/edited since/.test(err.message)) return;
      confirmBox("You've edited since Claude's changes. Undoing them goes back to before Claude started and also removes your edits. (A version from before is in History.)", "Undo anyway", async () => { await op("agentUndo", { force: true }); bar.hidden = true; toast("Undone."); });
    }
  };

  // ---- Claude in another project ----
  let bgTimer;
  function showBg(projectId, name) {
    if (!projectId || projectId === ctx.project?.id) return;
    bg.innerHTML = `<span class="rb-mark">✦</span><span>Claude is working on <b>${esc(name || projectId)}</b></span><button data-open="${esc(projectId)}">Open</button><button class="x" title="Hide">×</button>`;
    bg.hidden = false;
    clearTimeout(bgTimer); bgTimer = setTimeout(() => (bg.hidden = true), 9000);
  }
  bg.onclick = (e) => { const o = e.target.closest("[data-open]"); if (o) { bg.hidden = true; ctx.openProjectId(o.dataset.open); } if (e.target.closest(".x")) bg.hidden = true; };

  // ---- outdated code ----
  function showStale(stale) {
    if (!stale) { banner.hidden = true; return; }
    banner.innerHTML = stale.bundle
      ? `<span>Studio's code has changed since this app was built.</span><button data-stale="rebuild" class="primary">Rebuild &amp; restart</button><button class="x" title="Later">×</button>`
      : `<span>This Studio server runs older code than the files on disk.</span><button data-stale="restart" class="primary">Restart server</button><button class="x" title="Later">×</button>`;
    banner.hidden = false;
  }
  banner.onclick = async (e) => {
    if (e.target.closest(".x")) { banner.hidden = true; return; }
    const b = e.target.closest("[data-stale]"); if (!b) return;
    b.disabled = true;
    try {
      await op(b.dataset.stale === "rebuild" ? "rebuildApp" : "restartServer");
      banner.innerHTML = `<span>${b.dataset.stale === "rebuild" ? "Rebuilding Studio: it closes and opens again in a moment…" : "Restarting… the page reconnects by itself."}</span>`;
    } catch (err) { b.disabled = false; toast(err.message); }
  };

  es.addEventListener("agent", (e) => {
    const ev = JSON.parse(e.data);
    if (ev.kind === "op") {
      if (ev.projectId !== ctx.project?.id) return showBg(ev.projectId, ev.projectName);
      lastOp = Date.now(); lastLabel = ev.label; connected = true;
      highlight(ev.nodeIds || [], ev.label);
      drawChip(); bar.hidden = true;
    } else if (ev.kind === "run" && ev.projectId === ctx.project?.id) { run = ev.run; drawBar(); }
  });
  es.addEventListener("system", (e) => { const ev = JSON.parse(e.data); showStale(ev.stale); });
  setInterval(() => { drawChip(); }, 4000);
  refreshConnection();
  setInterval(refreshConnection, 30000);
  drawChip();

  return {
    setRun(r) { run = r; drawBar(); },
    connection: refreshConnection,
    isConnected: () => connected,
  };
}
