// Notes for Claude: select layers, press N, write what you want ("bolder", "swap this photo"). The note is pinned to those layers.
// In your Claude chat, say "do my notes": Claude reads them (get_requests), does them and marks each one done with a reply.
// Claude can pin notes for you too. Pins sit on the canvas; the Notes tab lists them all.
const ago = (t) => { const s = (Date.now() - t) / 1000; if (s < 60) return "just now"; if (s < 3600) return Math.floor(s / 60) + " min ago"; if (s < 86400) return Math.floor(s / 3600) + " h ago"; return Math.floor(s / 86400) + " d ago"; };

export function initNotes(ctx) {
  const { $, op, toast, esc, es, elFor, viewport, select, nodeOf, label } = ctx;
  let list = [], showDone = false, filter = "open";
  const layer = document.createElement("div"); layer.id = "notes-layer"; viewport.appendChild(layer);
  const pop = document.createElement("div"); pop.id = "note-pop"; pop.hidden = true; document.body.appendChild(pop);
  const panel = $("#notes-panel"), tabCount = $("#notes-count"), topBtn = $("#btn-notes");
  const pins = new Map(); // note id -> element

  const visible = () => list.filter((n) => n.status === "open" || showDone);
  const numberOf = (id) => list.filter((n) => n.status === "open").findIndex((n) => n.id === id) + 1;
  function place() {
    const vr = viewport.getBoundingClientRect(), live = new Set();
    for (const n of visible()) {
      const t = n.targets.find((x) => !x.missing && elFor(x.id));
      if (!t) continue;
      live.add(n.id);
      let pin = pins.get(n.id);
      if (!pin) { pin = document.createElement("button"); pin.className = "note-pin"; pin.dataset.note = n.id; layer.appendChild(pin); pins.set(n.id, pin); }
      pin.className = "note-pin" + (n.author === "claude" ? " claude" : "") + (n.status === "done" ? " done" : "");
      pin.textContent = n.status === "done" ? "✓" : n.author === "claude" ? "✦" : String(numberOf(n.id));
      pin.title = n.text;
      const r = elFor(t.id).getBoundingClientRect();
      pin.style.left = Math.min(r.right - vr.left, vr.width - 14) + "px"; pin.style.top = Math.max(r.top - vr.top, 14) + "px";
    }
    for (const [id, pin] of pins) if (!live.has(id)) { pin.remove(); pins.delete(id); }
  }
  ctx.onOverlay(place);
  layer.addEventListener("pointerdown", (e) => e.stopPropagation());
  layer.addEventListener("click", (e) => { const p = e.target.closest(".note-pin"); if (p) openNote(p.dataset.note, p.getBoundingClientRect()); });

  function counts() {
    const open = list.filter((n) => n.status === "open" && n.author !== "claude").length, fromClaude = list.filter((n) => n.status === "open" && n.author === "claude").length;
    if (tabCount) tabCount.textContent = open + fromClaude ? String(open + fromClaude) : "";
    if (topBtn) { topBtn.classList.toggle("has", open + fromClaude > 0); topBtn.dataset.count = open + fromClaude || ""; }
  }

  // ---- one note ----
  function openNote(id, at) {
    const n = list.find((x) => x.id === id); if (!n) return;
    const who = n.author === "claude" ? `<span class="who claude">✦ Claude</span>` : `<span class="who">You</span>`;
    pop.innerHTML = `<div class="np-head">${who}<span class="muted">${ago(n.created)}${n.status === "done" ? " · done" : ""}</span><button class="x" title="Close">×</button></div>
      <div class="np-text">${esc(n.text)}</div>
      ${n.reply ? `<div class="np-reply"><span class="who claude">✦ Claude</span> ${esc(n.reply)}</div>` : ""}
      <div class="np-on muted">On ${n.targets.map((t) => (t.missing ? "a deleted layer" : esc(t.name))).join(", ")}</div>
      <div class="np-act"><button data-na="select">Select</button>${n.status === "open" ? `<button data-na="done">Mark done</button>` : `<button data-na="reopen">Reopen</button>`}<button data-na="edit">Edit</button><button data-na="del" class="danger-text">Delete</button></div>`;
    pop.hidden = false; pop.dataset.id = id;
    pop.style.left = Math.max(8, Math.min(innerWidth - 300, at.right + 8)) + "px"; pop.style.top = Math.max(8, Math.min(innerHeight - pop.offsetHeight - 8, at.top)) + "px";
  }
  pop.addEventListener("pointerdown", (e) => e.stopPropagation());
  pop.addEventListener("keydown", (e) => e.stopPropagation());
  pop.onclick = async (e) => {
    if (e.target.closest(".x")) return (pop.hidden = true);
    const b = e.target.closest("[data-na]"); if (!b) return;
    const id = pop.dataset.id, n = list.find((x) => x.id === id);
    if (b.dataset.na === "select") { select(n.targets.filter((t) => !t.missing).map((t) => t.id)); pop.hidden = true; }
    else if (b.dataset.na === "done") { await op("resolveNote", { id, reply: "" }); pop.hidden = true; }
    else if (b.dataset.na === "reopen") { await op("reopenNote", { id }); pop.hidden = true; }
    else if (b.dataset.na === "del") { await op("deleteNote", { id }); pop.hidden = true; }
    else if (b.dataset.na === "edit") {
      const t = pop.querySelector(".np-text"), ta = document.createElement("textarea"); ta.value = n.text; ta.rows = 3; t.replaceWith(ta); ta.focus();
      const save = async () => { if (ta.value.trim() && ta.value.trim() !== n.text) await op("updateNote", { id, text: ta.value.trim() }); pop.hidden = true; };
      ta.onkeydown = (ev) => { ev.stopPropagation(); if (ev.key === "Enter" && !ev.shiftKey) { ev.preventDefault(); save(); } if (ev.key === "Escape") pop.hidden = true; };
      b.textContent = "Save"; b.dataset.na = "save"; b.onclick = (ev) => { ev.stopPropagation(); save(); };
    }
  };
  addEventListener("pointerdown", (e) => { if (!pop.hidden && !pop.contains(e.target) && !e.target.closest(".note-pin, #notes-panel")) pop.hidden = true; });

  // ---- writing a note ----
  function compose(ids) {
    ids = (ids || []).filter((id) => nodeOf(id));
    if (!ids.length) return toast("Select the layers the note is about, then press N.");
    const rects = ids.map((id) => elFor(id)?.getBoundingClientRect()).filter(Boolean);
    const right = rects.length ? Math.max(...rects.map((r) => r.right)) : innerWidth / 2, top = rects.length ? Math.min(...rects.map((r) => r.top)) : 120;
    pop.innerHTML = `<div class="np-head"><span class="who">Note for Claude</span><span class="muted">on ${esc(ids.length === 1 ? label(nodeOf(ids[0])) : ids.length + " layers")}</span><button class="x" title="Cancel">×</button></div>
      <textarea id="note-text" rows="3" placeholder="What should change? e.g. make this bolder, swap for a lifestyle photo"></textarea>
      <div class="np-hint muted">Then say <b>“do my notes”</b> in your Claude chat.</div>
      <div class="np-act"><span style="flex:1"></span><button data-na="cancel">Cancel</button><button data-na="pin" class="primary">Pin note ↵</button></div>`;
    pop.hidden = false; delete pop.dataset.id;
    pop.style.left = Math.max(8, Math.min(innerWidth - 300, right + 10)) + "px"; pop.style.top = Math.max(60, Math.min(innerHeight - 220, top)) + "px";
    const ta = $("#note-text"); ta.focus();
    const pin = async () => { const text = ta.value.trim(); if (!text) return ta.focus(); try { await op("addNote", { nodeIds: ids, text }); pop.hidden = true; toast("Pinned. Say “do my notes” in your Claude chat."); } catch {} };
    ta.onkeydown = (e) => { e.stopPropagation(); if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); pin(); } if (e.key === "Escape") pop.hidden = true; };
    pop.querySelector('[data-na="pin"]').onclick = (e) => { e.stopPropagation(); pin(); };
    pop.querySelector('[data-na="cancel"]').onclick = (e) => { e.stopPropagation(); pop.hidden = true; };
  }

  // ---- the Notes tab ----
  function renderPanel() {
    if (!panel || panel.hidden) return;
    const shown = list.filter((n) => filter === "all" || n.status === filter).slice().reverse();
    panel.innerHTML = `<div class="notes-top">
        <div class="seg small">${["open", "done", "all"].map((f) => `<button data-nf="${f}" class="${filter === f ? "on" : ""}">${f[0].toUpperCase() + f.slice(1)}</button>`).join("")}</div>
        <label class="chk"><input type="checkbox" data-showdone ${showDone ? "checked" : ""}> Done on canvas</label>
      </div>
      <div class="notes-how"><b>Select layers → N</b> to pin a note. Then tell Claude in your chat: <button class="copy" data-copy="do my notes">“do my notes” ⧉</button></div>
      <div class="notes-list">${shown.map((n) => `<div class="nrow${n.status === "done" ? " done" : ""}" data-nid="${n.id}">
          <span class="note-pin static${n.author === "claude" ? " claude" : ""}${n.status === "done" ? " done" : ""}">${n.status === "done" ? "✓" : n.author === "claude" ? "✦" : numberOf(n.id)}</span>
          <div class="nmain"><div class="ntext">${esc(n.text)}</div>${n.reply ? `<div class="nreply">✦ ${esc(n.reply)}</div>` : ""}<div class="muted">${n.author === "claude" ? "Claude" : "You"} · ${ago(n.created)} · ${n.targets.map((t) => (t.missing ? "deleted layer" : esc(t.name))).join(", ")}</div></div>
          <div class="nact">${n.status === "open" ? `<button data-nr="done" title="Mark done">✓</button>` : `<button data-nr="reopen" title="Reopen">↺</button>`}<button data-nr="del" title="Delete">×</button></div>
        </div>`).join("") || `<p class="ahint" style="padding:0 12px">${filter === "open" ? "No open notes." : "Nothing here yet."}</p>`}</div>
      ${list.some((n) => n.status === "done") ? `<div class="notes-foot"><button data-clear>Clear done notes</button></div>` : ""}`;
  }
  if (panel) {
    panel.addEventListener("click", async (e) => {
      const f = e.target.closest("[data-nf]"); if (f) { filter = f.dataset.nf; return renderPanel(); }
      const c = e.target.closest("[data-copy]"); if (c) { try { await navigator.clipboard.writeText(c.dataset.copy); toast("Copied: paste it in your Claude chat."); } catch { toast("Type “do my notes” in your Claude chat."); } return; }
      if (e.target.closest("[data-clear]")) return op("clearDoneNotes");
      const row = e.target.closest(".nrow"); if (!row) return;
      const id = row.dataset.nid, a = e.target.closest("[data-nr]");
      if (a) { if (a.dataset.nr === "done") return op("resolveNote", { id, reply: "" }); if (a.dataset.nr === "reopen") return op("reopenNote", { id }); if (a.dataset.nr === "del") return op("deleteNote", { id }); }
      const n = list.find((x) => x.id === id), ids = n.targets.filter((t) => !t.missing).map((t) => t.id);
      if (ids.length) { select(ids); const el = elFor(ids[0]); if (el) openNote(id, el.getBoundingClientRect()); }
    });
    panel.addEventListener("change", (e) => { if (e.target.matches("[data-showdone]")) { showDone = e.target.checked; place(); } });
  }
  window.addEventListener("studio-tab", (e) => { if (e.detail === "notes") renderPanel(); });
  if (topBtn) topBtn.onclick = () => ctx.showTab("notes");

  function set(next) { list = next || []; counts(); place(); renderPanel(); if (!pop.hidden && pop.dataset.id && !list.some((n) => n.id === pop.dataset.id)) pop.hidden = true; }
  es.addEventListener("notes", (e) => set(JSON.parse(e.data).notes));
  // notes Claude finished or left while you watch
  let known = null;
  es.addEventListener("notes", (e) => {
    const next = JSON.parse(e.data).notes;
    if (known) for (const n of next) { const k = known.get(n.id); if (k === "open" && n.status === "done" && n.reply) toast("✦ Claude: " + n.reply); if (!k && n.author === "claude") toast("✦ Claude left you a note: " + n.text); }
    known = new Map(next.map((n) => [n.id, n.status]));
  });
  return { set, compose, list: () => list };
}
