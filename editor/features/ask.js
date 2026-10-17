// "Ask Claude": a small floating panel. It sends a request (and what is selected) to the server, which runs Claude Code
// with only the Studio tools on the user's own login; progress streams back here.
export function initAsk(ctx) {
  const { $, esc, es, toast } = ctx;
  const btn = $("#btn-ask");
  const panel = document.createElement("div");
  panel.id = "ask"; panel.hidden = true;
  panel.innerHTML = `<div class="ask-head"><b>Ask Claude</b><span class="muted" id="ask-sel"></span><button class="icon" id="ask-close" title="Close">×</button></div>
    <div class="ask-note" id="ask-note" hidden></div>
    <div class="ask-chips">${["Punchier copy", "Shorter", "More premium", "Tidy up spacing", "3 variants"].map((c) => `<button data-chip="${esc(c)}">${esc(c)}</button>`).join("")}</div>
    <div class="ask-log" id="ask-log"></div>
    <textarea id="ask-text" rows="3" placeholder="What should Claude do? e.g. make the headline bigger and the button green"></textarea>
    <div class="ask-actions"><button id="ask-undo" hidden>Undo this run</button><span style="flex:1"></span><button id="ask-stop" hidden>Stop</button><button id="ask-send" class="primary">Send ⌘↵</button></div>`;
  document.body.appendChild(panel);
  const log = $("#ask-log", panel), text = $("#ask-text", panel), send = $("#ask-send", panel), stop = $("#ask-stop", panel), undo = $("#ask-undo", panel), note = $("#ask-note", panel);
  let running = false;
  const CHIPS = { "Punchier copy": "Make the copy punchier and more direct.", "Shorter": "Make the copy shorter without losing the message.", "More premium": "Make the design feel more premium: calmer colours, more space, refined type.", "Tidy up spacing": "Tidy up the spacing and alignment.", "3 variants": "Duplicate this and make 3 different variants side by side." };

  const line = (cls, t) => { const d = document.createElement("div"); d.className = "ask-ev " + cls; d.textContent = t; log.appendChild(d); log.scrollTop = log.scrollHeight; return d; };
  const setRunning = (r) => { running = r; send.hidden = r; stop.hidden = !r; text.disabled = r; panel.classList.toggle("busy", r); };
  const selLabel = () => { const n = ctx.selection.length; $("#ask-sel", panel).textContent = n ? `· ${n} selected` : "· whole project"; };
  function replay(run) {
    log.innerHTML = ""; if (!run) { setRunning(false); undo.hidden = true; return; }
    line("you", run.prompt); run.events.forEach(show); setRunning(!!run.running); undo.hidden = !run.canUndo || run.running;
  }
  function show(ev) {
    if (ev.kind === "tool") line("tool", ev.text);
    else if (ev.kind === "text") line("say", ev.text);
    else if (ev.kind === "done") { line("done", ev.text || "Done."); }
    else if (ev.kind === "error") line("err", ev.text);
    else if (ev.kind === "cancelled") line("tool", "Stopped.");
  }
  async function open() {
    panel.hidden = false; btn.classList.add("on"); selLabel();
    try {
      const r = await (await fetch("/api/ask")).json();
      note.hidden = r.available; note.textContent = r.available ? "" : "Claude Code isn't installed. Install it, then run `claude` once in a terminal to sign in. Studio uses your own login; nothing is stored here.";
      replay(r.run);
    } catch {}
    text.focus();
  }
  const close = () => { panel.hidden = true; btn.classList.remove("on"); };
  btn.onclick = () => (panel.hidden ? open() : close());
  $("#ask-close", panel).onclick = close;
  panel.addEventListener("click", (e) => { const c = e.target.closest("[data-chip]"); if (c && !running) { text.value = CHIPS[c.dataset.chip]; text.focus(); } });
  async function go() {
    const prompt = text.value.trim(); if (!prompt || running) return;
    const r = await fetch("/api/ask", { method: "POST", body: JSON.stringify({ prompt, selection: ctx.selection }) }); const j = await r.json();
    if (!r.ok) return toast(j.error || "Couldn't start");
    text.value = ""; log.innerHTML = ""; line("you", prompt); undo.hidden = true; setRunning(true);
  }
  send.onclick = go;
  text.addEventListener("keydown", (e) => { e.stopPropagation(); if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); go(); } if (e.key === "Escape") text.blur(); });
  stop.onclick = () => fetch("/api/ask/cancel", { method: "POST", body: "{}" });
  undo.onclick = async () => { const r = await fetch("/api/ask/undo", { method: "POST", body: "{}" }); const j = await r.json(); if (!r.ok) return toast(j.error); undo.hidden = true; line("tool", "Undone."); };
  es.addEventListener("ask", (e) => {
    const ev = JSON.parse(e.data);
    if (ev.kind === "start") { if (panel.hidden) return; if (!running) { log.innerHTML = ""; line("you", ev.text || "…"); } setRunning(true); return; }
    if (!panel.hidden) show(ev);
    if (["done", "error", "cancelled"].includes(ev.kind)) { setRunning(false); undo.hidden = !(ev.kind === "done" && ev.canUndo); if (panel.hidden) toast(ev.kind === "done" ? "Claude finished: " + (ev.text || "") : ev.text || "Stopped"); }
  });
  return { open, close, selLabel };
}
