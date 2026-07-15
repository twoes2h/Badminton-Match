const STATIC_CACHE = 'badminton-static-20260715b';
const AVATAR_CACHE = 'badminton-avatars-20260715a';
const AVATAR_MAX_ENTRIES = 80;
const AVATAR_MAX_AGE_MS = 14 * 24 * 60 * 60 * 1000;
const AVATAR_MAX_CACHE_BYTES = 5 * 1024 * 1024;

const STATIC_ASSETS = [
  '/',
  '/index.html',
  '/login.html',
  '/rooms.html',
  '/room.html',
  '/profile.html',
  '/admin.html',
  '/mobile.css',
  '/common.js',
  '/index.js',
  '/login.js',
  '/rooms.js',
  '/room.js',
  '/profile.js',
  '/admin.js'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(STATIC_CACHE)
      .then((cache) => cache.addAll(STATIC_ASSETS))
      .catch(() => {})
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const cacheNames = await caches.keys();
    await Promise.all(cacheNames
      .filter((name) => name.startsWith('badminton-') && ![STATIC_CACHE, AVATAR_CACHE].includes(name))
      .map((name) => caches.delete(name)));
    const avatarCache = await caches.open(AVATAR_CACHE);
    await trimAvatarCache(avatarCache);
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  if (url.pathname.startsWith('/api/')) return;

  if (url.pathname.startsWith('/uploads/avatars/')) {
    event.respondWith(cacheAvatar(request));
    return;
  }

  if (isStaticAsset(url.pathname)) {
    event.respondWith(staleWhileRevalidate(request));
  }
});

function isStaticAsset(pathname) {
  return STATIC_ASSETS.includes(pathname)
    || /\.(?:css|js|html)$/.test(pathname);
}

async function staleWhileRevalidate(request) {
  const cache = await caches.open(STATIC_CACHE);
  const cached = await cache.match(request);
  const network = fetch(request)
    .then((response) => {
      if (response && response.ok) {
        cache.put(request, response.clone()).catch(() => {});
      }
      return response;
    })
    .catch(() => cached);
  return cached || network;
}

async function cacheAvatar(request) {
  const cache = await caches.open(AVATAR_CACHE);
  const cached = await cache.match(request);
  if (cached && !isAvatarExpired(cached)) {
    refreshAvatarTimestamp(cache, request, cached.clone()).catch(() => {});
    trimAvatarCache(cache).catch(() => {});
    return cached;
  }

  try {
    const response = await fetch(request);
    if (response && response.ok) {
      await putAvatar(cache, request, response.clone());
      trimAvatarCache(cache).catch(() => {});
    }
    return response;
  } catch (error) {
    if (cached) return cached;
    throw error;
  }
}

function isAvatarExpired(response) {
  const cachedAt = Number(response.headers.get('x-badminton-cache-time') || 0);
  return !cachedAt || Date.now() - cachedAt > AVATAR_MAX_AGE_MS;
}

async function putAvatar(cache, request, response) {
  const contentType = response.headers.get('content-type') || '';
  if (!contentType.startsWith('image/')) return;

  const contentLength = Number(response.headers.get('content-length') || 0);
  if (contentLength > AVATAR_MAX_CACHE_BYTES) return;

  const blob = await response.blob();
  if (blob.size > AVATAR_MAX_CACHE_BYTES) return;

  await cache.put(request, responseWithCacheTime(response, blob));
}

async function refreshAvatarTimestamp(cache, request, response) {
  const blob = await response.blob();
  await cache.put(request, responseWithCacheTime(response, blob));
}

function responseWithCacheTime(response, body) {
  const headers = new Headers(response.headers);
  headers.set('x-badminton-cache-time', String(Date.now()));
  return new Response(body, {
    status: response.status,
    statusText: response.statusText,
    headers
  });
}

async function trimAvatarCache(cache) {
  const requests = await cache.keys();
  const now = Date.now();
  const liveEntries = [];

  for (const request of requests) {
    const response = await cache.match(request);
    const cachedAt = Number(response && response.headers.get('x-badminton-cache-time') || 0);
    if (!cachedAt || now - cachedAt > AVATAR_MAX_AGE_MS) {
      await cache.delete(request);
    } else {
      liveEntries.push({ request, cachedAt });
    }
  }

  liveEntries.sort((a, b) => a.cachedAt - b.cachedAt);
  while (liveEntries.length > AVATAR_MAX_ENTRIES) {
    const entry = liveEntries.shift();
    await cache.delete(entry.request);
  }
}
