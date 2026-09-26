'use strict';
const origins = ['https://youtube.com/*', 'https://www.youtube.com/*', 'https://m.youtube.com/*'];
const statusLine = document.getElementById('status');
const details = document.getElementById('details');
const allow = document.getElementById('allow');
const timeout = promise => {
  let timer;
  return Promise.race([promise, new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error('The check timed out.')), 6500);
  })]).finally(() => clearTimeout(timer));
};
async function check() {
  statusLine.textContent = 'Checking this page…';
  details.textContent = '';
  try {
    const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
    await prepareHandoff(tab);
    const granted = await browser.permissions.contains({ origins });
    allow.hidden = granted;
    if (!granted) {
      statusLine.textContent = 'YouTube website access needs permission.';
      details.textContent = 'The extension can be on while website access is still missing. Shorts blocking uses separate Safari rules.';
      return;
    }
    if (!tab?.url || !/^https:\/\/(www\.|m\.)?youtube\.com\//.test(tab.url)) {
      statusLine.textContent = 'Open a YouTube page to check its limiter.';
      return;
    }
    let health;
    try { health = await timeout(browser.tabs.sendMessage(tab.id, { type: 'VIGIL_YOUTUBE_HEALTH' }, { frameId: 0 })); }
    catch { /* A missing content-script receiver is a diagnostic result. */ }
    if (!health?.loaded) {
      statusLine.textContent = 'The limiter has not started on this page.';
      details.textContent = 'Website access is granted, but the page has no limiter response. Reload the page and check again.';
      return;
    }
    statusLine.textContent = health.allowanceLoaded ? 'The limiter is running.' : 'The limiter loaded, but its allowance is unavailable.';
    details.textContent = health.allowanceLoaded ? 'The page script has received its allowance. Shorts blocking is checked separately.' : 'This is a connection or allowance-engine failure, not an extension toggle issue.';
  } catch (error) {
    statusLine.textContent = 'Vigil could not finish the check.';
    details.textContent = error.message;
  }
}
allow.addEventListener('click', () => {
  // Safari requires the permission request to originate directly from a gesture.
  browser.permissions.request({ origins }).then(async granted => {
    if (!granted) { statusLine.textContent = 'YouTube access was not granted.'; return; }
    const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
    if (tab?.id && /^https:\/\/(www\.|m\.)?youtube\.com\//.test(tab.url || '')) await browser.tabs.reload(tab.id);
    await check();
  }).catch(error => { statusLine.textContent = error.message; });
});
document.getElementById('check').addEventListener('click', check);
void check();

async function prepareHandoff(tab) {
  const open = document.getElementById('open-vigil');
  open.hidden = true;
  open.style.display = 'none';
  // The desktop extension uses the same resources, but has no Social app.
  if (!/iPhone|iPad|iPod/.test(navigator.userAgent) && !(navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1)) return;
  if (!tab?.url) return;
  const url = new URL(tab.url);
  if (url.protocol !== 'https:' || url.username || url.password || (url.port && url.port !== '443')) return;
  const host = url.hostname;
  const youtube = /^(www\.|m\.)?youtube\.com$/.test(host) || host === 'youtu.be';
  if (!youtube && !/^(www\.)?(instagram|linkedin)\.com$/.test(host)
      && !/^(www\.|web\.)?snapchat\.com$/.test(host)) return;
  if ((youtube && /^\/shorts(?:\/|$)/i.test(url.pathname))
      || (/snapchat\.com$/.test(host) && /^\/(spotlight|discover)(?:\/|$)/i.test(url.pathname))
      || (/linkedin\.com$/.test(host) && /^\/(video|shorts|feed\/(video|immersive))(?:\/|$)/i.test(url.pathname))) return;
  const handoff = new URL('vigilsocial://open');
  handoff.searchParams.set('url', url.href);
  if (youtube) {
    const key = `youtube-handoff:${tab.id}`;
    const record = (await browser.storage.local.get(key))[key];
    const parts = url.pathname.split('/').filter(Boolean);
    const id = host === 'youtu.be' ? parts[0] : url.searchParams.get('v') || (['live', 'embed'].includes(parts[0]) ? parts[1] : null);
    // Browser-discovered recommendations retain the normal save requirement.
    if (!id || record?.id !== id || !record?.eligible) handoff.searchParams.set('source', 'discovery');
  }
  open.href = handoff.href;
  open.hidden = false;
  open.style.display = 'block';
}
