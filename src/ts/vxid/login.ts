// src/ts/vxid/login.ts
// 🔐 СИСТЕМА ВХОДУ: Google OAuth + Whitelist перевірка
import { supabase } from "./supabaseClient";
import { getOAuthRedirectUrl, getPageUrl } from '../../config/project.config';

// 🔍 Перевірка email через базу даних whitelist
async function isEmailAllowed(email: string | undefined): Promise<boolean> {
  if (!email) return false;

  try {
    // Перевіряємо чи є email в whitelist (завдяки RLS побачимо тільки свій email)
    const { data, error } = await supabase
      .from("whitelist")
      .select("email")
      .eq("email", email.toLowerCase())
      .single();

    if (error) {
      // Якщо помилка "не знайдено" - це нормально, email не в whitelist
      if (error.code === "PGRST116") {
        // console.warn("⛔ Email не знайдено в whitelist:", email);
        return false;
      }
      // Інші помилки логуємо
      // console.error("❌ Помилка перевірки whitelist:", error);
      return false;
    }

    // Якщо data існує - email в whitelist
    return !!data;
  } catch (err) {
    // console.error("❌ Виняток при перевірці whitelist:", err);
    return false;
  }
}

// 🌐 Визначення адреси перенаправлення залежно від поточного домену
// 🔧 Використовуємо централізований конфіг з src/config/project.config.ts
const getRedirectUrl = (): string => {
  return getOAuthRedirectUrl('main.html');
};

// 🚪 Вхід через Google OAuth
export async function signInWithGoogle() {

  // 🔥 Визначаємо правильний redirect URL залежно від середовища
  const redirectUrl = getOAuthRedirectUrl();
  
  const { error } = await supabase.auth.signInWithOAuth({
    provider: "google",
    options: {
      redirectTo: redirectUrl,
      // Без prompt - Google автоматично увійде якщо є активна сесія
      // 'select_account' - показує вибір акаунту але без підтвердження дозволів
    },
  });

  if (error) {
    // console.error("❌ Помилка Google OAuth:", error);
  }
}

// 🔍 Перевірка сесії при завантаженні сторінки
async function checkExistingSession() {

  const {
    data: { session },
    error,
  } = await supabase.auth.getSession();

  if (error) {
    // console.error("❌ Помилка отримання сесії:", error);
    return;
  }

  if (session?.user) {
    await handleAuthenticatedUser(session.user);
  }
}

// 🔐 Обробка автентифікованого користувача
async function handleAuthenticatedUser(user: any) {
  const email = user.email;

  const allowed = await isEmailAllowed(email);
  if (!allowed) {
    // console.warn("⛔ Email НЕ в whitelist:", email);
    await supabase.auth.signOut();
    // � Використовуємо централізований конфіг
    window.location.href = getPageUrl('index.html');
    return;
  }
  
  // 🔥 Перевіряємо, де ми зараз, щоб не перезавантажувати сторінку вічно
  if (!window.location.pathname.includes("main.html")) {
    const redirectUrl = getRedirectUrl();
    window.location.href = redirectUrl;
  }
}

// 🎯 Відстеження змін авторизації
supabase.auth.onAuthStateChange(async (event, session) => {
  if (event === "SIGNED_IN" && session?.user) {
    await handleAuthenticatedUser(session.user);
  }
});

// 🧠 Ініціалізація при завантаженні - перевірка сесії
document.addEventListener("DOMContentLoaded", async () => {
  // Перевіряємо чи вже є сесія
  await checkExistingSession();
});