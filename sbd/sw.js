const CACHE_NAME = 'sbd-tracker-v4';
const ASSETS = ['./index.html', './manifest.json', './icon-192.png', './icon-512.png'];

self.addEventListener('install', function(event){
  event.waitUntil(
    caches.open(CACHE_NAME).then(function(cache){
      return cache.addAll(ASSETS);
    }).catch(function(){})
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
  // Netværk først (så opdateringer slår igennem), cache som offline-fallback
  event.respondWith(
    fetch(event.request).then(function(res){
      const copy = res.clone();
      caches.open(CACHE_NAME).then(function(cache){ cache.put(event.request, copy); });
      return res;
    }).catch(function(){
      return caches.match(event.request).then(function(cached){
        return cached || caches.match('./index.html');
      });
    })
  );
});

// ── Pause-timer-notifikationer ─────────────────────────────────────────────
// Appen planlægger push 30 sek før og ved pausens afslutning, med id-baseret
// annullering: forlænger/skipper man pausen, sendes CANCEL_NOTIFICATION og
// derefter evt. en ny SCHEDULE_NOTIFICATION med samme id.
const _timers = {};

self.addEventListener('message', function(event){
  const data = event.data;
  if (!data) return;

  if (data.type === 'SCHEDULE_NOTIFICATION') {
    const id = data.id || 'default';
    if (_timers[id]) clearTimeout(_timers[id]);
    _timers[id] = setTimeout(function(){
      delete _timers[id];
      self.registration.showNotification(data.title || 'SBD', {
        body: data.body || '',
        icon: './icon-192.png',
        badge: './icon-192.png',
        tag: data.tag || ('sbd-' + id),
        renotify: true,
        data: { url: './index.html' },
      });
    }, Math.max(0, data.delayMs || 0));
  }

  if (data.type === 'CANCEL_NOTIFICATION') {
    const id = data.id || 'default';
    if (_timers[id]) { clearTimeout(_timers[id]); delete _timers[id]; }
    // Fjern også en evt. allerede vist notifikation med samme tag
    self.registration.getNotifications({ tag: 'sbd-' + id }).then(function(list){
      list.forEach(function(n){ n.close(); });
    }).catch(function(){});
  }
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
