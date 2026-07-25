const CACHE_NAME = 'dashboard-v2';
const ASSETS = ['./index.html', './manifest.json', './dash-icon.svg'];

self.addEventListener('install', function(event){
  event.waitUntil(
    caches.open(CACHE_NAME).then(function(cache){
      return cache.addAll(ASSETS);
    })
  );
  self.skipWaiting();
});

self.addEventListener('activate', function(event){
  event.waitUntil(
    caches.keys().then(function(keys){
      return Promise.all(
        keys.filter(function(k){ return k !== CACHE_NAME; })
            .map(function(k){ return caches.delete(k); })
      );
    })
  );
  self.clients.claim();
});

self.addEventListener('fetch', function(event){
  if (event.request.method !== 'GET') return;
  event.respondWith(
    caches.match(event.request).then(function(cached){
      return cached || fetch(event.request).catch(function(){
        return caches.match('./index.html');
      });
    })
  );
});

// Planlagte påmindelser fra dashboardet (SCHEDULE_NOTIFICATION-beskeder).
// setTimeout i en service worker overlever ikke at browseren lukker helt,
// men på mobil (PWA) holder den typisk længe nok til "kl. 7 i morgen"-
// påmindelser når appen har været åben samme dag.
self.addEventListener('message', function(event){
  const data = event.data;
  if (!data || data.type !== 'SCHEDULE_NOTIFICATION') return;
  const title = data.title || 'Træning';
  const body = data.body || '';
  const delayMs = Math.max(0, data.delayMs || 0);
  setTimeout(function(){
    self.registration.showNotification(title, {
      body: body,
      icon: './dash-icon.svg',
      badge: './dash-icon.svg',
      tag: 'traening-reminder'
    });
  }, delayMs);
});

self.addEventListener('notificationclick', function(event){
  event.notification.close();
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(function(list){
      for (const client of list) {
        if ('focus' in client) return client.focus();
      }
      return self.clients.openWindow('./index.html');
    })
  );
});
