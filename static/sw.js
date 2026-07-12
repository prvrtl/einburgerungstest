// VERSION is substituted server-side with a hash of the SHELL assets — the
// new SW install is what surfaces the in-app update toast.
const VERSION = '__VERSION__';
const SHELL = [
  '/',
  '/styles.css',
  '/js/boot.js',
  '/js/main.js',
  '/js/dom.js',
  '/js/api.js',
  '/js/store.js',
  '/js/srs.js',
  '/js/sfx.js',
  '/js/readiness.js',
  '/js/theme.js',
  '/js/util.js',
  '/js/i18n.js',
  '/js/components/QuestionCard.js',
  '/js/components/Filters.js',
  '/js/components/Mastery.js',
  '/js/components/Practice.js',
  '/js/components/Exam.js',
  '/js/components/Review.js',
  '/js/components/Progress.js',
  '/js/components/ErrorBoundary.js',
  '/vocab.json',
  '/vendor/react.production.min.js',
  '/vendor/react-dom.production.min.js',
  '/vendor/htm.min.js',
  '/manifest.webmanifest',
  '/icons/icon-192.png',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(VERSION).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin) return;

  if (url.pathname === '/api/questions') {
    e.respondWith(
      fetch(e.request)
        .then((res) => {
          if (res.ok) {
            const copy = res.clone();
            caches.open(VERSION).then((c) => c.put('/api/questions', copy));
          }
          return res;
        })
        .catch(() => caches.match('/api/questions'))
    );
    return;
  }
  if (url.pathname.startsWith('/api/')) return;

  e.respondWith(
    caches.match(e.request.mode === 'navigate' ? '/' : e.request).then((cached) => {
      const fetched = fetch(e.request)
        .then((res) => {
          if (res.ok) {
            const copy = res.clone();
            caches.open(VERSION).then((c) => c.put(e.request.mode === 'navigate' ? '/' : e.request, copy));
          }
          return res;
        })
        .catch(() => cached);
      return cached || fetched;
    })
  );
});

self.addEventListener('push', (e) => {
  let data = {};
  try { data = e.data ? e.data.json() : {}; } catch (err) {}
  e.waitUntil(self.registration.showNotification(data.title || 'Einbürgerungstest Trainer', {
    body: data.body || '',
    icon: '/icons/icon-192.png',
    badge: '/icons/icon-192.png',
  }));
});

self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  e.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then((list) => {
      for (const c of list) if ('focus' in c) return c.focus();
      return clients.openWindow('/');
    })
  );
});
