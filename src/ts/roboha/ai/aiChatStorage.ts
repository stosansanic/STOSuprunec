// src/ts/roboha/ai/aiChatStorage.ts
// 💾 Зберігання чатів Атлас: ai_chats + ai_messages + Storage (ai-photos)

import { supabase } from "../../vxid/supabaseClient";
import { createMessagePageCache } from "./messagePageCache";
import { invalidateResourceFiles } from "./resourceUsage";
export { getDatabaseStats, getStorageStats, peekDatabaseStats, peekStorageStats } from "./resourceUsage";

const messagePages = createMessagePageCache<AiMessage>(() => localStorage.getItem("userAuthData") || "");
let chatAuthUserId = "";
const chatPages = createMessagePageCache<AiChat>(() => JSON.stringify([
  chatAuthUserId, localStorage.getItem("userAuthData") || "",
]));
const CHAT_REVISION = "sto:chat-revision";
const FILE_REVISION = "sto:chat-files-revision";
function invalidateChats(): void {
  chatPages.clear();
  try { localStorage.setItem(CHAT_REVISION, crypto.randomUUID()); } catch { /* Short memory TTL still applies. */ }
}
function invalidateMessages(): void {
  messagePages.clear();
  try { localStorage.setItem(CHAT_REVISION, crypto.randomUUID()); } catch { /* Cache freshness still has a bounded TTL. */ }
}

/** Realtime deletion/reconciliation only invalidates message pages; it does not fetch message bodies. */
export function invalidateChatMessageCache(): void { messagePages.clear(); }

export async function loadExistingMessageIds(chatId: number, messageIds: number[]): Promise<Set<number>> {
  const existing = new Set<number>();
  const ids = [...new Set(messageIds.filter(id => Number.isSafeInteger(id) && id > 0))];
  for (let offset = 0; offset < ids.length; offset += 200) {
    const { data, error } = await supabase.from("ai_messages").select("message_id")
      .eq("chat_id", chatId).in("message_id", ids.slice(offset, offset + 200));
    if (error) throw error;
    for (const row of data || []) existing.add(Number(row.message_id));
  }
  return existing;
}
function invalidateFiles(): void {
  invalidateResourceFiles();
  try { localStorage.setItem(FILE_REVISION, crypto.randomUUID()); } catch { /* No persistence needed for the cache. */ }
}
// A reconnect, account change or return from another app requires a fresh read.
window.addEventListener("online", messagePages.clear);
window.addEventListener("focus", messagePages.clear);
window.addEventListener("storage", event => {
  if (!event.key || event.key === "userAuthData" || event.key === CHAT_REVISION) {
    messagePages.clear();
    chatPages.clear();
  }
});
supabase.auth.onAuthStateChange((_event, session) => {
  messagePages.clear();
  const next = session?.user.id || "";
  if (chatAuthUserId !== next) { chatAuthUserId = next; chatPages.clear(); }
});

// ============================================================
// ТИПИ
// ============================================================

export interface AiChat {
  chat_id: number;
  user_id: string;
  title: string;
  created_at: string;
  updated_at: string;
  favorites: boolean | null;
}

export interface AiMessage {
  message_id: number;
  chat_id: number;
  role: "user" | "assistant";
  text: string;
  images: string[]; // масив публічних URL з Storage
  created_at: string;
}

// ============================================================
// ЧАТИ — CRUD
// ============================================================

/** Завантажити всі чати користувача (останні 50, сортуємо по updated_at) */
export async function loadChats(userId: string): Promise<AiChat[]> {
  return chatPages.read(`user:${userId}`, async () => {
    const { data, error } = await supabase
      .from("ai_chats")
      .select("chat_id,user_id,title,created_at,updated_at,favorites")
      .eq("user_id", userId)
      .order("updated_at", { ascending: false })
      .limit(50);
    if (error) throw error;
    return (data as AiChat[]) || [];
  });
}

/** Завантажити ВСІ чати (для адміністратора) */
export async function loadAllChats(): Promise<AiChat[]> {
  return chatPages.read("all", async () => {
    const { data, error } = await supabase
      .from("ai_chats")
      .select("chat_id,user_id,title,created_at,updated_at,favorites")
      .order("updated_at", { ascending: false })
      .limit(100);
    if (error) throw error;
    return (data as AiChat[]) || [];
  });
}

/** Створити новий чат */
export async function createChat(
  userId: string,
  title = "Новий чат",
): Promise<AiChat | null> {
  const { data, error } = await supabase
    .from("ai_chats")
    .insert({ user_id: userId, title })
    .select()
    .single();
  if (error) return null;
  invalidateChats();
  return data as AiChat;
}

/** Перейменувати чат */
export async function renameChat(
  chatId: number,
  title: string,
): Promise<boolean> {
  const { error } = await supabase
    .from("ai_chats")
    .update({ title, updated_at: new Date().toISOString() })
    .eq("chat_id", chatId);
  if (error) return false;
  invalidateChats();
  return true;
}

/** Перемкнути favorites для чату */
export async function toggleFavorite(
  chatId: number,
  value: boolean,
): Promise<boolean> {
  const { error } = await supabase
    .from("ai_chats")
    .update({ favorites: value })
    .eq("chat_id", chatId);
  if (error) return false;
  invalidateChats();
  return true;
}

/** Оновити updated_at чату (викликати при кожному новому повідомленні) */
export async function touchChat(chatId: number): Promise<void> {
  const { error } = await supabase
    .from("ai_chats")
    .update({ updated_at: new Date().toISOString() })
    .eq("chat_id", chatId);
  if (!error) invalidateChats();
}

/**
 * Видалити чат разом із повідомленнями і фото зі Storage.
 * Порядок: 1) видалити фото зі Storage, 2) видалити запис (CASCADE видалить messages)
 */
export async function deleteChat(chatId: number): Promise<boolean> {
  try {
    // Collect every metadata page before removal so offsets cannot skip files.
    const paths = new Set<string>();
    let after = 0;
    while (true) {
      const { data, error } = await supabase.from("ai_messages")
        .select("message_id,images").eq("chat_id", chatId)
        .gt("message_id", after).order("message_id", { ascending: true }).limit(200);
      if (error) throw error;
      const rows = data || [];
      for (const msg of rows) {
        for (const url of Array.isArray(msg.images) ? msg.images : []) {
          const match = String(url).match(/ai-photos\/(.+)$/);
          if (match) paths.add(match[1]);
        }
      }
      if (!rows.length) break;
      const next = Number(rows[rows.length - 1].message_id);
      if (!Number.isSafeInteger(next) || next <= after) throw new Error("Invalid message cursor");
      after = next;
    }
    for (let offset = 0; ; offset += 200) {
      const { data, error } = await supabase.storage.from("ai-photos")
        .list(String(chatId), { limit: 200, offset, sortBy: { column: "name", order: "asc" } });
      if (error) throw error;
      for (const file of data || []) {
        if (file.id !== null) paths.add(String(chatId) + "/" + file.name);
      }
      if (!data || data.length < 200) break;
    }
    const files = [...paths];
    for (let offset = 0; offset < files.length; offset += 100) {
      const { error } = await supabase.storage.from("ai-photos").remove(files.slice(offset, offset + 100));
      if (error) throw error;
      invalidateFiles();
    }

    // 3. Видаляємо чат (CASCADE видалить ai_messages автоматично)
    const { error } = await supabase
      .from("ai_chats")
      .delete()
      .eq("chat_id", chatId);
    if (error) return false;
    invalidateChats();
    invalidateMessages();
    invalidateFiles();
    return true;
  } catch {
    return false;
  }
}

// ============================================================
// ПОВІДОМЛЕННЯ
// ============================================================

/** Latest page, or the page immediately before the stable timestamp/ID cursor. */
export async function loadMessages(chatId: number, before?: Pick<AiMessage, "created_at" | "message_id">): Promise<AiMessage[]> {
  return messagePages.read(JSON.stringify([chatId, before || null]), async () => {
  let query = supabase
    .from("ai_messages")
    .select("message_id,chat_id,role,text,images,created_at")
    .eq("chat_id", chatId)
    .order("created_at", { ascending: false })
    .order("message_id", { ascending: false }).limit(50);
  if (before) query = query.or(`created_at.lt.${before.created_at},and(created_at.eq.${before.created_at},message_id.lt.${before.message_id})`);
  const { data, error } = await query;
  if (error) throw error;
  return ((data as AiMessage[]) || []).reverse();
  });
}

/** Зберегти повідомлення в БД */
export async function saveMessage(
  chatId: number,
  role: "user" | "assistant",
  text: string,
  imageUrls: string[] = [],
): Promise<Pick<AiMessage, "message_id"> | null> {
  const { data, error } = await supabase.rpc("traffic_chat_append", {
    p_chat_id: chatId, p_role: role, p_text: text, p_images: imageUrls,
  });
  if (error) return null;
  if (!Number.isSafeInteger(Number(data?.message_id))) return null;
  invalidateMessages();
  invalidateChats();
  return data as Pick<AiMessage, "message_id">;
}

/** Видалити одне повідомлення з БД за message_id (+ фото зі Storage) */
export async function deleteMessage(messageId: number): Promise<boolean> {
  try {
    // 1. Дістаємо URL фото перед видаленням запису
    const { data: msg, error: readError } = await supabase
      .from("ai_messages")
      .select("images")
      .eq("message_id", messageId)
      .single();

    if (readError) throw readError;
    if (msg?.images && Array.isArray(msg.images) && msg.images.length > 0) {
      const paths = msg.images
        .map((url: string) => {
          const match = url.match(/ai-photos\/(.+)$/);
          return match ? match[1] : null;
        })
        .filter(Boolean) as string[];
      if (paths.length > 0) {
        const { error: removeError } = await supabase.storage.from("ai-photos").remove(paths);
        if (removeError) throw removeError;
        invalidateFiles();
      }
    }

    // 2. Видаляємо запис із БД
    const { error } = await supabase
      .from("ai_messages")
      .delete()
      .eq("message_id", messageId);
    if (error) return false;
    invalidateMessages();
    invalidateFiles();
    return true;
  } catch {
    return false;
  }
}

// ============================================================
// STORAGE — ФОТО
// ============================================================

/**
 * Завантажити фото в Supabase Storage.
 * Повертає публічний URL або null при помилці.
 * Шлях: ai-photos/{chatId}/{timestamp}_{rand}_{index}.ext
 */
export async function uploadPhoto(
  chatId: number,
  base64: string,
  mimeType: string,
  index = 0,
): Promise<string | null> {
  try {
    // base64 → Blob
    const byteStr = atob(base64);
    const arr = new Uint8Array(byteStr.length);
    for (let i = 0; i < byteStr.length; i++) arr[i] = byteStr.charCodeAt(i);
    const extMap: Record<string, string> = {
      "image/png": "png",
      "image/webp": "webp",
    };
    const ext = extMap[mimeType] || "jpg";
    const rand = Math.random().toString(36).slice(2, 8);
    const fileName = `${chatId}/${Date.now()}_${rand}_${index}.${ext}`;
    const blob = new Blob([arr], { type: mimeType });

    const { error } = await supabase.storage
      .from("ai-photos")
      .upload(fileName, blob, { upsert: false, contentType: mimeType });

    if (error) return null;

    // Отримуємо публічний URL
    const { data: urlData } = supabase.storage
      .from("ai-photos")
      .getPublicUrl(fileName);

    invalidateFiles();
    return urlData.publicUrl;
  } catch {
    return null;
  }
}

/**
 * Завантажити масив фото паралельно і повернути масив публічних URL.
 * Передається інтерфейс з base64 + mimeType.
 */
export async function uploadPhotos(
  chatId: number,
  images: Array<{ base64: string; mimeType: string }>,
): Promise<string[]> {
  const results = await Promise.allSettled(
    images.map((img, i) => uploadPhoto(chatId, img.base64, img.mimeType, i)),
  );
  return results
    .filter(
      (r): r is PromiseFulfilledResult<string | null> =>
        r.status === "fulfilled",
    )
    .map((r) => r.value)
    .filter((url): url is string => url !== null);
}

// ============================================================
// АВТО-ВИДАЛЕННЯ СТАРИХ ЧАТІВ (> 90 днів)
// ============================================================

/**
 * Видалити всі чати старші за 90 днів для конкретного user_id.
 * Включно з фото в Storage.
 */
export async function deleteOldChats(userId: string, days = 90): Promise<void> {
  try {
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - days);

    const { data: oldChats } = await supabase
      .from("ai_chats")
      .select("chat_id")
      .eq("user_id", userId)
      .lt("updated_at", cutoff.toISOString());

    for (const chat of oldChats || []) {
      await deleteChat(chat.chat_id);
    }
  } catch {
    /* silent */
  }
}
