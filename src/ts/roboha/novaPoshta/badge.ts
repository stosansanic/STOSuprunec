// Online mode has no persisted arrival counter or realtime subscription.
export function initNovaPoshtaBadge() {
  const button = document.querySelector<HTMLElement>(".nova-poshta-menu-button");
  button?.querySelector(".np-menu-badge")?.remove();
  button?.setAttribute("aria-label", "Нова пошта");
}
