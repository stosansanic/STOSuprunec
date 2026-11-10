

export const viknoSmsConfirmId = "vikno_sms_confirm-modal";

export function createViknoSmsConfirm(): HTMLDivElement {
    const overlay = document.createElement("div");
    overlay.id = viknoSmsConfirmId;
    overlay.className = "vikno_pidtverdchennay_zakruttia_akty-overlay"; // Reusing style class
    overlay.style.display = "none";

    const modal = document.createElement("div");
    modal.className = "vikno_pidtverdchennay_zakruttia_akty-content"; // Reusing style class
    // Additional specialized styling can be added via inline style or new class if needed,
    // but let's stick to existing classes for consistency as requested.
    modal.innerHTML = `
    <p id="vikno_sms_confirm-message">Відправити SMS?</p>
    <div class="vikno_pidtverdchennay_zakruttia_akty-buttons save-buttons">
      <button id="vikno_sms_confirm-confirm" class="vikno_pidtverdchennay_zakruttia_akty-confirm-btn btn-save-confirm">Так</button>
      <button id="vikno_sms_confirm-cancel" class="vikno_pidtverdchennay_zakruttia_akty-cancel-btn btn-save-cancel">Ні</button>
    </div>
  `;
    overlay.appendChild(modal);
    return overlay;
}

function ensureSmsModalMounted(): HTMLElement {
    let el = document.getElementById(viknoSmsConfirmId);
    if (!el) {
        el = createViknoSmsConfirm();
        document.body.appendChild(el);
    }
    return el;
}

export function showSmsConfirmModal(
    clientName: string,
    totalSum: number,
    clientPhone: string
): Promise<boolean> {
    return new Promise((resolve) => {
        const modal = ensureSmsModalMounted();
        const messageEl = modal.querySelector("#vikno_sms_confirm-message");

        if (messageEl) {
            messageEl.innerHTML = `
            <strong>Відправити SMS повідомлення</strong><br><br>
            Клієнт: ${clientName}<br>
            Телефон: ${clientPhone}<br>
            Сума до сплати: <strong>${totalSum} грн</strong>
        `;
        }

        modal.style.display = "flex";

        const confirmBtn = document.getElementById("vikno_sms_confirm-confirm");
        const cancelBtn = document.getElementById("vikno_sms_confirm-cancel");

        if (!confirmBtn || !cancelBtn) {
            // console.error("SMS Modal buttons not found");
            modal.style.display = "none";
            resolve(false);
            return;
        }

        // Clear previous event listeners to avoid stacking
        const newConfirmBtn = confirmBtn.cloneNode(true);
        const newCancelBtn = cancelBtn.cloneNode(true);
        confirmBtn.parentNode!.replaceChild(newConfirmBtn, confirmBtn);
        cancelBtn.parentNode!.replaceChild(newCancelBtn, cancelBtn);

        const closeModal = (result: boolean) => {
            modal.style.display = "none";
            resolve(result);
        };

        newConfirmBtn.addEventListener("click", () => closeModal(true));
        newCancelBtn.addEventListener("click", () => closeModal(false));
    });
}
