// src/ts/roboha/planyvannya/planyvannya_auth_guard.ts
// 🔐 ПОВНИЙ ЗАХИСТ сторінки planyvannya.html

import { supabase } from "../../vxid/supabaseClient";
import { getGitUrl, getFallbackUrl } from "../../utils/gitUtils";
import { initUrlUpdater } from "../../utils/urlUpdater";
// import { obfuscateCurrentUrl } from "../../vxid/url_obfuscator";
import { enforcePageAccess } from "../zakaz_naraudy/inhi/page_access_guard";



// Перевірка email через базу даних whitelist
async function isEmailAllowed(email: string | undefined): Promise<boolean> {
  if (!email) return false;
  try {
    const { data, error } = await supabase
      .from("whitelist")
      .select("email")
      .eq("email", email.toLowerCase())
      .single();
    if (error?.code === "PGRST116") return false;
    if (error) {
      return false;
    }
    return !!data;
  } catch (err) {
    return false;
  }
}

async function checkPlanningAccess(): Promise<void> {
  try {
    const {
      data: { session },
      error,
    } = await supabase.auth.getSession();

    if (error || !session) {
      // console.warn("⛔ [Планування] Немає Google сесії");
      const indexUrl = await getGitUrl("index.html");
      window.location.replace(indexUrl);
      return;
    }

    const email = session.user.email;
    const allowed = await isEmailAllowed(email);

    if (!allowed) {
      // console.warn("⛔ [Планування] Email не в whitelist:", email);
      await supabase.auth.signOut();
      const indexUrl = await getGitUrl("index.html");
      window.location.replace(indexUrl);
      return;
    }



    // Оновлюємо посилання на сторінці
    initUrlUpdater();

    // Змінюємо URL
    // obfuscateCurrentUrl();

    // 🔐 Перевіряємо доступ до сторінки на основі налаштувань
    await enforcePageAccess();

    // Показуємо сторінку
    document.body.classList.add("auth-verified");
  } catch (err) {
    // console.error("❌ [Планування] Помилка перевірки:", err);
    const fallbackUrl = await getFallbackUrl("index.html");
    window.location.replace(fallbackUrl);
  }
}

// Запускаємо перевірку
checkPlanningAccess();
