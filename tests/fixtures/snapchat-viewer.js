/* global document, window, innerWidth, innerHeight, getComputedStyle */
// Structural additions verified against public Snapchat client 02365173525f5f81a3c6
// and stylesheet eceeacedbecc23dae201 on 2026-11-01. Fictional local media only.
// The old fixture omitted the real growing reaction/reply footer entirely.
const viewerFixtureStyle = document.createElement('style');
viewerFixtureStyle.textContent = `
  :root { --sigBackgroundPrimary: var(--sigMain); }
  .ecBYF { justify-content: space-between; }
  /* The real privacy screens have no stacking priority of their own. */
  .ecBYF > :is(.ejVI4,.eNF_J) { z-index:auto; }
  .P5ZpW { flex:1 0 auto;display:flex;flex-direction:column;align-items:center;justify-content:center;min-height:36px;width:310px;align-self:center;background-color:var(--sigBackgroundPrimary);border-radius:24px 24px 0 0;padding:8px 8px 0 8px; }
  .P5ZpW>.IHkYr { display:flex;align-items:center;justify-content:space-between;margin-block-end:6px; }
  .P5ZpW>.IHkYr>ul { display:flex;list-style:none;padding:0;margin:0; }
  .P5ZpW>.oEzkH { position:relative;flex:content;display:flex;align-items:center;justify-content:space-around;min-height:36px;width:100%;gap:3px; }
  .hgQNs { flex:1;max-width:100%; }
  .UK975 { border:0;border-radius:50%;background-color:var(--sigTextField);padding:0;display:flex;align-items:center;justify-content:center;min-width:36px;height:36px; }
  .eox9R { display:grid;grid-auto-columns:1fr;grid-auto-flow:column;grid-template-areas:"left center center right"; }
  .ROW7N { display:flex;background-color:var(--sigBackgroundPrimary);border-radius:0 0 24px 24px;padding-inline:8px;padding-block-end:8px;max-width:310px;width:fit-content; }
  .vzJg_ { grid-area:center;display:flex;justify-content:center;min-width:0; }
  .Hb2_Z { grid-area:right;display:flex;justify-content:flex-end;align-items:flex-start; }
  .h9IpV { width:36px;height:36px;background:var(--sigTextField); }
  .IHkYr button { width:32px;height:32px;padding:0; }
  .X2xfe { position:absolute;inset-block-end:10px;inset-inline-start:10px; }
  .XtAfH { position:absolute;inset-block-end:10px;inset-inline-end:10px; }
  .hx3W7 { position:absolute;inset-block-start:0;width:100%; }
  .nauoE { height:100%;max-width:100%;position:relative;object-fit:inherit; }
  .nw8Ns { display:flex;align-items:center;justify-content:center;position:relative; }
`;
document.head.appendChild(viewerFixtureStyle);
window.fixtureReached = selector => {
  const node = document.querySelector(selector), r = node.getBoundingClientRect();
  return node.contains(document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2));
};
window.fixtureTap = selector => {
  if (!window.fixtureReached(selector)) throw new Error('Control covered: ' + selector);
  document.querySelector(selector).click();
};
window.fixtureOpenCompleteSnap = (split = 'rows', width = 900, height = 1600, video = false) => {
  window.fixtureOpenSnap(split, width, height);
  const viewer = document.querySelector('.ecBYF');
  viewer.querySelector('.fixture-snap-toolbar').outerHTML = `<div class="eox9R"><div class="vzJg_"><div class="ROW7N"><span>Alex · 3h ago</span></div></div><div class="Hb2_Z"><button class="h9IpV" id="fixture-close-snap" aria-label="Close Snap" onclick="fixtureCloseSnap()">×</button></div></div>`;
  viewer.insertAdjacentHTML('beforeend', `<div class="P5ZpW"><div class="IHkYr"><ul>${['❤️','😂','🔥','👍','👎','😢','🤯','🤔'].map((emoji, i) => `<li><button id="fixture-react-${i}" aria-label="React ${emoji}" onclick="window.fixtureSnapReaction=${i}">${emoji}</button></li>`).join('')}</ul></div><div class="oEzkH"><div class="hgQNs sT7ta"><div class="composer-row"><div id="fixture-snap-reply" class="euyIb" contenteditable="true" role="textbox" aria-label="Reply to Snap"></div><button id="fixture-send-reply" aria-label="Send reply" onclick="window.fixtureSnapReply=document.getElementById('fixture-snap-reply').textContent">➤</button></div></div><button class="UK975" id="fixture-save-snap" aria-label="Save in Chat" onclick="window.fixtureSnapSaved=true">⇩</button></div></div>`);
  const player = viewer.querySelector('.b2f4R');
  if (video) {
    document.getElementById('fixture-snap-image').remove();
    // Mirror the actual video layer and its inline desktop size, not only an img.
    player.insertAdjacentHTML('afterbegin', `<div class="dCE9D nw8Ns" style="width:180px;height:320px"><video class="nauoE" poster="${window.fixtureMediaImage(width, height)}"></video></div>`);
  }
  player.insertAdjacentHTML('beforeend', '<div class="hx3W7">━━━━━━</div><button class="X2xfe" id="fixture-pause-snap" onclick="window.fixtureSnapPaused=true">Ⅱ</button><button class="XtAfH" id="fixture-mute-snap" onclick="window.fixtureSnapMuted=true">♬</button>');
};
window.fixtureViewerFillsPhone = () => {
  const rect = selector => document.querySelector(selector).getBoundingClientRect();
  const viewer = rect('.ecBYF'), player = rect('.b2f4R'), layer = rect('.dCE9D'), footer = rect('.P5ZpW');
  const media = document.querySelector('.dCE9D video') || document.querySelector('.dCE9D');
  return Math.abs(viewer.width - innerWidth) < 1 && Math.abs(viewer.height - innerHeight) < 1
    && Math.abs(player.width - innerWidth) < 1 && Math.abs(player.height - innerHeight) < 1
    && Math.abs(layer.width - innerWidth) < 1 && Math.abs(layer.height - innerHeight) < 1
    && footer.height <= 132 && footer.bottom <= viewer.bottom + 1
    && getComputedStyle(media).objectFit === 'contain'
    && getComputedStyle(document.querySelector('.ChLAv')).display === 'none'
    && document.documentElement.scrollWidth <= innerWidth
    && ['#fixture-close-snap','#fixture-react-0','#fixture-snap-reply','#fixture-send-reply','#fixture-save-snap','#fixture-pause-snap','#fixture-mute-snap'].every(window.fixtureReached);
};
window.fixtureViewerDiagnostic = () => ({
  errors: window.fixtureViewerErrors,
  viewport: [innerWidth, innerHeight],
  rects: Object.fromEntries(['.ecBYF','.RdKti','.b2f4R','.dCE9D','.P5ZpW','.oEzkH'].map(selector =>
    [selector, document.querySelector(selector)?.getBoundingClientRect().toJSON()])),
  unreadOpens: window.fixtureUnreadOpens,
  chatOpens: window.fixtureChatOpens
});
window.fixtureUnreadOpens = 0;
window.fixtureChatOpens = 0;
window.fixtureSeedUnreadRow = (mode = 'snap') => {
  window.fixtureCloseSnap();
  window.closeChat();
  const row = document.querySelector('.O4POs');
  row.onclick = () => { window.fixtureChatOpens++; window.openChat('Alex'); };
  row.querySelector('.LNwMF').onclick = event => { event.stopPropagation(); window.fixtureAvatarOpened = true; };
  const slot = row.querySelector('.w15C2');
  slot.innerHTML = mode === 'chat' ? '<div class="HEkDJ DEp5Z UW13F">Chat</div>'
    : mode === 'unavailable' ? '<div class="HEkDJ DEp5Z DClo3">Snap on mobile</div>'
    : '<div class="HEkDJ DEp5Z DClo3 VKjn5" tabindex="0"><span>□</span></div><span class="giV53">View</span>';
  if (mode !== 'chat' && mode !== 'unavailable') slot.querySelector('.VKjn5').onclick = event => {
    event.stopPropagation(); window.fixtureUnreadOpens++; window.fixtureOpenCompleteSnap('rows', 900, 1600, mode === 'mixed');
    // The real feed View action opens a playlist without navigating into Chat.
    // The older generic fixture helper eagerly mounted a chat behind its snap.
    window.closeChat();
  };
  if (mode === 'hidden') slot.querySelector('.VKjn5').style.display = 'none';
  if (mode === 'restricted') {
    slot.querySelector('.VKjn5').setAttribute('role', 'button');
    slot.querySelector('.VKjn5').setAttribute('aria-label', 'Spotlight');
  }
};
