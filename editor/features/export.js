// Export dialog: what (this artboard / all), which format, how sharp.
export function initExport(ctx) {
  const { $, esc, toast } = ctx;
  const FORMATS = [["png", "PNG"], ["jpg", "JPG"], ["webp", "WebP"], ["pdf", "PDF"], ["slices", "Slices"], ["html", "HTML"]];
  const HINT = { png: "Lossless, supports transparency.", jpg: "Smaller files; set the quality.", webp: "Small and sharp; fine for web.", pdf: "One page per artboard, each exactly its size. Text stays selectable.", slices: "Each top-level section of the artboard as its own image, in a zip.", html: "A standalone page (a zip of pages when exporting all)." };
  let el = null;
  function close() { el?.remove(); el = null; }
  function open() {
    close();
    const arts = ctx.boards(); if (!arts.length) return toast("No artboard yet.");
    const cur = ctx.currentArtboard() || arts[0];
    el = document.createElement("div"); el.id = "xdlg";
    el.innerHTML = `<div class="xbox" role="dialog"><h3>Export</h3>
      <div class="f"><label>What</label><select id="x-scope"><option value="one">${esc(cur.name || "Artboard")} (this artboard)</option>${arts.length > 1 ? `<option value="all">All ${arts.length} artboards</option>` : ""}</select></div>
      <div class="f"><label>Format</label><div class="seg" id="x-fmt">${FORMATS.map(([k, l], i) => `<button data-f="${k}" class="${i ? "" : "on"}">${l}</button>`).join("")}</div><div class="muted" id="x-hint"></div></div>
      <div class="row"><div class="f" id="x-scale-f"><label>Scale</label><select id="x-scale">${[1, 2, 3, 4].map((n) => `<option ${n === 2 ? "selected" : ""}>${n}</option>`).join("")}</select></div>
      <div class="f" id="x-q-f"><label>Quality <span id="x-qv">90</span></label><input type="range" id="x-q" min="40" max="100" value="90"></div></div>
      <div class="row" style="justify-content:flex-end"><button id="x-cancel">Cancel</button><button id="x-go" class="primary">Export</button></div></div>`;
    document.body.appendChild(el);
    let fmt = "png";
    const sync = () => {
      $("#x-hint", el).textContent = HINT[fmt];
      $("#x-scale-f", el).style.display = ["png", "jpg", "webp", "slices"].includes(fmt) ? "" : "none";
      $("#x-q-f", el).style.display = ["jpg", "webp"].includes(fmt) ? "" : "none";
      const sc = $("#x-scope", el); if (fmt === "slices") { sc.value = "one"; sc.disabled = true; } else sc.disabled = false;
    };
    sync();
    $("#x-fmt", el).onclick = (e) => { const b = e.target.closest("[data-f]"); if (!b) return; fmt = b.dataset.f; el.querySelectorAll("#x-fmt button").forEach((x) => x.classList.toggle("on", x === b)); sync(); };
    $("#x-q", el).oninput = (e) => ($("#x-qv", el).textContent = e.target.value);
    $("#x-cancel", el).onclick = close;
    el.addEventListener("pointerdown", (e) => { if (e.target === el) close(); });
    el.addEventListener("keydown", (e) => { e.stopPropagation(); if (e.key === "Escape") close(); });
    $("#x-go", el).onclick = async () => {
      const all = $("#x-scope", el).value === "all", q = `format=${fmt}&scale=${$("#x-scale", el).value}&quality=${$("#x-q", el).value}` + (all ? "&scope=all" : `&id=${cur.id}`);
      const go = $("#x-go", el); go.disabled = true; go.textContent = "Rendering…";
      try {
        const r = await fetch("/api/export?" + q); if (!r.ok) throw new Error((await r.json()).error);
        const blob = await r.blob(), name = /filename="([^"]+)"/.exec(r.headers.get("content-disposition") || "")?.[1] || "export";
        const a = document.createElement("a"); a.href = URL.createObjectURL(blob); a.download = name; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 4000);
        close(); toast("Exported " + name);
      } catch (e) { go.disabled = false; go.textContent = "Export"; toast("Couldn't export: " + e.message); }
    };
    $("#x-go", el).focus();
  }
  return { open, close };
}
