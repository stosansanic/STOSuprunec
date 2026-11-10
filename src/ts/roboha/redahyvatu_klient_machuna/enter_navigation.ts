// src/ts/roboha/redahyvatu_klient_machuna/enter_navigation.ts

/**
 * Налаштовує навігацію між полями вводу за допомогою клавіші Enter
 * Підтримує динамічні елементи (input, textarea, select)
 * @param fieldIds - Масив ID полів в порядку навігації
 */
export function setupEnterNavigation(fieldIds: string[]) {
    // Використовуємо делегування подій на рівні документа
    // щоб підтримувати динамічно замінювані елементи (input → select)

    const handleKeyDown = (e: Event) => {
        if (!(e instanceof KeyboardEvent)) return;
        if (e.key !== "Enter") return;

        const target = e.target as HTMLElement;
        if (!target || !target.id) return;

        // Знаходимо індекс поточного поля
        const currentIndex = fieldIds.indexOf(target.id);
        if (currentIndex === -1) return;

        // Для select елементів - перевіряємо, чи список відкритий
        if (target instanceof HTMLSelectElement) {
            // Якщо натиснули Enter на select, закриваємо його і переходимо далі
            e.preventDefault();
            target.blur(); // Закриваємо випадаючий список

            // Невелика затримка, щоб select встиг закритися
            setTimeout(() => {
                moveToNextField(currentIndex);
            }, 50);
            return;
        }

        // Для input і textarea - просто переходимо далі
        e.preventDefault();
        moveToNextField(currentIndex);
    };

    const moveToNextField = (currentIndex: number) => {
        const nextIndex = currentIndex + 1;
        if (nextIndex < fieldIds.length) {
            const nextField = document.getElementById(fieldIds[nextIndex]) as
                HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement | null;

            if (nextField) {
                nextField.focus();

                // Встановлюємо курсор в кінець для input/textarea
                if (nextField instanceof HTMLInputElement || nextField instanceof HTMLTextAreaElement) {
                    nextField.setSelectionRange(nextField.value.length, nextField.value.length);
                }
            }
        }
    };

    // Додаємо один обробник на весь документ
    document.addEventListener("keydown", handleKeyDown);

    // Повертаємо функцію для видалення обробника (якщо потрібно)
    return () => {
        document.removeEventListener("keydown", handleKeyDown);
    };
}

/**
 * Налаштовує навігацію Enter для модальних вікон (Склад, Співробітники, Контрагент)
 * @param fieldIds - Масив ID полів в порядку навігації
 */
export function setupEnterNavigationForFields(fieldIds: string[]) {
    const handleKeyDown = (e: Event) => {
        if (!(e instanceof KeyboardEvent)) return;
        if (e.key !== "Enter") return;

        const target = e.target as HTMLElement;
        if (!target || !target.id) return;

        const currentIndex = fieldIds.indexOf(target.id);
        if (currentIndex === -1) return;

        if (target instanceof HTMLSelectElement) {
            e.preventDefault();
            target.blur();
            setTimeout(() => moveToNextField(currentIndex), 50);
            return;
        }

        e.preventDefault();
        moveToNextField(currentIndex);
    };

    const moveToNextField = (currentIndex: number) => {
        const nextIndex = currentIndex + 1;
        if (nextIndex < fieldIds.length) {
            const nextField = document.getElementById(fieldIds[nextIndex]) as
                HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement | null;

            if (nextField) {
                nextField.focus();
                if (nextField instanceof HTMLInputElement || nextField instanceof HTMLTextAreaElement) {
                    nextField.setSelectionRange(nextField.value.length, nextField.value.length);
                }
            }
        }
    };

    document.addEventListener("keydown", handleKeyDown);

    return () => {
        document.removeEventListener("keydown", handleKeyDown);
    };
}
