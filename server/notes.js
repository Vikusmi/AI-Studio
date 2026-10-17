// Notes on the canvas: you pin a request to layers ("make this bolder"), Claude reads them with get_requests and marks each one done
// with a short reply. Claude can also leave a note for you. Kept in <project>/notes.json, outside undo: ⌘Z never brings a note back.
import fs from "node:fs";
import path from "node:path";

const fileOf = (d) => path.join(d.dir, "notes.json");
function load(d) {
  if (!d._notes) { try { d._notes = JSON.parse(fs.readFileSync(fileOf(d), "utf8")); } catch { d._notes = []; } }
  return d._notes;
}
function store(d) { try { fs.writeFileSync(fileOf(d), JSON.stringify(d._notes || [])); } catch {} }

export function createNotes({ onChange }) {
  const need = (d, id) => { const n = load(d).find((x) => x.id === id); if (!n) throw new Error(`No note "${id}".`); return n; };
  const changed = (d) => { store(d); onChange(d); };
  const view = (d, n) => ({
    ...n,
    targets: (n.nodeIds || []).map((id) => { const r = d.find(id); return r ? { id, name: d.label(r.node), artboard: d.artboardOf(id)?.name || null } : { id, missing: true }; }),
  });
  return {
    list: (d, { status } = {}) => load(d).filter((n) => !status || n.status === status).map((n) => view(d, n)),
    openCount: (d) => load(d).filter((n) => n.status === "open" && n.author !== "claude").length,
    add(d, { nodeIds = [], text, author = "you" }) {
      if (!text || !String(text).trim()) throw new Error("Write what the note should say.");
      const ids = nodeIds.filter((id) => d.find(id));
      if (!ids.length && nodeIds.length) throw new Error("Those layers don't exist any more.");
      const n = { id: "t" + Date.now().toString(36) + Math.random().toString(36).slice(2, 4), nodeIds: ids, text: String(text).trim().slice(0, 2000), author: author === "claude" ? "claude" : "you", status: "open", created: Date.now() };
      load(d).push(n); changed(d);
      return view(d, n);
    },
    update(d, { id, text, nodeIds }) {
      const n = need(d, id);
      if (text !== undefined) { if (!String(text).trim()) throw new Error("A note can't be empty."); n.text = String(text).trim().slice(0, 2000); }
      if (nodeIds) n.nodeIds = nodeIds.filter((x) => d.find(x));
      changed(d); return view(d, n);
    },
    resolve(d, { id, reply = "" }) {
      const n = need(d, id); n.status = "done"; n.reply = String(reply).trim().slice(0, 600); n.resolvedAt = Date.now();
      changed(d); return view(d, n);
    },
    reopen(d, { id }) { const n = need(d, id); n.status = "open"; delete n.reply; delete n.resolvedAt; changed(d); return view(d, n); },
    remove(d, { id }) { const list = load(d); const i = list.findIndex((x) => x.id === id); if (i < 0) throw new Error(`No note "${id}".`); list.splice(i, 1); changed(d); return true; },
    clearDone(d) { d._notes = load(d).filter((n) => n.status !== "done"); changed(d); return true; },
  };
}
