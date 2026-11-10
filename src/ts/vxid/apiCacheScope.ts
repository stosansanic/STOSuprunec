// The internal employee may change without changing the shared Supabase JWT.
// Only a digest goes to the worker; credentials never enter a cache URL.
let lastRaw: string | undefined;
let lastDigest: Promise<string> | undefined;
function actor(): string {
  try { return localStorage.getItem("userAuthData") || ""; } catch { return ""; }
}
async function workerScope(raw: string): Promise<boolean> {
  const worker = typeof navigator !== "undefined" ? navigator.serviceWorker?.controller : null;
  if (!worker || !raw) return false;
  if (lastRaw !== raw || !lastDigest) {
    lastRaw = raw;
    lastDigest = crypto.subtle.digest("SHA-256", new TextEncoder().encode(raw))
      .then(buffer => Array.from(new Uint8Array(buffer), b => b.toString(16).padStart(2, "0")).join(""));
  }
  const scope = await lastDigest;
  if (actor() !== raw) throw new Error("Користувач змінився під час запиту");
  return new Promise(resolve => {
    const channel = new MessageChannel();
    const finish = (ok: boolean) => { clearTimeout(timer); channel.port1.close(); channel.port2.close(); resolve(ok); };
    const timer = setTimeout(() => finish(false), 1000);
    channel.port1.onmessage = event => finish(event.data?.scope === scope);
    try { worker.postMessage({ type: "STO_API_SCOPE", scope }, [channel.port2]); }
    catch { finish(false); }
  });
}

export async function scopedSupabaseFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const raw = actor();
  const method = init?.method || (input instanceof Request ? input.method : "GET");
  const url = input instanceof Request ? input.url : String(input);
  if (method.toUpperCase() !== "GET" || !new URL(url).pathname.startsWith("/rest/")) return fetch(input, init);
  const synced = await workerScope(raw);
  if (actor() !== raw) throw new Error("Користувач змінився під час запиту");
  // Old/missing worker or missing actor: network is allowed, private cache is not.
  const response = await fetch(input, synced ? init : { ...init, cache: "no-store" });
  if (actor() !== raw) throw new Error("Користувач змінився під час запиту");
  return response;
}
