import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const __dirname = dirname(fileURLToPath(import.meta.url));
const EXT_DIR = resolve(__dirname, '..');

function createHarnessDom({ pathname = '/home', storageData = {}, onMessage = null } = {}) {
  class MockClassList {
    constructor(el) {
      this._el = el;
      this._set = new Set();
    }
    _syncFromString(str) {
      this._set = new Set(String(str || '').split(/\s+/).filter(Boolean));
    }
    _syncToAttr() {
      const val = Array.from(this._set).join(' ');
      if (val) this._el._attrs.set('class', val);
      else this._el._attrs.delete('class');
    }
    add(...names) {
      for (const n of names) if (n) this._set.add(n);
      this._syncToAttr();
    }
    remove(...names) {
      for (const n of names) this._set.delete(n);
      this._syncToAttr();
    }
    contains(name) {
      return this._set.has(name);
    }
  }

  function matchSimpleSelector(node, sel) {
    const trimmed = sel.trim();
    if (!trimmed) return false;
    if (trimmed.startsWith(':scope > ')) {
      return matchSimpleSelector(node, trimmed.slice(':scope > '.length));
    }
    let rest = trimmed;
    const tagMatch = rest.match(/^([a-zA-Z0-9_-]+)/);
    if (tagMatch) {
      if (node.tagName.toLowerCase() !== tagMatch[1].toLowerCase()) return false;
      rest = rest.slice(tagMatch[1].length);
    }
    // Check :not(...)
    const notParts = [];
    rest = rest.replace(/:not\(([^)]+)\)/g, (_m, inner) => {
      notParts.push(inner);
      return '';
    });
    for (const np of notParts) {
      if (matchSimpleSelector(node, np)) return false;
    }
    // Check classes
    const classes = rest.match(/\.[a-zA-Z0-9_-]+/g) || [];
    rest = rest.replace(/\.[a-zA-Z0-9_-]+/g, '');
    for (const c of classes) {
      if (!node.classList.contains(c.slice(1))) return false;
    }
    // Check attribute selectors [k="v"], [k*="v"], [k^="v"], [k]
    const attrRe = /\[([^\]=*^]+)(?:(\*|\^)?="([^"]*)")?\]/g;
    let m;
    while ((m = attrRe.exec(rest))) {
      const attrName = m[1].trim();
      const op = m[2] || (m[3] !== undefined ? '=' : null);
      const expected = m[3];
      const actual = node.getAttribute(attrName);
      if (op === null) {
        if (actual === null) return false;
      } else if (op === '=') {
        if (actual !== expected) return false;
      } else if (op === '*=') {
        if (actual === null || !actual.includes(expected)) return false;
      } else if (op === '^=') {
        if (actual === null || !actual.startsWith(expected)) return false;
      }
    }
    return true;
  }

  function matchesSelectorList(node, selectorList) {
    if (!node || node.nodeType !== 1) return false;
    return selectorList.split(',').some((part) => {
      const p = part.trim();
      if (!p) return false;
      if (p.includes(' ') && !p.startsWith(':scope > ')) {
        const parts = p.split(/\s+/);
        const last = parts[parts.length - 1];
        if (!matchSimpleSelector(node, last)) return false;
        let cur = node.parentElement;
        for (let i = parts.length - 2; i >= 0; i -= 1) {
          while (cur && !matchSimpleSelector(cur, parts[i])) {
            cur = cur.parentElement;
          }
          if (!cur) return false;
          cur = cur.parentElement;
        }
        return true;
      }
      return matchSimpleSelector(node, p);
    });
  }

  const mutationObservers = [];
  const winListeners = new Map();
  const storageListeners = new Set();

  let documentElement;

  class MockNode {
    constructor(nodeType, tagName = '') {
      this.nodeType = nodeType;
      this.tagName = tagName.toUpperCase();
      this.parentElement = null;
      this.children = [];
      this.childNodes = [];
      this._attrs = new Map();
      this.style = {};
      this._text = '';
      this.inert = false;
      this._listeners = new Map();
      this.classList = new MockClassList(this);
      this._rect = { top: 100, bottom: 220, left: 0, right: 600, width: 600, height: 120 };
    }
    get isConnected() {
      let cur = this;
      while (cur) {
        if (cur === documentElement) return true;
        cur = cur.parentElement;
      }
      return false;
    }
    get firstChild() {
      return this.children[0] || null;
    }
    get className() {
      return this._attrs.get('class') || '';
    }
    set className(val) {
      this.setAttribute('class', val);
    }
    get textContent() {
      if (this.nodeType === 3) return this._text;
      if (this.children.length === 0) return this._text;
      return this._text + this.children.map((c) => c.textContent).join('');
    }
    set textContent(val) {
      this._text = String(val ?? '');
      this.children = [];
      this.childNodes = [];
    }
    setAttribute(name, value) {
      const valStr = String(value);
      this._attrs.set(name, valStr);
      if (name === 'class') this.classList._syncFromString(valStr);
    }
    getAttribute(name) {
      return this._attrs.has(name) ? this._attrs.get(name) : null;
    }
    hasAttribute(name) {
      return this._attrs.has(name);
    }
    removeAttribute(name) {
      this._attrs.delete(name);
      if (name === 'class') this.classList._syncFromString('');
    }
    contains(target) {
      if (target === this) return true;
      for (const ch of this.children) {
        if (ch.contains(target)) return true;
      }
      return false;
    }
    closest(selectorList) {
      let cur = this;
      while (cur) {
        if (matchesSelectorList(cur, selectorList)) return cur;
        cur = cur.parentElement;
      }
      return null;
    }
    matches(selectorList) {
      return matchesSelectorList(this, selectorList);
    }
    querySelectorAll(selectorList) {
      const out = [];
      const isDirectScope = selectorList.trim().startsWith(':scope > ');
      const walk = (parent, depth) => {
        for (const ch of parent.children) {
          if (isDirectScope && depth > 0) continue;
          if (matchesSelectorList(ch, selectorList)) out.push(ch);
          if (!isDirectScope) walk(ch, depth + 1);
        }
      };
      walk(this, 0);
      return out;
    }
    querySelector(selectorList) {
      return this.querySelectorAll(selectorList)[0] || null;
    }
    appendChild(child) {
      if (child.parentElement) child.remove();
      child.parentElement = this;
      if (child.nodeType === 1) this.children.push(child);
      this.childNodes.push(child);
      notifyMutation({ type: 'childList', target: this, addedNodes: [child], removedNodes: [] });
      return child;
    }
    insertBefore(child, refChild) {
      if (!refChild) return this.appendChild(child);
      if (child.parentElement) child.remove();
      child.parentElement = this;
      const idx = this.children.indexOf(refChild);
      if (idx >= 0) this.children.splice(idx, 0, child);
      else this.children.push(child);
      this.childNodes.push(child);
      notifyMutation({ type: 'childList', target: this, addedNodes: [child], removedNodes: [] });
      return child;
    }
    remove() {
      if (!this.parentElement) return;
      const parent = this.parentElement;
      parent.children = parent.children.filter((c) => c !== this);
      parent.childNodes = parent.childNodes.filter((c) => c !== this);
      this.parentElement = null;
      notifyMutation({ type: 'childList', target: parent, addedNodes: [], removedNodes: [this] });
    }
    addEventListener(type, fn) {
      if (!this._listeners.has(type)) this._listeners.set(type, new Set());
      this._listeners.get(type).add(fn);
    }
    removeEventListener(type, fn) {
      this._listeners.get(type)?.delete(fn);
    }
    getBoundingClientRect() {
      return { ...this._rect };
    }
    compareDocumentPosition(other) {
      const all = [];
      const walk = (n) => {
        all.push(n);
        for (const c of n.children) walk(c);
      };
      walk(documentElement);
      const iSelf = all.indexOf(this);
      const iOther = all.indexOf(other);
      if (iSelf >= 0 && iOther > iSelf) return 4; // DOCUMENT_POSITION_FOLLOWING
      if (iSelf >= 0 && iOther >= 0 && iOther < iSelf) return 2;
      return 0;
    }
  }

  const pendingMutations = [];
  let mutationFlushScheduled = false;

  documentElement = new MockNode(1, 'html');
  const body = new MockNode(1, 'body');
  documentElement.appendChild(body);
  const timeline = new MockNode(1, 'div');
  timeline.setAttribute('data-testid', 'primaryColumn');
  body.appendChild(timeline);

  function notifyMutation(record) {
    if (!record.target.isConnected) return;
    pendingMutations.push(record);
    if (!mutationFlushScheduled) {
      mutationFlushScheduled = true;
      queueMicrotask(() => {
        mutationFlushScheduled = false;
        const batch = pendingMutations.splice(0);
        if (batch.length === 0) return;
        for (const obs of mutationObservers) {
          if (obs._active) obs._cb(batch);
        }
      });
    }
  }

  class MockMutationObserver {
    constructor(cb) {
      this._cb = cb;
      this._active = false;
      mutationObservers.push(this);
    }
    observe() {
      this._active = true;
    }
    disconnect() {
      this._active = false;
    }
  }

  const docObj = {
    readyState: 'complete',
    documentElement,
    body,
    createElement(tag) {
      return new MockNode(1, tag);
    },
    createTextNode(txt) {
      const n = new MockNode(3);
      n._text = String(txt ?? '');
      return n;
    },
    querySelector(sel) {
      return documentElement.querySelector(sel);
    },
    querySelectorAll(sel) {
      return documentElement.querySelectorAll(sel);
    },
    addEventListener() {},
    removeEventListener() {},
  };

  let scrollY = 0;
  const winObj = {
    location: { pathname },
    innerHeight: 900,
    get scrollY() {
      return scrollY;
    },
    set scrollY(val) {
      scrollY = val;
    },
    scrollBy(_x, y) {
      scrollY += y;
    },
    addEventListener(type, fn) {
      if (!winListeners.has(type)) winListeners.set(type, new Set());
      winListeners.get(type).add(fn);
    },
    removeEventListener(type, fn) {
      winListeners.get(type)?.delete(fn);
    },
    matchMedia: () => ({ matches: false }),
    requestAnimationFrame: (cb) => setTimeout(cb, 0),
    cancelAnimationFrame: (id) => clearTimeout(id),
    document: docObj,
  };
  winObj.window = winObj;

  const store = new Map(Object.entries(JSON.parse(JSON.stringify(storageData))));

  const chromeMock = {
    runtime: {
      lastError: null,
      getURL: (p) => `chrome-extension://test/${p}`,
      sendMessage(msg, cb) {
        Promise.resolve(onMessage ? onMessage(msg) : null).then((resp) => cb(resp));
      },
      onMessage: {
        addListener() {},
        removeListener() {},
      },
    },
    storage: {
      local: {
        get(keys, cb) {
          const list = Array.isArray(keys) ? keys : typeof keys === 'string' ? [keys] : Object.keys(keys || {});
          const out = {};
          for (const k of list) {
            if (store.has(k)) out[k] = JSON.parse(JSON.stringify(store.get(k)));
          }
          Promise.resolve().then(() => cb(out));
        },
      },
      onChanged: {
        addListener: (fn) => storageListeners.add(fn),
        removeListener: (fn) => storageListeners.delete(fn),
      },
    },
  };

  function emitStorageChange(changes) {
    for (const [k, ch] of Object.entries(changes)) {
      if (ch.newValue === undefined) store.delete(k);
      else store.set(k, JSON.parse(JSON.stringify(ch.newValue)));
    }
    for (const fn of storageListeners) fn(changes, 'local');
  }

  function makeTweetCell({ tweetId, handle, text, isReply = false, withActionBar = true }) {
    const cell = docObj.createElement('div');
    cell.setAttribute('data-testid', 'cellInnerDiv');
    const article = docObj.createElement('article');
    article.setAttribute('data-testid', 'tweet');

    const userName = docObj.createElement('div');
    userName.setAttribute('data-testid', 'User-Name');
    const profileLink = docObj.createElement('a');
    profileLink.setAttribute('href', `/${handle}`);
    const handleSpan = docObj.createElement('span');
    handleSpan.textContent = `@${handle}`;
    userName.appendChild(profileLink);
    userName.appendChild(handleSpan);
    article.appendChild(userName);

    if (isReply) {
      const replyBanner = docObj.createElement('div');
      replyBanner.setAttribute('data-testid', 'reply-banner');
      replyBanner.setAttribute('dir', 'ltr');
      replyBanner.textContent = 'Replying to @someone';
      article.appendChild(replyBanner);
    }

    const statusLink = docObj.createElement('a');
    statusLink.setAttribute('href', `/${handle}/status/${tweetId}`);
    const timeEl = docObj.createElement('time');
    timeEl.setAttribute('datetime', '2026-11-24T12:00:00.000Z');
    statusLink.appendChild(timeEl);
    article.appendChild(statusLink);

    const tweetText = docObj.createElement('div');
    tweetText.setAttribute('data-testid', 'tweetText');
    tweetText.textContent = text;
    article.appendChild(tweetText);

    let actionGroup = null;
    if (withActionBar) {
      actionGroup = docObj.createElement('div');
      actionGroup.setAttribute('role', 'group');
      article.appendChild(actionGroup);
    }

    cell.appendChild(article);
    return { cell, article, tweetText, actionGroup };
  }

  const sharedSrc = readFileSync(resolve(EXT_DIR, 'src/shared.js'), 'utf8');
  const contentSrc = readFileSync(resolve(EXT_DIR, 'src/content.js'), 'utf8');

  const ctx = vm.createContext({
    window: winObj,
    document: docObj,
    chrome: chromeMock,
    Node: { DOCUMENT_POSITION_FOLLOWING: 4 },
    MutationObserver: MockMutationObserver,
    getComputedStyle: () => ({ backgroundColor: 'rgb(21, 32, 43)' }),
    setTimeout,
    clearTimeout,
    requestAnimationFrame: winObj.requestAnimationFrame,
    cancelAnimationFrame: winObj.cancelAnimationFrame,
    queueMicrotask,
  });
  winObj.AntiSlopShared = undefined;
  vm.runInContext(sharedSrc, ctx);
  winObj.AntiSlopShared = ctx.AntiSlopShared;

  const boot = () => vm.runInContext(contentSrc, ctx);

  return {
    boot,
    winObj,
    docObj,
    timeline,
    makeTweetCell,
    emitStorageChange,
    cleanup: () => winObj.__antislopCleanup?.(),
  };
}

function makeSnapshot({ settings = { enabled: true, displayMode: 'hide' }, ...rest } = {}) {
  return {
    settings,
    effectiveFlywheelUrl: 'https://fw.example',
    whitelist: [],
    remoteBlacklist: [],
    localBlacklist: [],
    blockedTweets: [],
    allowedTweets: [],
    sessionAccounts: [],
    verdictCache: [],
    ...rest,
  };
}

test('manifest runs at document_start and content.css enforces zero-height expansion on actionbar trigger', () => {
  const manifest = JSON.parse(readFileSync(resolve(EXT_DIR, 'manifest.json'), 'utf8'));
  assert.equal(manifest.content_scripts[0].run_at, 'document_start');

  const css = readFileSync(resolve(EXT_DIR, 'src/content.css'), 'utf8');
  assert.match(css, /\.antislop-report-wrap\.antislop-in-actionbar\s*\{[^}]*height:\s*20px;/s);
  assert.match(css, /\.antislop-report-wrap\.antislop-in-actionbar\s+\.antislop-report-trigger\s*\{[^}]*margin:\s*-4px 0;/s);
  assert.match(css, /article\[data-antislop-state="collapsing"\]\.antislop-auto-collapsing\s*\{[^}]*max-height:\s*0\s*!important;/s);
  assert.match(css, /@media\s*\(prefers-reduced-motion:\s*reduce\)\s*\{[^}]*article\[data-antislop-state="collapsing"\]/s);
});

test('content.js hides known blacklisted tweet synchronously at microtask mount with zero CLASSIFY_BATCH IPC and queues RECORD_LOCAL_INTERCEPTS', async () => {
  const messages = [];
  const harness = createHarnessDom({
    storageData: {
      antislop_settings: { enabled: true, displayMode: 'hide' },
      antislop_blacklist: ['bad_bot'],
    },
    onMessage: (msg) => {
      messages.push(msg);
      if (msg.type === 'GET_CLIENT_SNAPSHOT') {
        return makeSnapshot({ remoteBlacklist: ['bad_bot'] });
      }
      return { ok: true };
    },
  });

  harness.boot();
  await new Promise((r) => setTimeout(r, 20));

  const { cell, article } = harness.makeTweetCell({
    tweetId: '990001',
    handle: 'bad_bot',
    text: 'Check out this AI slop promotion link https://t.co/promo',
    isReply: true,
  });
  harness.timeline.appendChild(cell);

  // Flush only microtasks (0ms, no timers)
  await new Promise((r) => queueMicrotask(r));
  await new Promise((r) => queueMicrotask(r));

  assert.equal(article.getAttribute('data-antislop-state'), 'hidden');
  assert.equal(messages.some((m) => m.type === 'CLASSIFY_BATCH'), false);

  await new Promise((r) => setTimeout(r, 300));
  const recMsg = messages.find((m) => m.type === 'RECORD_LOCAL_INTERCEPTS');
  assert.ok(recMsg);
  assert.equal(recMsg.entries.length, 1);
  assert.equal(recMsg.entries[0].item.tweetId, '990001');

  harness.cleanup();
});

test('content.js mounts Baku button synchronously before AI responds, keeps node intact across same-tweet hydration and ALLOW response', async () => {
  let resolveBatch;
  const batchPromise = new Promise((res) => {
    resolveBatch = res;
  });

  const harness = createHarnessDom({
    storageData: {
      antislop_settings: { enabled: true, displayMode: 'hide', aiScanScope: 'replies' },
      antislop_blacklist: [],
    },
    onMessage: async (msg) => {
      if (msg.type === 'GET_CLIENT_SNAPSHOT') {
        return makeSnapshot({ settings: { enabled: true, displayMode: 'hide', aiScanScope: 'replies' } });
      }
      if (msg.type === 'CLASSIFY_BATCH') {
        return batchPromise;
      }
      return { ok: true };
    },
  });

  harness.boot();
  await new Promise((r) => setTimeout(r, 20));

  const { cell, article, tweetText, actionGroup } = harness.makeTweetCell({
    tweetId: '880001',
    handle: 'alice_eng',
    text: 'Initial reply snippet that needs AI check...',
    isReply: true,
  });
  harness.timeline.appendChild(cell);

  await new Promise((r) => queueMicrotask(r));
  await new Promise((r) => queueMicrotask(r));

  // Button is already mounted synchronously inside actionGroup BEFORE CLASSIFY_BATCH finishes
  const firstWrap = actionGroup.querySelector('.antislop-report-wrap');
  assert.ok(firstWrap);
  assert.equal(firstWrap.classList.contains('antislop-in-actionbar'), true);

  // Hydrate tweetText (same tweetId) -> button node must be preserved (same reference, never torn down)
  tweetText.textContent = 'Initial reply snippet that needs AI check... and expanded details!';
  await new Promise((r) => queueMicrotask(r));
  await new Promise((r) => queueMicrotask(r));
  assert.equal(actionGroup.querySelector('.antislop-report-wrap'), firstWrap);

  // Resolve CLASSIFY_BATCH after 60ms debounce with ALLOW
  await new Promise((r) => setTimeout(r, 80));
  resolveBatch({
    results: [
      { tweetId: '880001', handle: 'alice_eng', matchedHandle: 'alice_eng', verdict: 'ALLOW', scope: 'TWEET', source: 'ai_model' },
    ],
  });
  await new Promise((r) => setTimeout(r, 20));

  assert.equal(article.getAttribute('data-antislop-state'), null);
  assert.equal(actionGroup.querySelector('.antislop-report-wrap'), firstWrap);

  harness.cleanup();
});

test('content.js avoids overlay rebuild on unrelated storage changes and reuses unchanged streak bars', async () => {
  const harness = createHarnessDom({
    pathname: '/op_user/status/770000',
    storageData: {
      antislop_settings: { enabled: true, displayMode: 'mask' },
      antislop_blacklist: ['slop_1', 'slop_2'],
    },
    onMessage: (msg) => {
      if (msg.type === 'GET_CLIENT_SNAPSHOT') {
        return makeSnapshot({
          settings: { enabled: true, displayMode: 'mask' },
          remoteBlacklist: ['slop_1', 'slop_2'],
        });
      }
      return { ok: true };
    },
  });

  // Mount focal tweet + 1 masked slop reply
  const focal = harness.makeTweetCell({ tweetId: '770000', handle: 'op_user', text: 'Main focal post' });
  const reply1 = harness.makeTweetCell({ tweetId: '770001', handle: 'slop_1', text: 'Reply 1', isReply: true });
  harness.timeline.appendChild(focal.cell);
  harness.timeline.appendChild(reply1.cell);

  harness.boot();
  await new Promise((r) => setTimeout(r, 30));

  const overlayNode = reply1.article.querySelector(':scope > .antislop-mask-overlay');
  assert.ok(overlayNode);

  // Storage change adding an unrelated handle must NOT recreate reply1's mask overlay
  harness.emitStorageChange({
    antislop_blacklist: { newValue: ['slop_1', 'slop_2', 'slop_3'] },
  });
  assert.equal(reply1.article.querySelector(':scope > .antislop-mask-overlay'), overlayNode);

  // Switch to hide mode and add 5 consecutive hidden slop replies -> streak bar appears and stays stable across re-scans
  harness.emitStorageChange({
    antislop_settings: { newValue: { enabled: true, displayMode: 'hide' } },
  });
  for (let i = 2; i <= 6; i += 1) {
    const r = harness.makeTweetCell({
      tweetId: `77000${i}`,
      handle: i % 2 === 0 ? 'slop_2' : 'slop_3',
      text: `Hidden reply ${i}`,
      isReply: true,
    });
    harness.timeline.appendChild(r.cell);
  }
  await new Promise((r) => queueMicrotask(r));
  await new Promise((r) => queueMicrotask(r));

  const streakBar = harness.docObj.querySelector('.antislop-streak-bar');
  assert.ok(streakBar);
  assert.match(streakBar.textContent, /6 条/);

  // Adding another unrelated handle to blacklist must NOT destroy and recreate the identical streak bar node
  harness.emitStorageChange({
    antislop_blacklist: { newValue: ['slop_1', 'slop_2', 'slop_3', 'slop_4'] },
  });
  assert.equal(harness.docObj.querySelector('.antislop-streak-bar'), streakBar);

  harness.cleanup();
});

test('content.js settles async AI slop hits by viewport zone: smooth collapse in-viewport, silent offscreen, and anchor scroll stabilization', async () => {
  const harness = createHarnessDom({
    storageData: {
      antislop_settings: { enabled: true, displayMode: 'hide', aiScanScope: 'all' },
      antislop_blacklist: [],
    },
    onMessage: (msg) => {
      if (msg.type === 'GET_CLIENT_SNAPSHOT') {
        return makeSnapshot({ settings: { enabled: true, displayMode: 'hide', aiScanScope: 'all' } });
      }
      if (msg.type === 'CLASSIFY_BATCH') {
        return {
          results: msg.items.map((it) => ({
            tweetId: it.tweetId,
            handle: it.handle,
            matchedHandle: it.handle,
            verdict: it.handle === 'keep_anchor' ? 'ALLOW' : 'SLOP',
            scope: 'TWEET',
            source: 'ai_model',
          })),
        };
      }
      return { ok: true };
    },
  });

  // Simulate scrolled viewport at scrollY = 400
  harness.winObj.scrollY = 400;

  // Dynamic rect calculation reflecting hidden state & scrollY for above-viewport collapse drift
  const above = harness.makeTweetCell({ tweetId: '660001', handle: 'above_slop', text: 'Above viewport slop post long text' });
  const anchor = harness.makeTweetCell({ tweetId: '660002', handle: 'keep_anchor', text: 'Visible kept anchor post long text' });
  const visibleSlop = harness.makeTweetCell({ tweetId: '660003', handle: 'visible_slop', text: 'In viewport slop post long text' });
  const belowSlop = harness.makeTweetCell({ tweetId: '660004', handle: 'below_slop', text: 'Below viewport slop post long text' });

  above.article.getBoundingClientRect = () => {
    const collapsed = above.article.getAttribute('data-antislop-state') === 'hidden';
    const top = 200 - harness.winObj.scrollY;
    return { top, bottom: collapsed ? top : top + 150, height: collapsed ? 0 : 150, left: 0, right: 600, width: 600 };
  };
  anchor.article.getBoundingClientRect = () => {
    const aboveCollapsed = above.article.getAttribute('data-antislop-state') === 'hidden';
    const docTop = aboveCollapsed ? 350 : 500;
    const top = docTop - harness.winObj.scrollY;
    return { top, bottom: top + 160, height: 160, left: 0, right: 600, width: 600 };
  };
  visibleSlop.article._rect = { top: 320, bottom: 480, height: 160, left: 0, right: 600, width: 600 };
  belowSlop.article._rect = { top: 1100, bottom: 1250, height: 150, left: 0, right: 600, width: 600 };

  harness.timeline.appendChild(above.cell);
  harness.timeline.appendChild(anchor.cell);
  harness.timeline.appendChild(visibleSlop.cell);
  harness.timeline.appendChild(belowSlop.cell);

  harness.boot();
  await new Promise((r) => setTimeout(r, 90));

  // Immediately after batch settles: above & below are hidden silently, visibleSlop enters smooth collapsing, anchor keeps viewport top=100
  assert.equal(above.article.getAttribute('data-antislop-state'), 'hidden');
  assert.equal(belowSlop.article.getAttribute('data-antislop-state'), 'hidden');
  assert.equal(visibleSlop.article.getAttribute('data-antislop-state'), 'collapsing');
  assert.equal(harness.winObj.scrollY, 250);
  assert.equal(anchor.article.getBoundingClientRect().top, 100);

  // After AUTO_COLLAPSE_MS (~190ms), visibleSlop settles into hidden
  await new Promise((r) => setTimeout(r, 220));
  assert.equal(visibleSlop.article.getAttribute('data-antislop-state'), 'hidden');

  harness.cleanup();
});
