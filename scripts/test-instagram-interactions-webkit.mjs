#!/usr/bin/env node
// The same combined interaction fixture is exercised by iOS XCTest.
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const adapter = await readFile(process.argv[2] ? resolve(process.argv[2]) : join(root, 'ios/VigilSocial/VigilSocial/DOMAdapters.swift'), 'utf8');
const tests = await readFile(join(root, 'ios/VigilSocial/VigilSocialTests/VigilSocialTests.swift'), 'utf8');
const extract = name => adapter.match(new RegExp(`static let ${name} = #"""([\\s\\S]*?)"""#`))?.[1];
const guard = extract('instagramSingleReelGuard'), stable = extract('instagramStable');
const start = extract('instagramStableDocumentStartStyle');
const html = tests.match(/static let instagramInteractionBoundariesHTML = #"""([\s\S]*?)"""#/)?.[1];
assert.ok(guard && stable && start && html);
for (const source of [guard, stable, start]) assert.doesNotThrow(() => new Function(source));
const bootstrap = `window.__vigilDocumentID='interaction-fixture';window.fixtureLocks=[];
  Object.defineProperty(window,'webkit',{configurable:true,value:{messageHandlers:{vigil:{postMessage:p=>fixtureLocks.push(p)}}}});`;
const modes = ['comments-retained', 'cold-explicit-close-release', 'cold-release', 'cold-remount-release', 'inplace-cold-release', 'inplace-release', 'inplace-anonymous-release', 'recipient-editable', 'recipient-anonymous', 'recipient-unrequested', 'recipient-anonymous-media', 'recipient-anonymous-backdrop', 'recipient-offset', 'comments-offset', 'release', 'anonymous-release', 'link-release', 'moved-preview', 'recipient-animation', 'recipient-nested', 'recipient-backdrop', 'recipient-retained', 'recipient-retired',
  'recipient-reused', 'comments-reused', 'comments-press', 'send-press', 'keyboard-ancestor', 'cancelled-preview', 'ordinary-chat']
  .filter(mode => !process.argv[3] || process.argv[3] === mode);
const scenarios = modes.map(mode => ({name: `Interaction boundary: ${mode}`, html, path: '/direct/t/friend/', steps: [
  {action: `fixtureMode=${JSON.stringify(mode)};fixtureBegin()`, delay: 150, condition: 'fixtureReady()'},
  {condition: 'fixtureVerify()'},
  {action: 'fixtureFinish()', condition: 'fixtureReleased()'}
]}));
if (!process.argv[3] || process.argv[3] === 'draft-text') {
  const draftHTML = `<!doctype html><html><body><main>
    <article id="post"><div>Post by a friend</div>
      <div id="comment" role="textbox" contenteditable="true" aria-label="Add a comment">
        <span>I was </span><span id="comment-word">sponsore</span><span> last year.</span>
      </div>
    </article>
    <article id="ad"><span>Sponsored</span><p>Ad copy</p></article>
    <div id="message-row">
      <div id="message" role="textbox" contenteditable="true" aria-label="Message">
        <span>Ask </span><a id="message-link" href="/friend/">Threds</a>
        <span> about </span><span id="message-phrase">suggested account</span>
      </div>
    </div>
    <a id="threads-promotion" href="https://www.threads.net/">Visit Threads</a>
  </main><script>
    const byId = id => document.getElementById(id);
    const visible = id => byId(id).getClientRects().length > 0;
    function insertDraftLetter(editor, part, offset, letter) {
      byId(editor).focus();
      getSelection().collapse(byId(part).firstChild, offset);
      if (!document.execCommand('insertText', false, letter)) throw new Error('WebKit did not edit the draft');
    }
  </script></body></html>`;
  scenarios.push(
    {name: 'Ad detection preserves inline comment drafts', html: draftHTML, path: '/friend/', steps: [
      {condition: "visible('comment') && !visible('ad')"},
      {action: "insertDraftLetter('comment', 'comment-word', 8, 'd')",
        condition: "byId('comment-word').textContent === 'sponsored'"},
      {action: "byId('post').setAttribute('aria-label', 'Post by a friend')", delay: 500,
        condition: "visible('comment') && document.activeElement === byId('comment') && !visible('ad')"}
    ]},
    {name: 'Suggestion and promotion detection preserves Direct drafts', html: draftHTML, path: '/direct/t/friend/', steps: [
      {condition: "visible('message-link') && !visible('threads-promotion')"},
      {action: "insertDraftLetter('message', 'message-link', 4, 'a')", delay: 500,
        condition: "byId('message-link').textContent === 'Threads' && visible('message-link')"},
      {action: "insertDraftLetter('message', 'message-phrase', 17, 's')", delay: 500,
        condition: "byId('message-phrase').textContent === 'suggested accounts' && !byId('message-phrase').hasAttribute('data-vigil-instagram-suggestions')"},
      {action: "byId('message-row').insertAdjacentHTML('afterbegin', '<button id=open-app>Open App</button>')", delay: 500,
        condition: "visible('message') && document.activeElement === byId('message') && !visible('open-app') && !visible('threads-promotion')"}
    ]}
  );
}
const captionHTML = `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1">
  <style>
    body{margin:0} #rail{margin-top:44px;height:670px;overflow-y:auto}
    #earlier{height:120px} #selected,#other{height:670px;position:relative}
    video{display:block;width:100%;height:550px;background:#222}
    #description{position:absolute;bottom:25px;left:8px;right:54px;color:white;line-height:24px;white-space:pre-line}
    .post #description{top:530px;bottom:auto;color:black}
    #rail a#permalink,#rail a#next{position:absolute;bottom:0}
  </style></head><body>
  <main id="rail">
    <article id="earlier">Profile tiles</article>
    <article id="selected"><video></video>
      <div id="description" data-testid="reel-caption"><span id="copy">The published caption begins here.</span>
        <button id="more" aria-expanded="false">More</button><a id="caption-link" href="/friend/" hidden>@friend</a>
      </div><a id="permalink">Selected permalink</a>
    </article>
    <article id="other"><video></video><a id="next" href="/reel/Other123/">Next reel</a>
      <div data-testid="reel-caption"><button id="unrelated">More</button><span>Other post caption</span></div>
    </article>
  </main>
  <script>
    const rail=document.getElementById('rail'), description=document.getElementById('description');
    const copy=document.getElementById('copy'), more=document.getElementById('more'), link=document.getElementById('caption-link');
    const preview=copy.textContent;
    const longText=preview+'\\n'+'A line of the selected post.\\n'.repeat(80)+'Last line of this caption.';
    let siteMoves=0, expansions=0, linkClicks=0;
    document.addEventListener('touchmove',()=>siteMoves++);
    link.onclick=(event)=>{event.preventDefault();linkClicks++;};
    function showCaption(expanded) {
      copy.textContent=expanded ? longText : preview;
      more.setAttribute('aria-expanded',String(expanded));
      more.textContent=expanded ? 'Less' : 'More';
      link.hidden=!expanded;
      if(expanded) expansions++;
    }
    more.onclick=()=>showCaption(more.getAttribute('aria-expanded')==='false');
    document.getElementById('unrelated').onclick=event=>{
      event.currentTarget.nextElementSibling.textContent=longText;
      event.currentTarget.setAttribute('aria-expanded','true');
    };
    function openPermalink(kind, alreadyExpanded) {
      const path='/channel/'+kind+'/Selected123/';
      document.getElementById('permalink').href=path;
      if(kind==='p') document.body.classList.add('post');
      if(alreadyExpanded) {showCaption(true);more.remove();}
      rail.scrollTop=290;
      history.pushState({},'',path);
      return true;
    }
    function captionScrollsLocally(kind) {
      const original=rail.scrollTop;
      const state=window.__vigilInstagramSharedItem.containmentState().nativeGestureState;
      const box=description.getBoundingClientRect(), railBox=rail.getBoundingClientRect();
      if (!state.locked || state.scrollingRegions.length!==0 || state.activationRegions.length!==1
          || copy.textContent!==longText || expansions!==1 || description.scrollHeight<=description.clientHeight
          || (kind==='reel' && getComputedStyle(description).backgroundColor!=='rgba(0, 0, 0, 0.62)')
          || box.top<railBox.top || box.bottom>railBox.bottom+1 || document.querySelector('dialog, .vigil-instagram-read-caption')) return false;
      for (const [type,y] of [['touchstart',500],['touchmove',300],['touchend',300]]) {
        const event=new Event(type,{bubbles:true,cancelable:true});
        Object.defineProperty(event,'touches',{value:type==='touchend' ? [] : [{identifier:1,clientY:y}]});
        copy.dispatchEvent(event);
      }
      if(description.scrollTop!==200) return false;
      const end=new KeyboardEvent('keydown',{key:'End',bubbles:true,cancelable:true});
      description.dispatchEvent(end);
      const bottom=description.scrollTop;
      const wheel=new WheelEvent('wheel',{deltaY:1000,bubbles:true,cancelable:true});
      copy.dispatchEvent(wheel);
      link.click();
      return end.defaultPrevented && wheel.defaultPrevented && bottom===description.scrollTop
        && Math.abs(bottom-(description.scrollHeight-description.clientHeight))<=1
        && rail.scrollTop===original && siteMoves===0 && linkClicks===1;
    }
  </script></body></html>`;
for (const [kind, alreadyExpanded] of [['p', false], ['p', true], ['reel', false]]) {
  if (process.argv[3] && process.argv[3] !== 'permalink-caption') continue;
  scenarios.push({name: `Inline permalink caption: ${kind}${alreadyExpanded ? ' already expanded' : ''}`, html: captionHTML, path: '/channel/', steps: [
    {action: `openPermalink('${kind}', ${alreadyExpanded})`, condition: 'rail.scrollTop===120 && document.querySelector("#selected").getBoundingClientRect().top===44'},
    {action: 'document.getElementById("unrelated").click();true', condition: '!document.querySelector("#other [data-vigil-instagram-caption-viewport]")'},
    ...(!alreadyExpanded ? [{action: 'more.click();true', condition: 'more.textContent==="Less"'}] : []),
    {condition: `description.dataset.vigilInstagramCaptionViewport==='${kind==='p' ? 'post' : 'reel'}'`},
    {action: `window.captionStayedLocal=captionScrollsLocally('${kind}')`, condition: 'window.captionStayedLocal'},
    ...(!alreadyExpanded ? [{action: 'more.click();true', condition:
      'copy.textContent===preview && !description.hasAttribute("data-vigil-instagram-caption-viewport") && !description.hasAttribute("tabindex") && window.__vigilInstagramSharedItem.containmentState().nativeGestureState.activationRegions.length===0'}] : []),
    {action: `window.backgroundStayedLocked=(() => {
      const wheel=new WheelEvent('wheel',{bubbles:true,cancelable:true,deltaY:500});
      document.querySelector('#selected video').dispatchEvent(wheel);
      history.pushState({},'','/reel/Other123/');
      return wheel.defaultPrevented && rail.scrollTop===120 && location.pathname.includes('Selected123');
    })()`, condition: 'window.backgroundStayedLocked && window.__vigilInstagramSharedItem.containmentState().pinned'},
    {action: 'history.pushState({},"","/channel/");true', condition:
      '!document.querySelector("[data-vigil-instagram-caption-viewport]") && !window.__vigilInstagramSharedItem.containmentState().pinned'}
  ]});
}
assert.ok(scenarios.length);
const directory = await mkdtemp(join(tmpdir(), 'vigil-instagram-interactions-'));
try {
  await Promise.all([writeFile(join(directory, 'guard.js'), bootstrap + start + guard),
    writeFile(join(directory, 'stable.js'), stable), writeFile(join(directory, 'scenarios.json'), JSON.stringify(scenarios))]);
  const executable = join(directory, 'interactions-test');
  await execFileAsync('xcrun', ['swiftc', join(root, 'tests/fixtures/instagram-comments-interaction.swift'), '-o', executable], {timeout: 60000});
  const marker = 'VIGIL_INSTAGRAM_INTERACTIONS_WEBKIT_COMPLETE';
  const result = await execFileAsync(executable, [directory, marker], {timeout: 180000, maxBuffer: 2 * 1024 * 1024});
  process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  assert.ok(result.stdout.split(/\r?\n/).includes(marker), 'Interaction fixture did not complete');
  await rm(directory, {recursive: true, force: true});
} catch (error) {
  if (error.stdout) process.stderr.write(error.stdout);
  if (error.stderr) process.stderr.write(error.stderr);
  process.stderr.write(`Interaction artifacts retained at ${directory}\n`);
  throw error;
}
