const CACHE = 'ashare-strategy-shell-6201b63-20261124-1924'
const PREFIX = 'ashare-strategy-shell-'
self.addEventListener('install', event => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE)
    const response = await fetch('./', { cache: 'no-store' })
    if (!response.ok) throw new Error('Cannot cache app shell')
    const html = await response.clone().text()
    const assets = [...html.matchAll(/(?:src|href)="(\.\/[^"?#]+)"/g)]
      .map(match => match[1]).filter(path => /\.(?:js|css|webmanifest|png)$/.test(path))
    await cache.put('./', response)
    await cache.addAll([...new Set(assets)])
    await self.skipWaiting()
  })())
})
self.addEventListener('activate', event => {
  event.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(key => key.startsWith(PREFIX) && key !== CACHE).map(key => caches.delete(key)))).then(() => self.clients.claim()))
})
self.addEventListener('fetch', event => {
  const request = event.request
  const url = new URL(request.url)
  if (request.method !== 'GET' || url.origin !== self.location.origin) return
  event.respondWith(fetch(request).then(async response => {
    if (response.ok) {
      try { const cache = await caches.open(CACHE); await cache.put(request, response.clone()) } catch { /* network response remains usable */ }
    }
    return response
  }).catch(async () => {
    const cached = await caches.match(request)
    if (cached) return cached
    if (request.mode === 'navigate') return (await caches.match('./')) || Response.error()
    return Response.error()
  }))
})
self.addEventListener('message', event => {
  if (event.data === 'SKIP_WAITING') self.skipWaiting()
})
