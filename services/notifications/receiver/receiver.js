/* global document, indexedDB, location, matchMedia */
'use strict';
const services = {instagram:'Instagram',youtube:'YouTube',snapchat:'Snapchat',linkedin:'LinkedIn',facebook:'Facebook',x:'X',tiktok:'TikTok',reddit:'Reddit'};
const byId = id => document.getElementById(id);
let registration, publicKey, saved;
const database = new Promise((resolve, reject) => {
  const request = indexedDB.open('vigil-alert-receiver', 1);
  request.onupgradeneeded = () => request.result.createObjectStore('settings');
  request.onsuccess = () => resolve(request.result);
  request.onerror = () => reject(new Error('Private receiver storage is unavailable.'));
});
async function storage(value, writing = false) {
  const db = await database;
  return new Promise((resolve, reject) => {
    const transaction = db.transaction('settings', writing ? 'readwrite' : 'readonly');
    const store = transaction.objectStore('settings');
    const request = writing ? (value ? store.put(value, 'device') : store.delete('device')) : store.get('device');
    transaction.oncomplete = () => resolve(writing ? value : request.result);
    transaction.onerror = () => reject(new Error('Could not save receiver settings.'));
  });
}
async function api(path, credential, method, body) {
  const response = await fetch('/api/notifications/devices' + path, {method, credentials:'omit', cache:'no-store', redirect:'error',
    headers:{'Content-Type':'application/json',Authorization:'Bearer ' + credential}, ...(body ? {body:JSON.stringify(body)} : {})});
  if (!response.ok) throw new Error('The notification service did not confirm your settings.');
  return response.json();
}
function keyBytes(value) {
  return Uint8Array.from(atob(value.replace(/-/g,'+').replace(/_/g,'/')), char => char.charCodeAt(0));
}
function selected() { return Object.keys(services).filter(service => byId('service-' + service).checked); }
byId('settings').addEventListener('submit', async event => {
  event.preventDefault();
  const credential = saved?.secret ?? byId('pair').value.trim();
  if (!/^[a-f0-9]{64}$/.test(credential)) { byId('status').textContent = 'Enter your private pairing code.'; return; }
  // Call subscribe directly from the user gesture, after registration is ready.
  byId('connect').disabled = true;
  try {
    const subscription = await registration.pushManager.subscribe({userVisibleOnly:true,applicationServerKey:keyBytes(publicKey)});
    const choices = selected();
    const reply = await api(saved ? '/' + saved.deviceID : '', credential, saved ? 'PUT' : 'POST', {subscription:subscription.toJSON(),services:choices});
    const next = saved ? {...saved,services:choices} : {...reply,services:choices};
    if (!/^[a-f0-9]{32}$/.test(next.deviceID) || !/^[a-f0-9]{64}$/.test(next.secret)) throw new Error('Invalid registration reply.');
    await storage(next, true); saved = next;
    byId('pair').value = ''; byId('pair-label').hidden = true;
    byId('disconnect').hidden = false; byId('connect').textContent = 'Save notification choices';
    byId('status').textContent = 'Receiver connected. Incoming social event sources still need verification.';
  } catch (error) { byId('status').textContent = error.message; }
  finally { byId('connect').disabled = false; }
});
byId('disconnect').addEventListener('click', async () => {
  if (!saved) return;
  try {
    await api('/' + saved.deviceID, saved.secret, 'DELETE');
    const subscription = await registration.pushManager.getSubscription();
    if (subscription) await subscription.unsubscribe();
    await storage(null, true); location.reload();
  } catch (error) { byId('status').textContent = error.message; }
});
(async () => {
  try {
    const standalone = matchMedia('(display-mode: standalone)').matches || navigator.standalone;
    if (!standalone) { byId('status').textContent = 'Open this receiver from your Home Screen to connect.'; return; }
    byId('install').hidden = true;
    if (!('serviceWorker' in navigator) || typeof PushManager === 'undefined') throw new Error('Web Push is unavailable in this browser.');
    saved = await storage();
    const response = await fetch('config', {cache:'no-store',redirect:'error'});
    const config = await response.json(); publicKey = config.publicKey;
    if (typeof publicKey !== 'string' || !/^[A-Za-z0-9_-]{87}$/.test(publicKey)) throw new Error('The notification service has not configured Web Push.');
    registration = await navigator.serviceWorker.register('worker.js', {scope:'/notifications/'});
    await navigator.serviceWorker.ready;
    for (const [service, name] of Object.entries(services)) {
      const label = document.createElement('label'), input = document.createElement('input');
      input.type = 'checkbox'; input.id = 'service-' + service;
      input.checked = (saved?.services ?? ['instagram','snapchat']).includes(service);
      label.append(input, document.createTextNode(name)); byId('services').append(label);
    }
    byId('pair-label').hidden = Boolean(saved); byId('disconnect').hidden = !saved;
    byId('connect').textContent = saved ? 'Save notification choices' : 'Connect notifications';
    byId('connect').disabled = false;
    byId('status').textContent = saved ? 'Receiver registered. Delivery still depends on verified social event sources.' : 'Enter your private pairing code to connect.';
  } catch (error) { byId('status').textContent = error.message; }
})();
const openService = new URL(location.href).searchParams.get('open');
if (Object.hasOwn(services, openService)) {
  byId('open').hidden = false; byId('open').href = 'vigilsocial://' + openService;
  byId('open').textContent = 'Open ' + services[openService] + ' in Vigil';
}
