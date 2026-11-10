const DELETE_COUNTING_VALUE = "true";
const DELETE_INTERVAL_ATTR = "deleteCountdownIntervalId";
const DELETE_TITLE_ATTR = "deleteCountdownOriginalTitle";

type DeleteCountdownOptions = {
  durationSec?: number;
  countingClass?: string;
  countdownClass?: string;
  countingTitle?: string;
  onStart?: () => void;
  onCancel?: () => void;
  onConfirm: () => void | Promise<void>;
};

const DEFAULT_DURATION_SEC = 5;
const DEFAULT_COUNTDOWN_CLASS = "ai-delete-countdown";

export function isDeleteCountdownActive(button: HTMLElement): boolean {
  return button.dataset.counting === DELETE_COUNTING_VALUE;
}

export function startDeleteCountdown(
  button: HTMLElement,
  options: DeleteCountdownOptions,
): void {
  if (isDeleteCountdownActive(button)) return;

  const {
    durationSec = DEFAULT_DURATION_SEC,
    countingClass,
    countdownClass = DEFAULT_COUNTDOWN_CLASS,
    countingTitle = "Натисніть, щоб скасувати видалення",
    onStart,
    onConfirm,
  } = options;

  button.dataset.counting = DELETE_COUNTING_VALUE;
  button.dataset[DELETE_TITLE_ATTR] = button.title || "";
  button.title = countingTitle;
  if (countingClass) button.classList.add(countingClass);
  onStart?.();

  const badge = document.createElement("span");
  badge.className = countdownClass;
  badge.textContent = String(durationSec);
  button.appendChild(badge);

  let timeLeft = durationSec;
  const intervalId = window.setInterval(async () => {
    timeLeft -= 1;
    badge.textContent = String(Math.max(timeLeft, 0));

    if (timeLeft > 0) return;

    window.clearInterval(intervalId);
    try {
      await onConfirm();
    } finally {
      resetDeleteCountdown(button, { countingClass, countdownClass });
    }
  }, 1000);

  button.dataset[DELETE_INTERVAL_ATTR] = String(intervalId);
}

export function cancelDeleteCountdown(
  button: HTMLElement,
  options: Omit<DeleteCountdownOptions, "onConfirm">,
): void {
  if (!isDeleteCountdownActive(button)) return;

  const intervalIdRaw = button.dataset[DELETE_INTERVAL_ATTR];
  if (intervalIdRaw) {
    window.clearInterval(Number(intervalIdRaw));
  }

  options.onCancel?.();
  resetDeleteCountdown(button, {
    countingClass: options.countingClass,
    countdownClass: options.countdownClass,
  });
}

function resetDeleteCountdown(
  button: HTMLElement,
  options: { countingClass?: string; countdownClass?: string },
): void {
  const countdownClass = options.countdownClass || DEFAULT_COUNTDOWN_CLASS;
  button.dataset.counting = "";
  button.dataset[DELETE_INTERVAL_ATTR] = "";
  button.title = button.dataset[DELETE_TITLE_ATTR] || "";
  button.dataset[DELETE_TITLE_ATTR] = "";
  if (options.countingClass) button.classList.remove(options.countingClass);
  button.querySelector(`.${countdownClass}`)?.remove();
}
