// Keeps the HUD's files on the device showing it, so opening the HUD doesn't pull the ~25 MB car
// model and three.js over Wi-Fi every time: the WebView's HTTP cache is too small to hold the model,
// so without this it's downloaded on every start.
//
// Each file is still checked with the comma on every load -- a conditional request (If-None-Match)
// that the server answers with a tiny 304 while the file hasn't changed -- so an update shows up on
// the next load. If the comma doesn't answer within CHECK_TIMEOUT_MS the cached copy is used as is.
// API calls and the WebSocket pass straight through. Needs a secure context: the Android app's
// http://127.0.0.1 page is one, http://sunnypilot.local in a browser isn't (it keeps the HTTP cache).
const CACHE = 'webhud-v1';
const CHECK_TIMEOUT_MS = 2500;
const MODELS_KEPT = 3;   // car models kept; a renamed model replaces the oldest

self.addEventListener('install', () => self.skipWaiting());

self.addEventListener('activate', (event) => event.waitUntil((async () => {
  for (const name of await caches.keys()) if (name !== CACHE) await caches.delete(name);
  await self.clients.claim();
})()));

self.addEventListener('fetch', (event) => {
  const req = event.request;
  const url = new URL(req.url);
  if (req.method !== 'GET' || url.origin !== self.location.origin || url.pathname.startsWith('/api/') || url.pathname === '/ws') return;
  event.respondWith(serve(event, req, url));
});

async function serve(event, req, url) {
  // every page URL is the app shell (the server falls back to it), so keep one copy of it
  const key = req.mode === 'navigate' ? '/' : url.pathname + url.search;
  const cache = await caches.open(CACHE);
  const cached = await cache.match(key);
  const etag = cached && cached.headers.get('ETag');
  const abort = new AbortController();
  // only the wait for the answer is bounded: a changed file then streams in full
  const timer = cached ? setTimeout(() => abort.abort(), CHECK_TIMEOUT_MS) : null;
  let res;
  try {
    res = await fetch(key, { headers: etag ? { 'If-None-Match': etag } : {}, cache: 'no-store', signal: abort.signal });
  } catch (e) {
    if (cached) return cached;
    throw e;
  } finally {
    clearTimeout(timer);
  }
  if (res.status === 304 && cached) return cached;
  if (res.ok && res.headers.get('ETag')) event.waitUntil(store(cache, key, res.clone()));
  else if (!res.ok && cached) return cached;
  return res;
}

async function store(cache, key, res) {
  await cache.put(key, res);
  if (!key.startsWith('/models/')) return;
  const models = [];
  for (const req of await cache.keys()) {
    const path = new URL(req.url).pathname;
    if (!path.startsWith('/models/') || path === key) continue;
    const r = await cache.match(req);
    models.push({ req, date: Date.parse(r && r.headers.get('Date')) || 0 });
  }
  models.sort((a, b) => b.date - a.date);
  for (const m of models.slice(MODELS_KEPT - 1)) await cache.delete(m.req);
}
