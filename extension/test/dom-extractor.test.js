import test from 'node:test';
import assert from 'node:assert/strict';
import '../src/shared.js';

const {
  DEFAULT_FLYWHEEL_URL,
  DEFAULT_AI_BASE_URL,
  DEFAULT_AI_MODEL,
  normalizeHandle,
  normalizeBadgeMode,
  normalizeSettings,
  resolveFlywheelUrl,
  extractTweetData,
  evaluateLocalRules,
  shouldQueryAiClassifier,
  classifyWithAi,
  describeRuntimeStatus,
  describeInterceptEntry,
  paintToolbarCornerCount,
} = globalThis.AntiSlopShared;

function createMockNode({
  attrs = {},
  textContent = '',
  selectors = {},
  children = [],
  parentElement = null,
} = {}) {
  const node = {
    textContent,
    parentElement,
    _children: children,
    getAttribute(name) {
      return Object.prototype.hasOwnProperty.call(attrs, name) ? attrs[name] : null;
    },
    contains(target) {
      if (target === node) return true;
      for (const ch of node._children) {
        if (ch === target || (typeof ch.contains === 'function' && ch.contains(target))) {
          return true;
        }
      }
      return false;
    },
    querySelector(sel) {
      const val = selectors[sel];
      return Array.isArray(val) ? val[0] || null : val || null;
    },
    querySelectorAll(sel) {
      const val = selectors[sel];
      if (!val) return [];
      return Array.isArray(val) ? val : [val];
    },
  };
  for (const ch of children) {
    ch.parentElement = node;
  }
  return node;
}

test('normalizeHandle strips @ and lowercases', () => {
  assert.equal(normalizeHandle(' @SlopBot_123 '), 'slopbot_123');
  assert.equal(normalizeHandle(''), '');
});

test('extractTweetData extracts tweetId, handle, text, publishedAt, isVerified, and retweet status', () => {
  const statusLink = createMockNode({
    attrs: { href: '/crypto_shill_99/status/185000999888' },
  });
  const verifiedIcon = createMockNode({});
  const userNameEl = createMockNode({
    selectors: {
      '[data-testid="icon-verified"]': verifiedIcon,
      'a[href^="/"]': [createMockNode({ attrs: { href: '/crypto_shill_99' } })],
      span: [
        createMockNode({ textContent: 'Free Airdrop 100x' }),
        createMockNode({ textContent: '@crypto_shill_99' }),
      ],
    },
  });
  const tweetTextEl = createMockNode({ textContent: 'Claim your $AIRDROP now!' });
  const timeEl = createMockNode({ attrs: { datetime: '2026-11-18T11:00:00.000Z' } });
  const socialCtxEl = {
    textContent: 'spam_retweeter reposted',
    closest: () => ({ getAttribute: () => '/spam_retweeter' }),
  };

  const replyBtn = createMockNode({});
  const actionBar = createMockNode({
    selectors: { '[data-testid="reply"]': replyBtn },
    children: [replyBtn],
  });

  const articleEl = createMockNode({
    selectors: {
      'a[href*="/status/"]': [statusLink],
      '[data-testid="User-Name"]': [userNameEl],
      '[data-testid="tweetText"]': [tweetTextEl],
      'time[datetime]': [timeEl],
      '[data-testid="socialContext"]': socialCtxEl,
      '[data-testid="reply"]': replyBtn,
      '[role="group"]': actionBar,
    },
    children: [userNameEl, tweetTextEl, timeEl, statusLink, actionBar],
  });

  const data = extractTweetData(articleEl);
  assert.equal(data.tweetId, '185000999888');
  assert.equal(data.handle, 'crypto_shill_99');
  assert.equal(data.retweeterHandle, 'spam_retweeter');
  assert.equal(data.isRetweet, true);
  assert.equal(data.isReply, false);
  assert.equal(data.isVerified, true);
  assert.equal(data.text, 'Claim your $AIRDROP now!');
  assert.equal(data.publishedAt, '2026-11-18T11:00:00.000Z');
  assert.equal(data.accountMeta, undefined);

  // Detail-page context marks replies after focal tweet while exempting the focal tweet itself
  const focalData = extractTweetData(articleEl, { focalTweetId: '185000999888', afterFocal: false });
  assert.equal(focalData.isReply, false);
  const replyData = extractTweetData(articleEl, { focalTweetId: '999999999999', afterFocal: true });
  assert.equal(replyData.isReply, true);
});

test('extractTweetData detects reply banner outside tweetText without misclassifying body text', () => {
  const userNameEl = createMockNode({
    selectors: { span: [createMockNode({ textContent: '@u1' })] },
  });
  const bodyWithReplyingText = createMockNode({ textContent: 'Replying to @someone in my thoughts today' });
  const nonReplyArticle = createMockNode({
    selectors: {
      '[data-testid="User-Name"]': [userNameEl],
      '[data-testid="tweetText"]': [bodyWithReplyingText],
      'div[dir="ltr"], [data-testid="reply-banner"]': [bodyWithReplyingText],
    },
    children: [userNameEl, bodyWithReplyingText],
  });
  assert.equal(extractTweetData(nonReplyArticle).isReply, false);

  const bannerNode = createMockNode({ textContent: '回复 @alice_dev' });
  const replyText = createMockNode({ textContent: 'Totally agree with this benchmark.' });
  const replyArticle = createMockNode({
    selectors: {
      '[data-testid="User-Name"]': [userNameEl],
      '[data-testid="tweetText"]': [replyText],
      'div[dir="ltr"], [data-testid="reply-banner"]': [bannerNode],
    },
    children: [userNameEl, bannerNode, replyText],
  });
  assert.equal(extractTweetData(replyArticle).isReply, true);
});

test('extractTweetData isolates Quote Tweet fields', () => {
  const outerUserName = createMockNode({
    selectors: {
      span: [createMockNode({ textContent: 'Bob' }), createMockNode({ textContent: '@bob_dev' })],
    },
  });
  const outerText = createMockNode({ textContent: 'Can someone ban these bots already?' });

  const quotedUserName = createMockNode({
    selectors: {
      span: [createMockNode({ textContent: 'Free Mint 🚀🔥💎' }), createMockNode({ textContent: '@bot_9999' })],
    },
  });
  const quotedText = createMockNode({ textContent: "Comment 'FREE' to get DM!" });
  const quoteCard = createMockNode({ children: [quotedUserName, quotedText] });

  const articleEl = createMockNode({
    selectors: {
      '[data-testid="User-Name"]': [outerUserName, quotedUserName],
      '[data-testid="tweetText"]': [outerText, quotedText],
    },
    children: [outerUserName, outerText, quoteCard],
  });

  const data = extractTweetData(articleEl);
  assert.equal(data.handle, 'bob_dev');
  assert.equal(data.text, 'Can someone ban these bots already?');
  assert.equal(data.quotedHandle, 'bot_9999');
  assert.equal(data.quotedText, "Comment 'FREE' to get DM!");
  assert.equal(data.quotedDisplayName, undefined);
});

test('extractTweetData recognizes Chinese X retweet and generates deterministic fallback tweetIds', () => {
  const userNameEl = createMockNode({
    selectors: {
      'a[href^="/"]': [createMockNode({ attrs: { href: '/normal_author' } })],
      span: [createMockNode({ textContent: 'Author' }), createMockNode({ textContent: '@normal_author' })],
    },
  });
  const socialCtxEl = {
    textContent: 'SpamBot 已转帖',
    closest: () => ({ getAttribute: () => '/SpamBot' }),
  };
  const articleEl = createMockNode({
    selectors: {
      'a[href*="/status/"]': [createMockNode({ attrs: { href: '/normal_author/status/185000555' } })],
      '[data-testid="User-Name"]': [userNameEl],
      '[data-testid="tweetText"]': [createMockNode({ textContent: 'Original technical post.' })],
      '[data-testid="socialContext"]': socialCtxEl,
    },
    children: [userNameEl],
  });

  const data = extractTweetData(articleEl);
  assert.equal(data.isRetweet, true);
  assert.equal(data.retweeterHandle, 'spambot');
  assert.equal(data.handle, 'normal_author');

  const imgA = createMockNode({ attrs: { src: 'https://pbs.twimg.com/media/img_alpha.jpg' } });
  const imgB = createMockNode({ attrs: { src: 'https://pbs.twimg.com/media/img_beta.jpg' } });
  const artA = createMockNode({ selectors: { '[data-testid="User-Name"]': [userNameEl], 'img[src], video[poster]': [imgA] }, children: [userNameEl, imgA] });
  const artB = createMockNode({ selectors: { '[data-testid="User-Name"]': [userNameEl], 'img[src], video[poster]': [imgB] }, children: [userNameEl, imgB] });
  const dA = extractTweetData(artA);
  const dB = extractTweetData(artB);
  assert.ok(dA.tweetId.startsWith('dom_normal_author_'));
  assert.notEqual(dA.tweetId, dB.tweetId);
});

test('evaluateLocalRules performs pure list matching without legacy content regexes', () => {
  const lists = {
    blacklistSet: new Set(['bad_bot', 'spam_rt']),
    sessionAccountsSet: new Set(['session_bot']),
    whitelistSet: new Set(['good_friend']),
    allowedTweetsSet: new Set(['t_allowed']),
    blockedTweetsSet: new Set(['t_blocked']),
  };

  const selfPost = evaluateLocalRules({ handle: 'me_user', text: 'hi' }, lists, { selfHandle: 'me_user' });
  assert.equal(selfPost.verdict, 'ALLOW');
  assert.equal(selfPost.source, 'self');

  const wl = evaluateLocalRules({ handle: 'good_friend', text: 'anything' }, lists);
  assert.equal(wl.verdict, 'ALLOW');
  assert.equal(wl.source, 'whitelist');

  const rtHit = evaluateLocalRules({ handle: 'normal', retweeterHandle: 'spam_rt', text: 'hi' }, lists);
  assert.equal(rtHit.verdict, 'SLOP');
  assert.equal(rtHit.scope, 'ACCOUNT');
  assert.equal(rtHit.matchedHandle, 'spam_rt');

  const sessHit = evaluateLocalRules({ handle: 'session_bot', text: 'innocuous text' }, lists);
  assert.equal(sessHit.verdict, 'SLOP');
  assert.equal(sessHit.scope, 'ACCOUNT');
  assert.equal(sessHit.source, 'session_account');

  const singleBlocked = evaluateLocalRules({ tweetId: 't_blocked', handle: 'normal', text: 'hi' }, lists);
  assert.equal(singleBlocked.verdict, 'SLOP');
  assert.equal(singleBlocked.scope, 'TWEET');
  assert.equal(singleBlocked.source, 'user_block');

  // Unlisted posts stay ALLOW locally so Gemini Decisions handles content
  const unlisted = evaluateLocalRules({
    handle: 'airdrop_991122',
    displayName: 'Free Mint 100x 🚀🔥💎',
    text: 'Comment "AI" to get DM!',
  });
  assert.equal(unlisted.verdict, 'ALLOW');
  assert.equal(unlisted.source, 'allow');
});

test('shouldQueryAiClassifier skips empty/ultra-short non-signal posts and honors aiScanScope', () => {
  assert.equal(shouldQueryAiClassifier({ isReply: true, handle: 'u', text: '', quotedText: '' }, 'all'), false);
  assert.equal(shouldQueryAiClassifier({ isReply: false, handle: 'u', text: 'Long timeline discussion about systems architecture.' }, 'replies'), false);
  assert.equal(shouldQueryAiClassifier({ isReply: false, handle: 'u', text: 'Long timeline discussion about systems architecture.' }, 'all'), true);
  assert.equal(shouldQueryAiClassifier({ isReply: true, handle: 'u', text: 'Nice!' }, 'replies'), false);
  assert.equal(shouldQueryAiClassifier({ isReply: true, handle: 'u', text: 'https://t.co/abc' }, 'replies'), true);
});

test('classifyWithAi evaluates batches via Google Gemini Decisions with SLOP, QUOTED_ONLY, ALLOW, and fallback handling', async () => {
  const googleResults = await classifyWithAi(
    [
      {
        tweetId: 'g1',
        handle: 'bait_bot',
        isReply: true,
        isVerified: true,
        parentHandle: 'op_user',
        parentText: 'Original thread about new database engine',
        text: '本质上就是看护城河，评论 FREE 领提示词',
      },
      { tweetId: 'g2', handle: 'bob', text: 'Look at this scam', quotedHandle: 'scam_q', quotedText: 'Send ETH' },
      { tweetId: 'g3', handle: 'alice_eng', isReply: true, text: 'Checked WAL mode latency on 10M rows and saw a 22% drop.' },
    ],
    {
      apiKey: 'AIza-test',
      baseUrl: DEFAULT_AI_BASE_URL,
      model: DEFAULT_AI_MODEL,
    },
    async (url, init) => {
      assert.equal(url, DEFAULT_AI_BASE_URL);
      assert.equal(init.headers['x-goog-api-key'], 'AIza-test');
      const body = JSON.parse(init.body);
      assert.equal(body.model, DEFAULT_AI_MODEL);
      assert.ok(typeof body.input === 'string');
      assert.ok(body.input.includes('SharedParentPost (@op_user): Original thread about new database engine'));
      assert.ok(body.input.includes('VerifiedBlue: yes'));
      assert.ok(typeof body.questions?.p_0_slop?.criteria?.true_description === 'string');
      return {
        ok: true,
        async json() {
          return {
            answers: {
              p_0_slop: { type: 'noul', noul: 0.94, confidence: 0.96 },
              p_1_slop: { type: 'noul', noul: 0.89, confidence: 0.91 },
              p_1_target: { type: 'choice', choice: 'QUOTED_ONLY', confidence: 0.9 },
              p_2_slop: { type: 'noul', noul: 0.08, confidence: 0.92 },
            },
          };
        },
      };
    }
  );
  assert.equal(googleResults[0].verdict, 'SLOP');
  assert.equal(googleResults[0].scope, 'TWEET');
  assert.equal(googleResults[0].slopProb, 0.94);
  assert.equal(googleResults[1].verdict, 'SLOP');
  assert.equal(googleResults[1].scope, 'TWEET');
  assert.equal(googleResults[1].matchedHandle, 'scam_q');
  assert.equal(googleResults[2].verdict, 'ALLOW');
  assert.equal(googleResults[2].source, 'ai_model');
  assert.equal(googleResults[2].slopProb, 0.08);

  const fallbackResults = await classifyWithAi(
    [{ tweetId: 'f1', handle: 'user_x', isReply: true, text: 'Testing graceful fallback behavior.' }],
    { apiKey: 'AIza-test', baseUrl: DEFAULT_AI_BASE_URL, model: DEFAULT_AI_MODEL },
    async () => ({ ok: false, status: 503 })
  );
  assert.equal(fallbackResults[0].verdict, 'ALLOW');
  assert.equal(fallbackResults[0].source, 'ai_fallback_allow');
});

test('normalizeSettings and resolveFlywheelUrl reflect Gemini Decisions, badgeMode, and replies-first flywheel defaults', () => {
  assert.equal(normalizeBadgeMode(undefined), 'corner');
  assert.equal(normalizeBadgeMode('corner'), 'corner');
  assert.equal(normalizeBadgeMode('count'), 'count');
  assert.equal(normalizeBadgeMode('none'), 'none');
  assert.equal(normalizeBadgeMode('invalid'), 'corner');

  const defaults = normalizeSettings();
  assert.equal(defaults.badgeMode, 'corner');
  assert.equal(defaults.flywheelEnabled, true);
  assert.equal(defaults.flywheelUrl, '');
  assert.equal(defaults.aiEnabled, false);
  assert.equal(defaults.aiScanScope, 'replies');
  assert.equal(defaults.aiBaseUrl, DEFAULT_AI_BASE_URL);
  assert.equal(defaults.aiModel, DEFAULT_AI_MODEL);
  assert.equal(resolveFlywheelUrl(defaults, DEFAULT_FLYWHEEL_URL), DEFAULT_FLYWHEEL_URL);

  const custom = normalizeSettings({
    badgeMode: 'count',
    flywheelEnabled: true,
    flywheelUrl: 'https://worker.example.com/',
    flywheelToken: 'tok-123',
    aiEnabled: true,
    aiScanScope: 'all',
  });
  assert.equal(custom.badgeMode, 'count');
  assert.equal(custom.flywheelUrl, 'https://worker.example.com');
  assert.equal(custom.flywheelToken, 'tok-123');
  assert.equal(custom.aiEnabled, true);
  assert.equal(custom.aiScanScope, 'all');
  assert.equal(resolveFlywheelUrl(custom, DEFAULT_FLYWHEEL_URL), 'https://worker.example.com');
  assert.equal(resolveFlywheelUrl({ ...custom, flywheelEnabled: false }, DEFAULT_FLYWHEEL_URL), '');
});

test('describeRuntimeStatus accurately reports paused, BYOK + flywheel hybrid, pending sync, and error states', () => {
  assert.equal(describeRuntimeStatus({ enabled: false }, {}, 'https://fw.example').text, '已暂停');

  assert.deepEqual(
    describeRuntimeStatus(
      { enabled: true, flywheelEnabled: true, aiEnabled: true, aiApiKey: 'k1' },
      { backendOnline: true },
      'https://fw.example'
    ).text,
    'AI 直连 + 飞轮'
  );

  const hybridErr = describeRuntimeStatus(
    { enabled: true, flywheelEnabled: true, aiEnabled: true, aiApiKey: 'k1' },
    { backendOnline: false, lastError: 'timeout' },
    'https://fw.example'
  );
  assert.equal(hybridErr.tone, 'err');
  assert.equal(hybridErr.text, 'AI 直连（飞轮异常）');

  assert.equal(
    describeRuntimeStatus(
      { enabled: true, flywheelEnabled: false, aiEnabled: true, aiApiKey: 'k1' },
      {},
      ''
    ).text,
    'AI 直连'
  );

  assert.equal(
    describeRuntimeStatus({ enabled: true, flywheelEnabled: true }, { backendOnline: false }, 'https://fw.example').text,
    '飞轮连接中'
  );

  assert.equal(
    describeRuntimeStatus(
      { enabled: true, flywheelEnabled: true },
      { backendOnline: false, lastError: 'HTTP 502' },
      'https://fw.example'
    ).text,
    '连接异常'
  );

  assert.equal(describeRuntimeStatus({ enabled: true, flywheelEnabled: false }, {}, '').text, '仅本机名单');
});

test('describeInterceptEntry preserves outer author for quote-tweets and produces clean attribution badges', () => {
  const quoteHit = describeInterceptEntry({
    tweetId: '189002',
    handle: 'Alice_Normal',
    matchedHandle: 'spam_bot',
    quotedHandle: 'spam_bot',
    scope: 'ACCOUNT',
    source: 'blacklist',
  });
  assert.equal(quoteHit.authorHandle, 'alice_normal');
  assert.equal(quoteHit.matchedHandle, 'spam_bot');
  assert.equal(quoteHit.isIndirect, true);
  assert.equal(quoteHit.badge, '引用 @spam_bot');

  const rtHit = describeInterceptEntry({
    tweetId: '189003',
    handle: 'bob',
    matchedHandle: 'rt_bot',
    scope: 'ACCOUNT',
    source: 'blacklist',
  });
  assert.equal(rtHit.authorHandle, 'bob');
  assert.equal(rtHit.badge, '关联 @rt_bot');

  const manualAcct = describeInterceptEntry({
    tweetId: 'acct_bot1',
    handle: 'bot1',
    matchedHandle: 'bot1',
    scope: 'ACCOUNT',
    source: 'user_block',
  });
  assert.equal(manualAcct.isAccountOnly, true);
  assert.equal(manualAcct.isManualAccountBlock, true);
  assert.equal(manualAcct.badge, '手动拉黑');

  const aiSingle = describeInterceptEntry({
    tweetId: '189004',
    handle: 'reply_guy',
    scope: 'TWEET',
    source: 'ai_model',
  });
  assert.equal(aiSingle.badge, '单条命中');
});

test('paintToolbarCornerCount renders crisp celadon glyphs strictly within safe top-left bounds across 32x32 and 16x16', () => {
  const zeroBuf = new Uint8ClampedArray(32 * 32 * 4);
  const zeroRes = paintToolbarCornerCount(zeroBuf, 32, 0);
  assert.equal(zeroRes.painted, false);
  assert.equal(zeroBuf.every((v) => v === 0), true);

  for (const [cnt, expectedLabel] of [
    [1, '1'],
    [9, '9'],
    [12, '12'],
    [99, '99'],
    [120, '99+'],
  ]) {
    const buf = new Uint8ClampedArray(32 * 32 * 4);
    const res = paintToolbarCornerCount(buf, 32, cnt);
    assert.equal(res.painted, true);
    assert.equal(res.label, expectedLabel);
    assert.ok(res.bounds.minX >= 2 && res.bounds.maxX <= 13);
    assert.ok(res.bounds.minY >= 2 && res.bounds.maxY <= 11);
    for (let y = 0; y < 32; y += 1) {
      for (let x = 0; x < 32; x += 1) {
        const a = buf[(y * 32 + x) * 4 + 3];
        if (a > 0) {
          assert.ok(x >= 2 && x <= 13 && y >= 2 && y <= 11, `32px pixel out of safe zone (${x},${y}) for ${cnt}`);
          if (x >= 11) {
            assert.ok(y <= 4, `32px right edge pixel (${x},${y}) too close to ear for ${cnt}`);
          }
        }
      }
    }
  }

  for (const [cnt, expectedLabel] of [
    [1, '1'],
    [9, '9'],
    [15, '9+'],
  ]) {
    const buf = new Uint8ClampedArray(16 * 16 * 4);
    const res = paintToolbarCornerCount(buf, 16, cnt);
    assert.equal(res.painted, true);
    assert.equal(res.label, expectedLabel);
    assert.ok(res.bounds.minX >= 1 && res.bounds.maxX <= 5);
    assert.ok(res.bounds.minY >= 1 && res.bounds.maxY <= 5);
  }
});
