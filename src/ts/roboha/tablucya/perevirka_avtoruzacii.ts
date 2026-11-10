import { notify as showAppMessage } from "../../utils/appDialogs";
// src/ts/roboha/tablucya/auth_guards.ts
// Контроль доступу через Google Auth для кнопок меню

import { supabase } from "../../vxid/supabaseClient";

/**
 * Ініціалізація захисту для кнопок, які потребують авторизації через Google
 */
export function initializeAuthGuards(): void {
    // Чекаємо поки DOM завантажиться
    document.addEventListener("DOMContentLoaded", () => {
        setupBukhhalteriyaGuard();
        setupHomeGuard();
        setupClientGuard();
        setupPlanyvannyaGuard();
    });
}

/**
 * Захист для кнопки "Бухгалтерія"
 */
function setupBukhhalteriyaGuard(): void {
    const bukhhLink = document.querySelector('[data-action="openBukhhalteriya"]');

    if (bukhhLink) {
        // Додаємо обробник на CAPTURE фазі, щоб спрацював ПЕРШИМ
        bukhhLink.addEventListener("click", async (e: Event) => {
            e.preventDefault(); // Блокуємо стандартну поведінку
            e.stopPropagation(); // Зупиняємо всплиття події


            try {
                const { data: { session } } = await supabase.auth.getSession();

                if (!session) {
                    showAppMessage("⛔ Доступ заблоковано. Ви не авторизовані через Google.");
                    // console.warn("❌ Спроба доступу без авторизації");
                    return;
                }

                // Якщо авторизований - переходимо на сторінку
                window.location.href = "bukhhalteriya.html";
            } catch (error) {
                // console.error("❌ Помилка перевірки авторизації:", error);
                showAppMessage("⛔ Помилка перевірки авторизації");
            }
        }, true); // true = capture phase
    }
}

/**
 * Захист для кнопки "Наряд" (openHome)
 */
function setupHomeGuard(): void {
    const homeLink = document.querySelector('[data-action="openHome"]');

    if (homeLink) {
        homeLink.addEventListener("click", async (e: Event) => {

            try {
                const { data: { session } } = await supabase.auth.getSession();

                if (!session) {
                    e.preventDefault();
                    e.stopPropagation();
                    showAppMessage("⛔ Доступ заблоковано. Ви не авторизовані через Google.");
                    // console.warn("❌ Спроба доступу без авторизації до Наряду");
                    return;
                }

            } catch (error) {
                e.preventDefault();
                e.stopPropagation();
                // console.error("❌ Помилка перевірки авторізації:", error);
                showAppMessage("⛔ Помилка перевірки авторизації");
            }
        }, true);
    }
}

/**
 * Захист для кнопки "Додати" (openClient)
 * Тут вже є перевірка в dodatu_inchi_bazu_danux.ts, але додаємо додатковий захист
 */
function setupClientGuard(): void {
    const clientLink = document.querySelector('[data-action="openClient"]');

    if (clientLink) {
        // Додаємо перевірку на CAPTURE фазі, щоб спрацювала ПЕРЕД існуючими обробниками
        clientLink.addEventListener("click", async (e: Event) => {

            try {
                const { data: { session } } = await supabase.auth.getSession();

                if (!session) {
                    e.preventDefault();
                    e.stopImmediatePropagation(); // Зупиняємо ВСІ інші обробники
                    showAppMessage("⛔ Доступ заблоковано. Ви не авторизовані через Google.");
                    // console.warn("❌ Спроба доступу без авторизації до Додати");
                    return;
                }

            } catch (error) {
                e.preventDefault();
                e.stopImmediatePropagation();
                // console.error("❌ Помилка перевірки авторізації:", error);
                showAppMessage("⛔ Помилка перевірки авторизації");
            }
        }, true);
    }
}

/**
 * Захист для кнопки "Планування"
 */
function setupPlanyvannyaGuard(): void {
    const planLink = document.querySelector('[data-action="openPlanyvannya"]');

    if (planLink) {
        planLink.addEventListener("click", async (e: Event) => {
            e.preventDefault();
            e.stopPropagation();

            try {
                const { data: { session } } = await supabase.auth.getSession();

                if (!session) {
                    showAppMessage("⛔ Доступ заблоковано. Ви не авторизовані через Google.");
                    return;
                }

                window.location.href = "planyvannya.html";
            } catch (error) {
                showAppMessage("⛔ Помилка перевірки авторизації");
            }
        }, true);
    }
}

// Автоматично ініціалізуємо при імпорті
initializeAuthGuards();
