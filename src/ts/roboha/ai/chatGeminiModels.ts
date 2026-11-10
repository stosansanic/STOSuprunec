/** Model metadata only: keys remain in memory, never in storage or URLs. */
const ROOT = "https://generativelanguage.googleapis.com/v1beta/models";
const TTL = 60 * 60 * 1000;
export interface ChatGeminiModel { id: string; version: number[]; lite: boolean; outputTokenLimit?: number; thinking?: boolean }
const caches = new Map<string, { at: number; models: ChatGeminiModel[] }>();
const unavailable = new Map<string, Set<string>>();
const busyUntil = new Map<string, number>();
let selected = "auto";
try { selected = localStorage.getItem("aiGeminiModel") || "auto"; } catch { /* storage unavailable */ }
export function getChatGeminiSelection(): string { return selected; }
export function setChatGeminiSelection(value: string): void {
  selected = value === "auto" || /^gemini-\d+(?:\.\d+)*-flash(?:-lite)?$/.test(value) ? value : "auto";
  try { localStorage.setItem("aiGeminiModel", selected); } catch { /* storage unavailable */ }
}
export async function listChatGeminiModels(key: string, signal?: AbortSignal): Promise<ChatGeminiModel[]> {
  signal?.throwIfAborted();
  const cached = caches.get(key);
  if (cached && Date.now() - cached.at < TTL) return cached.models.filter(m => !unavailable.get(key)?.has(m.id));
  const found = new Map<string, ChatGeminiModel>();
  const controller = new AbortController();
  const abort = () => controller.abort();
  signal?.addEventListener("abort", abort, { once: true });
  const timer = setTimeout(abort, 15000);
  let token = "";
  try {
    for (let page = 0; page < 10; page++) {
      const url = new URL(ROOT);
      url.searchParams.set("pageSize", "1000");
      if (token) url.searchParams.set("pageToken", token);
      const response = await fetch(url, { headers: { "x-goog-api-key": key }, signal: controller.signal, cache: "no-store" });
      if (!response.ok) throw Object.assign(new Error(`Не вдалося завантажити моделі Gemini (${response.status}). Перевірте ключ і доступ до API.`), { status: response.status });
      const data = await response.json();
      for (const model of data.models || []) {
        const match = /^models\/(gemini-(\d+(?:\.\d+)*)-flash(-lite)?)$/.exec(model.name || "");
        if (!match || !model.supportedGenerationMethods?.includes("generateContent")) continue;
        const version = match[2].split(".").map(Number);
        if (version[0] < 2 || (version[0] === 2 && (version[1] || 0) < 5)) continue;
        found.set(match[1], { id: match[1], version, lite: !!match[3], thinking: model.thinking, outputTokenLimit: model.outputTokenLimit });
      }
      token = data.nextPageToken || "";
      if (!token) break;
    }
    if (token) throw new Error("Google повернув неповний список моделей. Повторіть запит.");
    const models = [...found.values()].sort((a, b) => {
      if (a.lite !== b.lite) return Number(a.lite) - Number(b.lite);
      for (let i = 0; i < Math.max(a.version.length, b.version.length); i++) {
        const diff = (b.version[i] || 0) - (a.version[i] || 0);
        if (diff) return diff;
      }
      return a.id.localeCompare(b.id);
    });
    if (!models.length) throw new Error("Для цього ключа не знайдено доступних Flash-моделей Gemini.");
    caches.set(key, { at: Date.now(), models });
    unavailable.delete(key);
    while (caches.size > 8) { const oldest = caches.keys().next().value!; caches.delete(oldest); unavailable.delete(oldest); }
    return models;
  } finally { clearTimeout(timer); signal?.removeEventListener("abort", abort); }
}

export function adaptChatGeminiBody(raw: string, model: ChatGeminiModel): string {
  const body = JSON.parse(raw);
  const config = { ...body.generationConfig };
  if (model.version[0] >= 3) {
    delete config.temperature; delete config.topP; delete config.topK; delete config.candidateCount;
    if (config.thinkingConfig) {
      const budget = config.thinkingConfig.thinkingBudget;
      config.thinkingConfig = { thinkingLevel: budget > 4096 ? "HIGH" : budget > 1024 ? "MEDIUM" : "LOW" };
    }
  } else if (model.thinking === false) delete config.thinkingConfig;
  if (typeof model.outputTokenLimit === "number" && model.outputTokenLimit > 0 && config.maxOutputTokens > model.outputTokenLimit) config.maxOutputTokens = model.outputTokenLimit;
  return JSON.stringify({ ...body, generationConfig: config });
}

/** A request session pins its model after the first success, preserving tool signatures. */
export async function createChatGeminiRequest(key: string, signal?: AbortSignal) {
  const choice = selected;
  const models = await listChatGeminiModels(key, signal);
  const candidates = (choice === "auto" ? models : models.filter(m => m.id === choice))
    .filter(m => (busyUntil.get(m.id) || 0) <= Date.now());
  if (!candidates.length && models.length) throw Object.assign(new Error("Моделі Gemini тимчасово недоступні. Спробуйте через хвилину."), { status: 503 });
  if (!candidates.length) throw new Error("Обрана модель недоступна для цього ключа. Виберіть «🤖 Авто».");
  let index = 0;
  let pinned = false;
  return async (init: RequestInit): Promise<Response> => {
    for (;;) {
      signal?.throwIfAborted();
      const model = candidates[index];
      const headers = new Headers(init.headers);
      headers.set("x-goog-api-key", key);
      const response = await fetch(`${ROOT}/${model.id}:generateContent`, {
        ...init, headers, signal: init.signal || signal,
        body: adaptChatGeminiBody(String(init.body), model),
      });
      // Do not replay network failures, tool conversations, quota or permission errors.
      if (response.status === 404) {
        const blocked = unavailable.get(key) || new Set<string>();
        blocked.add(model.id); unavailable.set(key, blocked);
        if (!pinned && choice === "auto" && index + 1 < candidates.length && index < 2) { index++; continue; }
      }
      if ([502, 503, 504].includes(response.status)) {
        busyUntil.set(model.id, Date.now() + 60000);
        if (!pinned && choice === "auto" && index + 1 < candidates.length && index < 2) { index++; continue; }
      }
      if (response.ok) pinned = true;
      return response;
    }
  };
}
