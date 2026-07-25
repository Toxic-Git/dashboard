const CACHE_NAME = 'lobe-tracker-v2';
const ASSETS = ['./index.html', './manifest.json'];

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