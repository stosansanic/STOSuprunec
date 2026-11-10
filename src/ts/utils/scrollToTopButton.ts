const TOP_BUTTON_ID = "scroll-to-top-button";

function getPageScrollTargets(): HTMLElement[] {
  const page = (document.scrollingElement as HTMLElement | null) ?? document.documentElement;
  const content = document.getElementById("table-container-modal-sakaz_narad")
    ?? document.getElementById("postSchedulerWrapper");
  // Chat, dropdowns and modals have independent scroll positions. They must not
  // keep the page button visible or be reset by its click.
  return content && content !== page && content.clientHeight > 0 ? [page, content] : [page];
}

function getCurrentScrollTop(): number {
  return Math.max(0, ...getPageScrollTargets().map((element) => element.scrollTop));
}

function scrollPageToTop(behavior: ScrollBehavior): void {
  getPageScrollTargets().forEach((element) => {
    if (element.scrollTop > 0) element.scrollTo({ top: 0, behavior });
  });
}

function isBukhhalteriyaPage(): boolean {
  return (
    location.pathname.includes("bukhhalteriya.html") ||
    Boolean(document.querySelector(".Bukhhalter-container"))
  );
}

export function initScrollToTopButton(): void {
  if (isBukhhalteriyaPage()) return;
  if (document.getElementById(TOP_BUTTON_ID)) return;

  const button = document.createElement("button");
  button.id = TOP_BUTTON_ID;
  button.className = "scroll-to-top-button";
  button.type = "button";
  button.title = "Прокрутити вгору";
  button.setAttribute("aria-label", "Прокрутити сторінку вгору");
  button.innerHTML = `<span class="scroll-to-top-button__ripple" aria-hidden="true"></span>
    <svg viewBox="0 0 24 24" width="24" height="24" aria-hidden="true" focusable="false">
      <path d="M12 19V8m-5 5 5-5 5 5M5 4h14" fill="none" stroke="currentColor"
        stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" />
    </svg>`;

  const arrow = button.querySelector("path")!;
  const ripple = button.querySelector<HTMLElement>(".scroll-to-top-button__ripple")!;
  const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
  let clickAnimations: Animation[] = [];
  button.addEventListener("click", () => {
    clickAnimations.forEach(animation => animation.cancel());
    clickAnimations = [];
    if (!reducedMotion.matches && typeof arrow.animate === "function") {
      // Animate the inner artwork so the button can still hide during scrolling.
      clickAnimations = [
        arrow.animate([
          { transform: "translateY(0)" },
          { transform: "translateY(-4px)", offset: 0.35 },
          { transform: "translateY(1px)", offset: 0.7 },
          { transform: "translateY(0)" },
        ], { duration: 360, easing: "ease-out" }),
        ripple.animate([
          { opacity: 0.8, transform: "scale(0.35)" },
          { opacity: 0, transform: "scale(1.7)" },
        ], { duration: 480, easing: "ease-out" }),
      ];
    }
    scrollPageToTop(reducedMotion.matches ? "auto" : "smooth");
  });
  document.body.appendChild(button);

  const updateVisibility = () => {
    const visible = getCurrentScrollTop() > 180;
    button.classList.toggle("visible", visible);
    button.setAttribute("aria-hidden", String(!visible));
    button.tabIndex = visible ? 0 : -1;
    button.disabled = !visible;
  };

  let scheduled = false;
  const scheduleUpdate = () => {
    if (scheduled) return;
    scheduled = true;
    window.requestAnimationFrame(() => {
      scheduled = false;
      updateVisibility();
    });
  };

  window.addEventListener("scroll", scheduleUpdate, { passive: true });
  document.addEventListener("scroll", scheduleUpdate, {
    capture: true,
    passive: true,
  });
  window.addEventListener("resize", scheduleUpdate, { passive: true });
  window.addEventListener("pageshow", scheduleUpdate);

  updateVisibility();
}
