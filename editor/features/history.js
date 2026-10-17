// Version history dialog: save a named version, see automatic ones, restore (undoable), rename, delete.
export function initHistory(ctx) {
  const { $, esc, op, toast, confirmBox } = ctx;
  let el = null;
  const when = (t) => { const d = new Date(t), now = new Date(), same = d.toDateString() === now.toDateString(); const hm = d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }); return same ? "Today " + hm : d.toLocaleDateString([], { month: "short", day: "numeric" }) + " " + hm; };
  const close = () => { el?.remove(); el = null; };
  async function render() {
    const list = await op("historyList");
    const rows = list.map((v) => `<div class="hrow" data-id="${v.id}"><div class="hmain"><b>${v.name ? esc(v.name) : v.auto ? "Automatic save" : "Saved version"}</b><span class="muted">${when(v.at)} · ${v.artboards} artboard${v.artboards === 1 ? "" : "s"}, ${v.layers} layers</span></div><button data-act="rename">Rename</button><button data-act="restore">Restore</button><button data-act="del" title="Delete">×</button></div>`).join("");
    $("#h-list", el).innerHTML = rows || `<div class="muted" style="padding:14px 4px">No versions yet. Studio saves one automatically about every 10 minutes while you work; use “Save version” for a milestone.</div>`;
  }
  async function open() {
    close();
    el = document.createElement("div"); el.id = "xdlg"; el.className = "hist";
    el.innerHTML = `<div class="xbox hbox" role="dialog"><h3>Version history</h3>
      <div class="row"><input id="h-name" placeholder="Name this version (optional)" style="flex:1"><button id="h-save" class="primary">Save version</button></div>
      <div id="h-list" class="hlist"></div><div class="row" style="justify-content:flex-end"><button id="h-close">Close</button></div></div>`;
    document.body.appendChild(el);
    el.addEventListener("pointerdown", (e) => { if (e.target === el) close(); });
    el.addEventListener("keydown", (e) => { e.stopPropagation(); if (e.key === "Escape") close(); if (e.key === "Enter" && e.target.id === "h-name") $("#h-save", el).click(); });
    $("#h-close", el).onclick = close;
    $("#h-save", el).onclick = async () => { try { await op("historySave", { name: $("#h-name", el).value }); $("#h-name", el).value = ""; await render(); toast("Version saved"); } catch (e) { toast(e.message); } };
    $("#h-list", el).onclick = async (e) => {
      const b = e.target.closest("[data-act]"); if (!b) return; const id = b.closest(".hrow").dataset.id;
      try {
        if (b.dataset.act === "restore") { confirmBox("Go back to this version? Your current design is saved as a version first, and ⌘Z also undoes it.", "Restore", async () => { try { await op("historyRestore", { id }); close(); toast("Restored. ⌘Z to undo"); } catch (er) { toast(er.message); } }); }
        else if (b.dataset.act === "del") { await op("historyDelete", { id }); await render(); }
        else if (b.dataset.act === "rename") {
          const row = b.closest(".hrow"), t = $("b", row), cur = t.textContent; const inp = document.createElement("input"); inp.value = /^(Automatic save|Saved version)$/.test(cur) ? "" : cur; t.replaceWith(inp); inp.focus();
          const fin = async (ok) => { if (ok) await op("historyRename", { id, name: inp.value }); await render(); };
          inp.onkeydown = (ev) => { ev.stopPropagation(); if (ev.key === "Enter") fin(true); if (ev.key === "Escape") fin(false); }; inp.onblur = () => fin(true);
        }
      } catch (err) { toast(err.message); }
    };
    await render();
  }
  return { open, close };
}
