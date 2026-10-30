/* global self */
'use strict';
const services = new Set(['instagram', 'youtube', 'snapchat', 'linkedin', 'facebook', 'x', 'tiktok', 'reddit']);
self.addEventListener('push', event => {
  // The relay filters before pushing. Always display received pushes: Safari
  // revokes permission for invisible pushes. Never display private source text.
  event.waitUntil((async () => {
    let data; try { data = event.data?.json(); } catch {}
    const service = services.has(data?.service) ? data.service : null;
    const names = {instagram:'Instagram',youtube:'YouTube',snapchat:'Snapchat',linkedin:'LinkedIn',facebook:'Facebook',x:'X',tiktok:'TikTok',reddit:'Reddit'};
    const kind = ['message', 'call', 'activity'].includes(data?.kind) ? data.kind : 'activity';
    await self.registration.showNotification(service ? names[service] : 'Vigil', {
      body: kind === 'call' ? 'Incoming call.' : kind === 'message' ? 'New message.' : 'New activity.',
      data: {service}, tag: service ? 'vigil-' + service + '-' + kind : 'vigil-alert'
    });
  })());
});
self.addEventListener('notificationclick', event => {
  event.notification.close();
  const service = event.notification.data?.service;
  const destination = new URL('/notifications/', self.location.origin);
  if (services.has(service)) destination.searchParams.set('open', service);
  event.waitUntil(self.clients.openWindow(destination.href));
});
