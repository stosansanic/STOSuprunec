// public/sw.js
// ─────────────────────────────────────────────────────────────────────────────
// Service Worker v4 — offline-first для слюсарів
//
// Стратегії:
//   • Статика (html, js, css, jpg, png, svg, woff) → Cache First (миттєво)
//   • Supabase API → Network First + Cache API fallback + IndexedDB fallback
//   • CDN скрипти (jquery, moment, daterangepicker) → Cache First
//   • Supabase REST mutations (PATCH/POST) → queue via IndexedDB при offline
//   • Все інше → Network Only
// ─────────────────────────────────────────────────────────────────────────────

const CACHE_NAME = 'sto-suprunec-cache-v9';
const CACHE_CDN = 'sto-suprunec-cdn-v9';
const CACHE_API = 'sto-suprunec-api-v3';
const apiClientScopes = new Map();

// Статика яку кешуємо при встановленні
const PRECACHE_ASSETS = [
  './index.html',
  './main.html',
  './planyvannya.html',
  './bukhhalteriya.html',
  './manifest.json',
  './vite.svg',
];

// CDN ресурси які кешуємо при першому завантаженні
const CDN_DOMAINS = [
  'cdn.jsdelivr.net',
  'code.jquery.com',
];

// ── Install: кешуємо критичні ресурси ────────────────────────────────────────
self.addEventListener('install', (event) => {
  self.skipWaiting();
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      // addAll з помилками — не лупімо весь SW якщо один файл недоступний
      return Promise.allSettled(
        PRECACHE_ASSETS.map((url) => cache.add(url).catch(() => { }))
      );
    })
  );
});

// ── Activate: видаляємо старі кеші ───────────────────────────────────────────
self.addEventListener('activate', (event) => {
  event.waitUntil(
    Promise.all([
      clients.claim(),
      caches.keys().then((keys) =>
        Promise.all(
          keys
            .filter((k) => k !== CACHE_NAME && k !== CACHE_CDN && k !== CACHE_API)
            .map((k) => caches.delete(k))
        )
      ),
    ])
  );
});

// ── Fetch: стратегії кешування ────────────────────────────────────────────────
self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);

  // 0) Пропускаємо POST/PATCH/DELETE — мутації обробляються клієнтом через IndexedDB
  if (event.request.method !== 'GET') return;

  // 1) Supabase Realtime → пропускаємо (WebSocket fallback, long-polling)
  if (url.hostname.includes('supabase.co') && url.pathname.includes('/realtime/')) {
    return;
  }

  // 1.1) Supabase Auth → Network Only (не кешуємо токени)
  if (url.hostname.includes('supabase.co') && url.pathname.includes('/auth/')) {
    return;
  }

  // 2) Supabase REST API → Network First + API Cache fallback
  if (url.hostname.includes('supabase.co') && url.pathname.includes('/rest/')) {
    event.respondWith(networkFirstWithApiCache(event.request, event.clientId));
    return;
  }

  // 2.1) Storage/functions may be private; never put them in the shared static cache.
  if (url.hostname.includes('supabase.co')) {
    return;
  }

  // 2) CDN → Cache First (рідко змінюються)
  if (CDN_DOMAINS.some((d) => url.hostname.includes(d))) {
    event.respondWith(cacheFirst(event.request, CACHE_CDN));
    return;
  }

  // 3) HTML сторінки → Network First (завжди свіжий контент)
  if ((event.request.mode === 'navigate' || /\.html$/i.test(url.pathname)) && url.origin === self.location.origin) {
    event.respondWith(networkFirst(event.request));
    return;
  }

  // 3.1) Manifest → Network First, щоб браузер бачив актуальні PWA-параметри.
  if (/\/manifest\.json$/i.test(url.pathname) && url.origin === self.location.origin) {
    event.respondWith(networkFirstManifest(event.request));
    return;
  }

  // 4) Статичні assets (JS, CSS, images) → Cache First (мають хеші у назвах)
  const isStaticAsset = /\.(js|css|jpg|jpeg|png|svg|woff2?|ico|json)$/i.test(url.pathname);
  if (isStaticAsset && url.origin === self.location.origin) {
    event.respondWith(cacheFirst(event.request, CACHE_NAME));
    return;
  }

  // 5) Все інше → просто fetch (не кешуємо)
});

// ── Стратегія: Cache First ────────────────────────────────────────────────────
async function cacheFirst(request, cacheName) {
  const cache = await caches.open(cacheName);
  const cached = await cache.match(request);
  if (cached && validStaticResponse(request, cached)) return cached;
  if (cached) await cache.delete(request);

  try {
    const response = await fetch(request);
    if (response.ok && validStaticResponse(request, response)) {
      cache.put(request, response.clone());
    }
    return response;
  } catch {
    return new Response('Офлайн: ресурс недоступний', { status: 503 });
  }
}

// A missing deployment chunk can return the HTML fallback. Never cache it as code.
function validStaticResponse(request, response) {
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return true;
  const type = (response.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
  if (/\.m?js$/i.test(url.pathname)) {
    return ['application/javascript', 'text/javascript', 'application/ecmascript', 'text/ecmascript'].includes(type);
  }
  if (/\.css$/i.test(url.pathname)) return type === 'text/css';
  return true;
}

// ── Стратегія: Network First ──────────────────────────────────────────────────
// Keep an actual, successfully downloaded manifest for transient network errors.
// The general networkFirst strategy does not populate the cache on success.
async function networkFirstManifest(request) {
  const cache = await caches.open(CACHE_NAME);
  let response;
  try {
    response = await fetch(request);
    if (response.ok) {
      try { await cache.put(request, response.clone()); } catch { /* cache quota */ }
      return response;
    }
  } catch { /* offline: use a previously downloaded manifest */ }
  const cached = await cache.match(request);
  return cached || response || new Response('Manifest unavailable offline', { status: 503 });
}

async function networkFirst(request) {
  try {
    const response = await fetch(request);
    return response;
  } catch {
    // Мережа недоступна — повертаємо кеш якщо є
    const cached = await caches.match(request);
    if (cached) return cached;
    return new Response(JSON.stringify({ error: 'offline' }), {
      status: 503,
      headers: { 'Content-Type': 'application/json' },
    });
  }
}

// ── Стратегія: Network First + API Cache ──────────────────────────────────────
// Supabase REST відповіді кешуються окремо для offline-доступу слюсарів
async function networkFirstWithApiCache(request, clientId) {
  const employeeScope = apiClientScopes.get(clientId);
  if (!employeeScope || request.cache === 'no-store') {
    try { return await fetch(request); }
    catch { return new Response(JSON.stringify({ error: 'offline_cache_miss' }), {
      status: 503, headers: { 'Content-Type': 'application/json', 'X-Offline-Fallback': 'true' },
    }); }
  }
  const cache = await caches.open(CACHE_API);
  // Cache API normally keys by URL, not Authorization or Range. Never reuse a
  // response belonging to another login or another page of the same query.
  const scope = ['authorization', 'apikey', 'range', 'range-unit', 'accept', 'accept-profile']
    .map(name => request.headers.get(name) || '').concat(employeeScope).join('\n');
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(scope));
  const keyUrl = new URL(request.url);
  keyUrl.searchParams.set('__sto_cache_scope', Array.from(new Uint8Array(digest), b => b.toString(16).padStart(2, '0')).join(''));
  const cacheKey = new Request(keyUrl.toString(), { method: 'GET' });

  try {
    const response = await fetch(request);

    // Кешуємо тільки успішні GET-відповіді до основних таблиць
    // Range requests may return 206, which Cache API refuses to store.
    // Cache only complete successful responses and never let cache failures
    // turn a successful API response into an unhandled rejection.
    if (response.status === 200 && apiClientScopes.get(clientId) === employeeScope) {
      const url = new URL(request.url);
      const tablesToCache = ['acts', 'clients', 'cars', 'works', 'details', 'slyusars', 'settings'];
      const shouldCache = tablesToCache.some((t) => url.pathname.includes(`/${t}`));
      if (shouldCache) {
        try {
          const headers = new Headers(response.headers);
          headers.set('X-Sto-Cached-At', new Date().toISOString());
          await cache.put(cacheKey, new Response(response.clone().body, { status: response.status, headers }));
        } catch {
          // Cache quota or unsupported response: return the network response.
        }
      }
    }

    return response;
  } catch {
    // Мережа недоступна — шукаємо в API-кеші
    const cached = apiClientScopes.get(clientId) === employeeScope ? await cache.match(cacheKey) : null;
    if (cached) {
      const headers = new Headers(cached.headers);
      headers.set('X-Offline-Fallback', 'true');
      return new Response(cached.body, { status: cached.status, headers });
    }

    // A network failure is not a successful empty database snapshot.
    return new Response(JSON.stringify({ error: 'offline_cache_miss' }), {
      status: 503,
      headers: {
        'Content-Type': 'application/json',
        'X-Offline-Fallback': 'true',
      },
    });
  }
}

// ── Message handler: клієнт повідомляє SW про sync-ready ─────────────────────
self.addEventListener('message', (event) => {
  if (event.data?.type === 'STO_API_SCOPE' && event.source?.id && /^[a-f0-9]{64}$/.test(event.data.scope)) {
    apiClientScopes.set(event.source.id, event.data.scope);
    while (apiClientScopes.size > 256) apiClientScopes.delete(apiClientScopes.keys().next().value);
    event.ports?.[0]?.postMessage({ scope: event.data.scope });
    return;
  }
  if (event.data && event.data.type === 'SKIP_WAITING') {
    self.skipWaiting();
  }
});
