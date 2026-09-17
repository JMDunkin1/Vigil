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
