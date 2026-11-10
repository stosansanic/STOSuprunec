// src/ts/vxid/checkSession.ts
import { supabase } from "./supabaseClient";
import { redirectToIndex } from "../utils/gitUtils";

export async function requireAuth() {
  const {
    data: { session },
    error,
  } = await supabase.auth.getSession();

  if (!session || error) {
    if (!window.location.pathname.includes("index.html")) {
      // console.warn("⛔ Сесія відсутня або помилка:", error);
      redirectToIndex();
    }
    return;
  }

  return session;
}
