// Tooltips: hover for a moment and a small label shows what the control is. Works for anything with a title="" (moved to data-tip so the
// browser's own, slower tooltip doesn't also appear; the Mac app's web view shows none at all). Dynamic content needs no wiring.
export function initTips() {
  const tip = document.createElement("div");
  tip.id = "tip"; tip.hidden = true; tip.setAttribute("role", "tooltip");
  document.body.appendChild(tip);
  let timer = 0, cur = null;
  const hide = () => { if (!tip.hidden) { tip.dataset.warm = "1"; clearTimeout(hide.t); hide.t = setTimeout(() => delete tip.dataset.warm, 900); } clearTimeout(timer); timer = 0; cur = null; tip.hidden = true; };
  const textOf = (el) => {
    if (el.hasAttribute("title")) { const t = el.getAttribute("title"); el.removeAttribute("title"); if (t) el.dataset.tip = t; }
    return el.dataset.tip || "";
  };
  function show(el) {
    const t = textOf(el); if (!t || !el.isConnected) return;
    tip.textContent = t; tip.hidden = false;
    const r = el.getBoundingClientRect(), w = tip.offsetWidth, h = tip.offsetHeight;
    let x = Math.max(8, Math.min(innerWidth - w - 8, r.left + r.width / 2 - w / 2));
    let y = r.bottom + 8; if (y + h > innerHeight - 8) y = r.top - h - 8;
    tip.style.left = x + "px"; tip.style.top = y + "px";
  }
  document.addEventListener("pointerover", (e) => {
    const el = e.target.closest && e.target.closest("[title],[data-tip]");
    if (el === cur) return;
    hide();
    if (!el || e.buttons) return;
    textOf(el); // takes the native title away straight away
    cur = el;
    // the first tip waits a little; moving along a toolbar shows the next one quicker
    timer = setTimeout(() => show(el), tip.dataset.warm ? 120 : 500);
  }, true);
  for (const ev of ["pointerdown", "keydown", "wheel", "dragstart"]) addEventListener(ev, hide, true);
  addEventListener("blur", hide);
  document.addEventListener("pointerleave", hide);
  return { hide };
}
