const CACHE = 'webserial-crtk-v16';
const NETWORK_TIMEOUT_MS = 3000;
const PRECACHE_URLS = [
    '/',
    '/index.html',
    '/index_advanced.html',
    '/manifest.webmanifest',
    '/static/css/styles.css',
    '/static/css/index-styles.css',
    '/static/css/index-advanced-styles.css',
    '/static/js/script.js',
    '/static/js/index-script.js',
    '/static/js/index-advanced-script.js',
    '/static/js/nmea-map.js',
    '/static/logo.png',
    '/static/natuition-logo.png',
    '/static/navx-logo.png',
    '/static/icons/navx-192.png',
    '/static/icons/navx-512.png',
    '/static/icons/apple-touch-icon.png',
    '/static/icons/navx-favicon.png',
    '/conf_files/usb/manifest.json',
    '/conf_files/usb/NavX_GNSS_Mixed.cfg',
    '/conf_files/usb/NavX_GNSS_Openfield.cfg',
    '/conf_files/usb/NavX_GNSS_Town.cfg',
    '/conf_files/usb/NavX_GNSS_Fast_static_Mixed.cfg',
    '/conf_files/usb/NavX_GNSS_Fast_static_Openfield.cfg',
    '/conf_files/usb/NavX_GNSS_Fast_static_Town.cfg',
    '/conf_files/ble/manifest.json',
    '/conf_files/ble/NavX_GNSS_Mixed.cfg',
    '/conf_files/ble/NavX_GNSS_Openfield.cfg',
    '/conf_files/ble/NavX_GNSS_Town.cfg',
    '/conf_files/ble/NavX_GNSS_Fast_static_Mixed.cfg',
    '/conf_files/ble/NavX_GNSS_Fast_static_Openfield.cfg',
    '/conf_files/ble/NavX_GNSS_Fast_static_Town.cfg'
];

self.addEventListener('install', event => {
    event.waitUntil(
        caches.open(CACHE).then(cache => cache.addAll(PRECACHE_URLS))
    );
    self.skipWaiting();
});

self.addEventListener('activate', event => {
    event.waitUntil(
        caches.keys().then(keys => Promise.all(
            keys.filter(k => k !== CACHE).map(k => caches.delete(k))
        ))
    );
    self.clients.claim();
});

/**
 * Cache key without query string, so cache-busting params (?t=...) still hit the cache
 * and don't fill it with one entry per timestamp.
 */
function cacheKey(req) {
    const url = new URL(req.url);
    url.search = '';
    return url.toString();
}

function fetchWithTimeout(req, timeoutMs) {
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('timeout')), timeoutMs);
        fetch(req).then(resp => { clearTimeout(timer); resolve(resp); },
                        err => { clearTimeout(timer); reject(err); });
    });
}

async function putInCache(req, resp) {
    if (!resp || !resp.ok) return;
    const cache = await caches.open(CACHE);
    await cache.put(cacheKey(req), resp);
}

/**
 * Network first (with timeout for weak field connections), cache as fallback.
 * Used for pages, scripts, styles and configuration files so updates are picked up when online.
 */
async function networkFirst(event) {
    const req = event.request;
    try {
        const resp = await fetchWithTimeout(req, NETWORK_TIMEOUT_MS);
        if (resp.ok) event.waitUntil(putInCache(req, resp.clone()));
        return resp;
    } catch (err) {
        const cached = await caches.match(cacheKey(req));
        if (cached) return cached;
        // Only page navigations fall back to the app shell, never config files
        if (req.mode === 'navigate') {
            const shell = await caches.match('/index.html');
            if (shell) return shell;
        }
        throw err;
    }
}

/**
 * Cache first, network as fallback. Used for images/icons that rarely change.
 */
async function cacheFirst(event) {
    const req = event.request;
    const cached = await caches.match(cacheKey(req));
    if (cached) return cached;
    const resp = await fetch(req);
    if (resp.ok) event.waitUntil(putInCache(req, resp.clone()));
    return resp;
}

self.addEventListener('fetch', event => {
    const req = event.request;
    // Only handle same-origin GET requests
    if (req.method !== 'GET' || new URL(req.url).origin !== location.origin) return;
    // NTRIP corrections: endless live stream, never cached (proxied by nginx)
    if (new URL(req.url).pathname.startsWith('/ntrip/')) return;

    if (req.destination === 'image') {
        event.respondWith(cacheFirst(event));
    } else {
        event.respondWith(networkFirst(event));
    }
});
