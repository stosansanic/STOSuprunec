/** Gemini transport scoped to invoice recognition; no chat history or database reads. */
const API_ROOT = "https://generativelanguage.googleapis.com/v1beta";
const MODEL_TTL_MS = 60 * 60 * 1000;
const UNAVAILABLE_TTL_MS = 10 * 60 * 1000;
const BUSY_TTL_MS = 60_000;
const TIMEOUT_TTL_MS = 120_000;
const ATTEMPT_TIMEOUT_MS = 90_000;
const TOTAL_TIMEOUT_MS = 210_000;
const MAX_KEYS = 8;
const MAX_GENERATION_ATTEMPTS = 2;
const TRANSIENT_STATUSES = new Set([408, 500, 502, 503, 504]);
const FLASH_ID = /^gemini-(\d+(?:\.\d+)*)-flash(-lite)?$/;

interface InvoiceModel {
  id: string;
  version: number[];
  lite: boolean;
  outputTokenLimit?: number;
  thinking?: boolean;
}

interface ModelCache {
  models: InvoiceModel[];
  loadedAt: number;
  preferred?: string;
  unavailableUntil: Map<string, number>;
  pending?: Promise<InvoiceModel[]>;
}

// Keys and model metadata stay in memory only. No prompt/document/result is cached.
const modelCaches = new Map<string, ModelCache>();

function aborted(): DOMException {
  return new DOMException("Розпізнавання скасовано.", "AbortError");
}

function assertActive(signal: AbortSignal): void {
  if (signal.aborted) throw aborted();
}

function forCaller<T>(pending: Promise<T>, signal: AbortSignal): Promise<T> {
  assertActive(signal);
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(aborted());
    signal.addEventListener("abort", onAbort, { once: true });
    pending.then(resolve, reject).finally(() => {
      signal.removeEventListener("abort", onAbort);
    });
  });
}

function cacheFor(apiKey: string): ModelCache {
  let cached = modelCaches.get(apiKey);
  if (!cached) {
    cached = { models: [], loadedAt: 0, unavailableUntil: new Map() };
  }
  modelCaches.delete(apiKey);
  modelCaches.set(apiKey, cached);
  while (modelCaches.size > MAX_KEYS) {
    const oldest = modelCaches.keys().next().value;
    if (oldest === undefined) break;
    modelCaches.delete(oldest);
  }
  for (const [id, until] of cached.unavailableUntil) {
    if (until <= Date.now()) cached.unavailableUntil.delete(id);
  }
  return cached;
}

function serviceError(status: number, discovery = false): Error {
  if (status === 429) {
    return new Error("Google обмежив кількість запитів або вичерпано квоту Gemini. Перевірте ліміти ключа в Google AI Studio та повторіть розпізнавання пізніше.");
  }
  if (status === 401 || status === 403) {
    return new Error("Google відхилив доступ до Gemini. Перевірте API-ключ, його дозволи та доступність Gemini API для цього проєкту.");
  }
  if (status === 400) {
    return new Error(discovery
      ? "Google не прийняв запит переліку моделей. Перевірте чинність API-ключа Gemini."
      : "Google не прийняв документ або параметри розпізнавання. Перевірте формат і розмір PDF/фото та API-ключ Gemini.");
  }
  if (TRANSIENT_STATUSES.has(status)) {
    return new Error("Gemini тимчасово перевантажений або недоступний. Спробуйте розпізнати документ пізніше; дані накладної не змінено.");
  }
  return new Error(discovery
    ? `Не вдалося отримати доступні моделі Gemini (HTTP ${status}). Повторіть пізніше.`
    : `Google не виконав розпізнавання (HTTP ${status}). Повторіть пізніше.`);
}

function parseModel(value: unknown): InvoiceModel | null {
  if (!value || typeof value !== "object") return null;
  const model = value as Record<string, unknown>;
  if (typeof model.name !== "string" || !model.name.startsWith("models/")) return null;
  const id = model.name.slice("models/".length);
  const match = FLASH_ID.exec(id);
  if (!match || !Array.isArray(model.supportedGenerationMethods)
    || !model.supportedGenerationMethods.includes("generateContent")) return null;
  const version = match[1].split(".").map(Number);
  if (version[0] < 2 || (version[0] === 2 && (version[1] || 0) < 5)) return null;
  const outputTokenLimit = typeof model.outputTokenLimit === "number"
    && Number.isSafeInteger(model.outputTokenLimit) && model.outputTokenLimit > 0
    ? model.outputTokenLimit : undefined;
  const thinking = typeof model.thinking === "boolean" ? model.thinking : undefined;
  return { id, version, lite: Boolean(match[2]), outputTokenLimit, thinking };
}

function compareModels(a: InvoiceModel, b: InvoiceModel): number {
  if (a.lite !== b.lite) return a.lite ? -1 : 1;
  for (let i = 0; i < Math.max(a.version.length, b.version.length); i += 1) {
    const difference = (b.version[i] || 0) - (a.version[i] || 0);
    if (difference) return difference;
  }
  return a.id.localeCompare(b.id);
}

async function discoverModels(apiKey: string): Promise<InvoiceModel[]> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15_000);
  const found = new Map<string, InvoiceModel>();
  let pageToken = "";
  try {
    for (let page = 0; page < 3; page += 1) {
      const url = new URL(`${API_ROOT}/models`);
      url.searchParams.set("pageSize", "1000");
      if (pageToken) url.searchParams.set("pageToken", pageToken);
      let response: Response;
      try {
        response = await fetch(url.toString(), {
          headers: { "x-goog-api-key": apiKey },
          signal: controller.signal,
          cache: "no-store",
        });
      } catch {
        throw new Error(controller.signal.aborted
          ? "Google не відповів на запит доступних моделей Gemini. Спробуйте пізніше."
          : "Не вдалося з’єднатися з Gemini. Перевірте з’єднання з інтернетом та повторіть пізніше.");
      }
      if (!response.ok) throw serviceError(response.status, true);
      let payload: unknown;
      try {
        payload = await response.json();
      } catch {
        throw new Error("Google не повернув повний перелік моделей Gemini. Спробуйте пізніше.");
      }
      if (!payload || typeof payload !== "object") throw new Error("Google повернув некоректний перелік моделей Gemini.");
      const data = payload as Record<string, unknown>;
      if (data.models !== undefined && !Array.isArray(data.models)) {
        throw new Error("Google повернув некоректний перелік моделей Gemini.");
      }
      for (const entry of (data.models as unknown[] | undefined) || []) {
        const model = parseModel(entry);
        if (model) found.set(model.id, model);
      }
      pageToken = typeof data.nextPageToken === "string" ? data.nextPageToken : "";
      if (!pageToken) return [...found.values()].sort(compareModels);
    }
    // A partial list must not become the authoritative cache for later documents.
    throw new Error("Google повернув неповний перелік моделей Gemini. Повторіть розпізнавання пізніше.");
  } finally {
    clearTimeout(timeout);
  }
}

async function getModels(apiKey: string, cache: ModelCache, signal: AbortSignal): Promise<InvoiceModel[]> {
  if (cache.loadedAt && Date.now() - cache.loadedAt < MODEL_TTL_MS) return cache.models;
  if (!cache.pending) {
    // Metadata discovery has its own timeout. Closing one invoice must not cancel
    // another invoice waiting for the same small, shared model-list request.
    const pending = discoverModels(apiKey).then((models) => {
      cache.models = models;
      cache.loadedAt = Date.now();
      return models;
    });
    cache.pending = pending;
    pending.then(() => { cache.pending = undefined; }, () => { cache.pending = undefined; });
  }
  return forCaller(cache.pending, signal);
}

function retryDelay(response: Response, retryIndex: number): number {
  const header = response.headers.get("Retry-After");
  if (header !== null) {
    const seconds = Number(header);
    if (Number.isFinite(seconds) && seconds >= 0) return Math.max(500, seconds * 1000);
    const date = Date.parse(header);
    if (Number.isFinite(date)) return Math.max(500, date - Date.now());
  }
  return Math.min(4_000, 1_000 * (2 ** retryIndex));
}

function waitForRetry(delay: number, signal: AbortSignal): Promise<void> {
  assertActive(signal);
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      reject(aborted());
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, delay);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

function bodyForModel(body: object, model: InvoiceModel): string {
  const source = body as Record<string, unknown>;
  const config = source.generationConfig;
  const generationConfig = config && typeof config === "object"
    ? { ...config } as Record<string, unknown> : {};
  // Gemini 3 uses provider sampling defaults; newer variants reject these
  // legacy overrides. Preserve all other caller options (including JSON mode).
  if (model.version[0] >= 3) {
    delete generationConfig.temperature;
    delete generationConfig.topP;
    delete generationConfig.topK;
  }
  // Only advertised thinking capability enables the version-specific setting.
  // LOW is supported for Gemini 3 Flash; Gemini 2.5 uses a token budget instead.
  if (model.thinking === true && model.version[0] >= 3) {
    generationConfig.thinkingConfig = { thinkingLevel: "LOW", includeThoughts: false };
  } else if (model.thinking === true && model.version[0] === 2 && model.version[1] === 5) {
    generationConfig.thinkingConfig = { thinkingBudget: 0, includeThoughts: false };
  }
  const maxOutputTokens = generationConfig.maxOutputTokens;
  if (model.outputTokenLimit && typeof maxOutputTokens === "number" && maxOutputTokens > model.outputTokenLimit) {
    generationConfig.maxOutputTokens = model.outputTokenLimit;
  }
  return JSON.stringify({ ...source, generationConfig });
}

/** Bounded retries only for explicit HTTP failure; never replay an uncertain POST. */
export async function generateInvoiceWithGemini(
  apiKey: string,
  requestBody: object,
  signal: AbortSignal,
  onProgress?: (message: string) => void,
): Promise<any> {
  assertActive(signal);
  const key = apiKey.trim();
  if (!key) throw new Error("Додайте API-ключ Gemini в налаштуваннях Атласа.");
  const cache = cacheFor(key);
  const deadlineAt = Date.now() + TOTAL_TIMEOUT_MS;
  const operation = new AbortController();
  const cancelOperation = () => operation.abort();
  signal.addEventListener("abort", cancelOperation, { once: true });
  const totalTimeout = setTimeout(() => operation.abort(), TOTAL_TIMEOUT_MS);
  const history: string[] = [];
  const withHistory = (message: string): Error => new Error(
    history.length ? `${message} Спроби: ${history.join("; ")}.` : message,
  );
  const assertOperation = () => {
    assertActive(signal);
    if (operation.signal.aborted || Date.now() >= deadlineAt) {
      throw withHistory("Загальний час очікування Gemini вичерпано. Спробуйте розпізнати документ пізніше.");
    }
  };
  const deferModel = (id: string, duration: number) => {
    cache.unavailableUntil.set(id, Date.now() + duration);
    if (cache.preferred === id) cache.preferred = undefined;
  };
  let slowNoticeSent = false;
  try {
    if (!cache.loadedAt || Date.now() - cache.loadedAt >= MODEL_TTL_MS) {
      onProgress?.("Перевіряю доступні моделі Gemini…");
      assertOperation();
    }
    const available = await getModels(key, cache, operation.signal);
    assertOperation();
    const models = available.filter((model) => (cache.unavailableUntil.get(model.id) || 0) <= Date.now());
    // Invoice extraction starts with the newest stable Lite, then normal Flash.
    // A model that already worked is reused until an explicit error/cooldown.
    const flashIndex = models.findIndex((model) => !model.lite);
    if (models.length > 1 && models[0].lite && flashIndex > 1) {
      models.splice(1, 0, models.splice(flashIndex, 1)[0]);
    }
    const preferredIndex = models.findIndex((model) => model.id === cache.preferred);
    if (preferredIndex > 0) models.unshift(models.splice(preferredIndex, 1)[0]);
    if (!models.length) {
      if (available.length) {
        const waitSeconds = Math.max(1, Math.ceil((Math.min(...available.map(
          (model) => cache.unavailableUntil.get(model.id) || Date.now(),
        )) - Date.now()) / 1000));
        throw new Error(`Моделі Gemini тимчасово недоступні після попередніх спроб. Зачекайте приблизно ${waitSeconds} с і повторіть розпізнавання.`);
      }
      throw new Error("Для цього API-ключа зараз немає доступної стабільної моделі Gemini Flash для розпізнавання. Перевірте доступ у Google AI Studio або повторіть пізніше.");
    }

    const attempted = new Set<string>();
    let transientCount = 0;
    while (attempted.size < MAX_GENERATION_ATTEMPTS) {
      assertOperation();
      // Another invoice may have put a model on cooldown since discovery.
      const model = models.find((item) => !attempted.has(item.id)
        && (cache.unavailableUntil.get(item.id) || 0) <= Date.now());
      if (!model) break;
      if (deadlineAt - Date.now() < ATTEMPT_TIMEOUT_MS) {
        throw withHistory("Недостатньо часу для повної резервної спроби Gemini. Повторіть розпізнавання пізніше.");
      }
      attempted.add(model.id);
      const attemptLabel = `${model.id}, спроба ${attempted.size}/${MAX_GENERATION_ATTEMPTS}`;
      onProgress?.(`Розпізнаю документ: ${attemptLabel}…`);
      assertOperation();
      const controller = new AbortController();
      const onAbort = () => controller.abort();
      operation.signal.addEventListener("abort", onAbort, { once: true });
      let timedOut = false;
      const timeout = setTimeout(() => {
        timedOut = true;
        controller.abort();
      }, Math.min(ATTEMPT_TIMEOUT_MS, deadlineAt - Date.now()));
      const slowTimeout = setTimeout(() => {
        if (!slowNoticeSent && !signal.aborted && !operation.signal.aborted && !controller.signal.aborted) {
          slowNoticeSent = true;
          onProgress?.(`Google ще обробляє PDF/фото: ${attemptLabel}. Очікую відповідь…`);
        }
      }, 30_000);
      let response: Response;
      try {
        response = await fetch(`${API_ROOT}/models/${model.id}:generateContent`, {
          method: "POST",
          headers: { "Content-Type": "application/json", "x-goog-api-key": key },
          body: bodyForModel(requestBody, model),
          signal: controller.signal,
        });
        if (response.ok) {
          const result: unknown = await response.json();
          assertOperation();
          if (!result || typeof result !== "object") throw new Error("Некоректна відповідь Gemini.");
          cache.preferred = model.id;
          cache.unavailableUntil.delete(model.id);
          return result;
        }
      } catch {
        assertActive(signal);
        // A lost/late response does not prove that generation was skipped. Stop;
        // a second upload is allowed only after an explicit HTTP error response.
        if (timedOut || operation.signal.aborted || Date.now() >= deadlineAt) {
          deferModel(model.id, TIMEOUT_TTL_MS);
          history.push(`${model.id}: час очікування вичерпано`);
          throw withHistory("Gemini не встиг завершити відповідь. Автоматичний повтор зупинено; спробуйте пізніше.");
        }
        history.push(`${model.id}: не отримано повну відповідь`);
        throw withHistory("Не вдалося отримати повну відповідь Gemini. Перевірте з’єднання; автоматичний повтор зупинено.");
      } finally {
        clearTimeout(timeout);
        clearTimeout(slowTimeout);
        operation.signal.removeEventListener("abort", onAbort);
      }
      assertOperation();
      history.push(`${model.id}: HTTP ${response.status}`);
      if (response.status === 404) {
        // Listing is metadata, not an authorization guarantee.
        deferModel(model.id, UNAVAILABLE_TTL_MS);
        continue;
      }
      if (!TRANSIENT_STATUSES.has(response.status)) throw withHistory(serviceError(response.status).message);
      const delay = retryDelay(response, transientCount++);
      deferModel(model.id, Math.max(BUSY_TTL_MS, Math.min(delay, UNAVAILABLE_TTL_MS)));
      if (delay > 10_000) {
        throw withHistory("Google просить зачекати перед наступним запитом Gemini. Спробуйте розпізнати документ пізніше.");
      }
      const next = models.find((item) => !attempted.has(item.id)
        && (cache.unavailableUntil.get(item.id) || 0) <= Date.now());
      if (attempted.size >= MAX_GENERATION_ATTEMPTS || !next) break;
      if (deadlineAt - Date.now() - delay < ATTEMPT_TIMEOUT_MS) {
        throw withHistory("Недостатньо часу для повної резервної спроби Gemini. Повторіть розпізнавання пізніше.");
      }
      onProgress?.(`${model.id} тимчасово недоступна (HTTP ${response.status}). Перемикаю на ${next.id}…`);
      await waitForRetry(delay, operation.signal);
    }
    if (transientCount > 0) {
      throw withHistory("Gemini тимчасово не виконав розпізнавання. Доступні резервні спроби вичерпано; повторіть пізніше.");
    }
    throw withHistory("Доступні моделі Gemini зараз недоступні для розпізнавання. Зачекайте та повторіть пізніше.");
  } catch (error) {
    assertActive(signal);
    if (operation.signal.aborted || Date.now() >= deadlineAt) {
      throw withHistory("Загальний час очікування Gemini вичерпано. Повторіть розпізнавання пізніше.");
    }
    throw error;
  } finally {
    clearTimeout(totalTimeout);
    signal.removeEventListener("abort", cancelOperation);
  }
}
