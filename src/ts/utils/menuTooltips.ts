/** Styled hints for the main navigation only; no changes to button actions. */
export function initMenuTooltips(): void {
  const menu = document.getElementById("menu-items-to-hide");
  if (!menu || document.getElementById("main-menu-tooltip")) return;
  const tip = document.createElement("div");
  tip.id = "main-menu-tooltip";
  tip.className = "menu-tooltip";
  tip.setAttribute("role", "tooltip");
  tip.hidden = true;
  // Outside the horizontally scrolling menu so the hint is not clipped.
  document.body.appendChild(tip);
  let active: HTMLElement | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;

  function hide(): void {
    clearTimeout(timer);
    if (active) {
      const ids = (active.getAttribute("aria-describedby") || "").split(/\s+/)
        .filter(id => id && id !== tip.id);
      if (ids.length) active.setAttribute("aria-describedby", ids.join(" "));
      else active.removeAttribute("aria-describedby");
    }
    active = null;
    tip.hidden = true;
  }

  function show(target: HTMLElement): void {
    hide();
    const text = target.dataset.menuTooltip;
    if (!text) return;
    active = target;
    tip.textContent = text;
    tip.hidden = false;
    const rect = target.getBoundingClientRect();
    const bounds = tip.getBoundingClientRect();
    const left = Math.max(8, Math.min(rect.left + (rect.width - bounds.width) / 2,
      window.innerWidth - bounds.width - 8));
    const top = rect.bottom + bounds.height + 10 <= window.innerHeight
      ? rect.bottom + 8 : Math.max(8, rect.top - bounds.height - 8);
    tip.style.left = `${left}px`;
    tip.style.top = `${top}px`;
    const ids = (target.getAttribute("aria-describedby") || "").split(/\s+/).filter(Boolean);
    target.setAttribute("aria-describedby", [...ids, tip.id].join(" "));
  }

  function migrateTitles(): void {
    menu!.querySelectorAll<HTMLElement>("[title]").forEach(target => {
      target.dataset.menuTooltip = target.title;
      target.removeAttribute("title"); // Do not show the browser's square hint as well.
    });
    if (active && (!menu!.contains(active) || !active.getClientRects().length)) hide();
    else if (active) show(active);
  }
  migrateTitles();
  // Includes late-created AI buttons and refreshed calendar counts.
  const observer = new MutationObserver(migrateTitles);
  observer.observe(menu, { childList: true, subtree: true, attributes: true, attributeFilter: ["title"] });

  function targetOf(event: Event): HTMLElement | null {
    const target = event.target instanceof Element
      ? event.target.closest<HTMLElement>("[data-menu-tooltip]") : null;
    return target && menu!.contains(target) ? target : null;
  }
  menu.addEventListener("pointerover", event => {
    if (event.pointerType === "touch") return;
    const target = targetOf(event);
    if (!target || (event.relatedTarget instanceof Node && target.contains(event.relatedTarget))) return;
    hide();
    timer = setTimeout(() => show(target), 180);
  });
  menu.addEventListener("pointerout", event => {
    const target = targetOf(event);
    if (target && !(event.relatedTarget instanceof Node && target.contains(event.relatedTarget))) hide();
  });
  menu.addEventListener("focusin", event => {
    const target = targetOf(event);
    if (target?.matches(":focus-visible")) show(target);
  });
  menu.addEventListener("focusout", hide);
  menu.addEventListener("click", hide);
  document.addEventListener("keydown", event => { if (event.key === "Escape") hide(); });
  window.addEventListener("scroll", hide, true);
  window.addEventListener("resize", hide);
}
