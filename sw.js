// オフライン対応: ネット優先、つながらなければキャッシュを使う
// （更新がすぐ反映されるよう、キャッシュ優先にはしていない）
const CACHE = 'flash-reader-v3';
const ASSETS = [
  './',
  'index.html',
  'style.css',
  'js/app.js',
  'js/chunker.js',
  'js/store.js',
  'lib/budoux/parser.js',
  'lib/budoux/ja.js',
  'manifest.webmanifest',
  'icons/icon.svg',
  'icons/icon-180.png',
  'icons/icon-192.png',
  'icons/icon-512.png',
  'samples/index.json',
  'samples/uchu.txt',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(ASSETS)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET' || new URL(req.url).origin !== location.origin) return;
  e.respondWith(
    fetch(req)
      .then((res) => {
        if (res.ok) {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(req, copy));
        }
        return res;
      })
      .catch(() =>
        caches.match(req, { ignoreSearch: true }).then((hit) => hit || caches.match('index.html')),
      ),
  );
});
