#!/usr/bin/env node
import { execFile, execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import { extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import '../extension/src/shared.js';

const execFileAsync = promisify(execFile);

const { paintToolbarCornerCount } = globalThis.AntiSlopShared;

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const EXT_DIR = join(ROOT, 'extension');
const DOCS_ASSETS_DIR = join(ROOT, 'docs', 'assets');
const STORE_DIR = join(DOCS_ASSETS_DIR, 'store');
const TMP_DIR = '/tmp/baku-store-build';
const CHROME_BIN = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
};

const SYNTHETIC_RECENT = [
  {
    tweetId: '201948271001',
    handle: 'insight_echo_ai',
    matchedHandle: 'insight_echo_ai',
    displayName: 'Tech Horizon',
    text: '说得太深刻了，归根结底技术迭代的本质还是要回到商业闭环与长期护城河的底层逻辑。',
    quotedHandle: '',
    quotedText: '',
    scope: 'TWEET',
    source: 'ai_model',
    reason: 'AI reply-guy truism',
    interceptedAt: '2026-11-20T09:16:40.000Z',
  },
  {
    tweetId: '201948271002',
    handle: 'prompt_drops_hq',
    matchedHandle: 'prompt_drops_hq',
    displayName: 'Prompt Daily',
    text: 'Comment FREE + Follow me and I will DM you 500+ system optimization prompts!',
    quotedHandle: '',
    quotedText: '',
    scope: 'ACCOUNT',
    source: 'blacklist',
    reason: 'Account @prompt_drops_hq is blacklisted',
    interceptedAt: '2026-11-20T09:15:18.000Z',
  },
  {
    tweetId: '201948271003',
    handle: 'sol_airdrop_now',
    matchedHandle: 'sol_airdrop_now',
    displayName: 'Solana Genesis',
    text: 'Drop your Solana address below to claim the Genesis developer airdrop before snapshot!',
    quotedHandle: '',
    quotedText: '',
    scope: 'ACCOUNT',
    source: 'blacklist',
    reason: 'Account @sol_airdrop_now is blacklisted',
    interceptedAt: '2026-11-20T09:12:05.000Z',
  },
  {
    tweetId: '201948271004',
    handle: 'bluecheck_truism',
    matchedHandle: 'bluecheck_truism',
    displayName: 'Builder Notes',
    text: '这篇文章含金量拉满，本质上是一次认知升维，建议每个人都转发收藏慢慢品读。',
    quotedHandle: '',
    quotedText: '',
    scope: 'TWEET',
    source: 'ai_model',
    reason: 'AI engagement filler',
    interceptedAt: '2026-11-20T09:07:52.000Z',
  },
  {
    tweetId: '201948271005',
    handle: 'alpha_thread_bot',
    matchedHandle: 'alpha_thread_bot',
    displayName: 'Alpha Signals',
    text: '100% agree. Consistency and execution speed always win in the long run. Bookmarking this.',
    quotedHandle: '',
    quotedText: '',
    scope: 'TWEET',
    source: 'ai_model',
    reason: 'Generic cheerleading reply',
    interceptedAt: '2026-11-20T08:59:11.000Z',
  },
  {
    tweetId: '201948271006',
    handle: 'rt_giveaway_cn',
    matchedHandle: 'rt_giveaway_cn',
    displayName: '极客福利社',
    text: '关注 + 转发本条并在评论区回复「888」，今晚抽三位送全套自动化脚本礼包。',
    quotedHandle: '',
    quotedText: '',
    scope: 'ACCOUNT',
    source: 'user_block',
    reason: 'Blocked by user',
    interceptedAt: '2026-11-20T08:44:30.000Z',
  },
];

const LOCAL_BLACKLIST = ['prompt_drops_hq', 'sol_airdrop_now', 'auto_wealth_bot', 'rt_giveaway_cn'];
const REMOTE_BLACKLIST = [
  'claim_rewards_io',
  'web3_mint_alert',
  'ai_threads_daily',
  'growth_hack_dm',
  'free_prompts_bot',
  'alpha_signal_99',
  'airdrop_hub_pro',
  'reply_farm_v2',
  'passive_income_x',
  'bot_boost_club',
];
const WHITELIST = ['alice_systems', 'lin_infra', 'kenji_rust'];

function buildChromeShimScript() {
  const mockPayload = {
    settings: {
      enabled: true,
      displayMode: 'hide',
      badgeMode: 'corner',
      flywheelEnabled: true,
      flywheelUrl: '',
      flywheelToken: '',
      syncIntervalMinutes: 5,
      aiEnabled: false,
      aiApiKey: '',
      aiBaseUrl: 'https://generativelanguage.googleapis.com/v1beta/decisions',
      aiModel: 'gemini-decision-1',
      aiScanScope: 'replies',
    },
    effectiveFlywheelUrl: 'https://anti-slop-flywheel.kuhung.workers.dev',
    localBlacklist: LOCAL_BLACKLIST,
    remoteBlacklist: REMOTE_BLACKLIST,
    effectiveBlacklist: [...LOCAL_BLACKLIST, ...REMOTE_BLACKLIST].sort(),
    blacklistCount: LOCAL_BLACKLIST.length + REMOTE_BLACKLIST.length,
    remoteBlacklistCount: REMOTE_BLACKLIST.length,
    whitelist: WHITELIST,
    accountInterceptCounts: {
      insight_echo_ai: 4,
      prompt_drops_hq: 19,
      sol_airdrop_now: 27,
      bluecheck_truism: 6,
      rt_giveaway_cn: 11,
    },
    recentIntercepted: SYNTHETIC_RECENT,
    stats: {
      filteredCount: 168,
      mode: 'remote',
      backendOnline: true,
      lastSyncAt: '2026-11-20T09:18:24.000Z',
      lastError: '',
      remoteBlacklistCount: 412,
      remoteSlopPostCount: 3890,
      lastSeenStageId: 'baku',
    },
  };

  return `<script>
(function () {
  const STATE = ${JSON.stringify(mockPayload)};
  window.chrome = {
    runtime: {
      lastError: null,
      getURL(p) { return '/' + String(p || '').replace(/^\\/+/, ''); },
      sendMessage(msg, cb) {
        let resp = { ok: true };
        if (msg?.type === 'GET_STATE') {
          resp = {
            settings: STATE.settings,
            effectiveFlywheelUrl: STATE.effectiveFlywheelUrl,
            blacklistCount: STATE.blacklistCount,
            localBlacklist: STATE.localBlacklist,
            remoteBlacklistCount: STATE.remoteBlacklistCount,
            whitelist: STATE.whitelist,
            recentIntercepted: STATE.recentIntercepted,
            stats: STATE.stats,
          };
        } else if (msg?.type === 'GET_DASHBOARD_DATA') {
          resp = STATE;
        }
        if (typeof cb === 'function') setTimeout(() => cb(resp), 0);
        return Promise.resolve(resp);
      },
    },
    tabs: {
      query(q, cb) {
        const tabs = [{ id: 1, url: 'https://x.com/lin_infra/status/201948270000' }];
        if (typeof cb === 'function') setTimeout(() => cb(tabs), 0);
        return Promise.resolve(tabs);
      },
      sendMessage(_tabId, msg, cb) {
        const resp = msg?.type === 'GET_TAB_SUMMARY' ? { ok: true, pageFilteredCount: 6 } : { ok: true };
        if (typeof cb === 'function') setTimeout(() => cb(resp), 0);
      },
      create() {},
    },
    storage: {
      onChanged: { addListener() {} },
      local: { get(_k, cb) { if (cb) cb({}); return Promise.resolve({}); }, set(_v, cb) { if (cb) cb(); return Promise.resolve(); } },
    },
    permissions: { request() { return Promise.resolve(true); } },
  };
})();
</script>`;
}

function buildRealCornerActiveIcon() {
  const iconSrc = join(EXT_DIR, 'icons', 'icon-active-32.png');
  const rawRgbaPath = join(TMP_DIR, 'icon32.rgba');
  const outRgbaPath = join(TMP_DIR, 'icon32_6.rgba');
  const outPngPath = join(TMP_DIR, 'icon-active-6.png');

  execFileSync(
    'python3',
    [
      '-c',
      `from PIL import Image; im = Image.open(${JSON.stringify(iconSrc)}).convert('RGBA'); open(${JSON.stringify(rawRgbaPath)}, 'wb').write(im.tobytes())`,
    ],
    { stdio: 'inherit' }
  );

  const buf = new Uint8ClampedArray(readFileSync(rawRgbaPath));
  const painted = paintToolbarCornerCount(buf, 32, 6);
  if (!painted.painted) {
    throw new Error('paintToolbarCornerCount failed to draw corner digit');
  }
  writeFileSync(outRgbaPath, Buffer.from(buf));

  execFileSync(
    'python3',
    [
      '-c',
      `from PIL import Image
raw = open(${JSON.stringify(outRgbaPath)}, 'rb').read()
im = Image.frombytes('RGBA', (32, 32), raw)
im_up = im.resize((128, 128), Image.Resampling.NEAREST)
im_up.save(${JSON.stringify(outPngPath)})`,
    ],
    { stdio: 'inherit' }
  );
  return outPngPath;
}

function avatarSvg(initials, bg, fg = '#FFFFFF') {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="72" height="72" viewBox="0 0 72 72">
    <rect width="72" height="72" rx="36" fill="${bg}"/>
    <text x="36" y="45" text-anchor="middle" font-family="-apple-system, BlinkMacSystemFont, PingFang SC, sans-serif" font-size="28" font-weight="700" fill="${fg}">${initials}</text>
  </svg>`;
  return `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`;
}

const VERIFIED_BADGE_SVG = `<svg viewBox="0 0 22 22" width="15" height="15" aria-hidden="true" style="flex-shrink:0;vertical-align:-2px;"><path fill="#1D9BF0" d="M20.396 11c-.018-.646-.215-1.275-.57-1.816-.354-.54-.852-.972-1.438-1.246.223-.607.27-1.264.14-1.897-.131-.634-.437-1.218-.882-1.687-.47-.445-1.053-.75-1.687-.882-.633-.13-1.29-.083-1.897.14-.273-.587-.704-1.086-1.245-1.44S11.647 1.62 11 1.604c-.646.017-1.273.213-1.813.568s-.969.854-1.24 1.44c-.608-.223-1.267-.272-1.902-.14-.635.13-1.22.436-1.69.882-.445.47-.749 1.055-.878 1.688-.13.633-.08 1.29.144 1.896-.587.274-1.087.705-1.443 1.245-.356.54-.555 1.17-.574 1.817.02.647.218 1.276.574 1.817.356.54.856.972 1.443 1.245-.224.606-.274 1.263-.144 1.896.13.634.433 1.218.877 1.688.47.443 1.054.747 1.687.878.633.132 1.29.084 1.897-.136.274.586.705 1.084 1.246 1.439.54.354 1.17.551 1.816.569.647-.016 1.276-.213 1.817-.567s.972-.854 1.245-1.44c.604.239 1.266.296 1.903.164.636-.132 1.22-.447 1.68-.907.46-.46.776-1.044.908-1.681s.075-1.299-.165-1.903c.586-.274 1.084-.705 1.439-1.246.354-.54.551-1.17.569-1.816zM9.662 14.85l-3.429-3.428 1.293-1.302 2.072 2.072 4.4-4.794 1.347 1.246z"/></svg>`;

const X_ACTIONS_HTML = (c, r, l, v, extra = '') => `
  <div class="x-actions">
    <span class="x-act"><svg viewBox="0 0 24 24" width="15" height="15"><path fill="currentColor" d="M1.751 10c0-4.42 3.584-8 8.005-8h4.366c4.49 0 8.129 3.64 8.129 8.13 0 2.96-1.607 5.68-4.196 7.11l-8.054 4.46v-3.69h-.067c-4.49.1-8.183-3.51-8.183-8.01zm8.005-6c-3.317 0-6.005 2.69-6.005 6 0 3.37 2.77 6.08 6.138 6.01l.351-.01h1.761v2.3l5.087-2.81c1.951-1.08 3.163-3.13 3.163-5.36 0-3.39-2.744-6.13-6.129-6.13H9.756z"/></svg><span>${c}</span></span>
    <span class="x-act"><svg viewBox="0 0 24 24" width="15" height="15"><path fill="currentColor" d="M4.5 3.88l4.432 4.14-1.364 1.46L5.5 7.55V16c0 1.1.896 2 2 2H13v2H7.5c-2.209 0-4-1.79-4-4V7.55L1.432 9.48.068 8.02 4.5 3.88zM16.5 6H11V4h5.5c2.209 0 4 1.79 4 4v8.45l2.068-1.93 1.364 1.46-4.432 4.14-4.432-4.14 1.364-1.46 2.068 1.93V8c0-1.1-.896-2-2-2z"/></svg><span>${r}</span></span>
    <span class="x-act"><svg viewBox="0 0 24 24" width="15" height="15"><path fill="currentColor" d="M16.697 5.5c-1.222-.06-2.679.51-3.89 2.16l-.805 1.09-.806-1.09C9.984 6.01 8.526 5.44 7.304 5.5c-1.243.07-2.349.78-2.91 1.91-.552 1.12-.633 2.78.479 4.82 1.074 1.97 3.257 4.27 7.129 6.61 3.87-2.34 6.052-4.64 7.126-6.61 1.111-2.04 1.03-3.7.477-4.82-.561-1.13-1.666-1.84-2.908-1.91zm4.187 7.69c-1.351 2.48-4.001 5.12-8.379 7.67l-.503.3-.504-.3c-4.379-2.55-7.029-5.19-8.382-7.67-1.36-2.5-1.41-4.86-.514-6.67.887-1.79 2.647-2.91 4.601-3.01 1.651-.09 3.368.56 4.798 2.01 1.429-1.45 3.146-2.1 4.796-2.01 1.954.1 3.714 1.22 4.601 3.01.896 1.81.846 4.17-.514 6.67z"/></svg><span>${l}</span></span>
    <span class="x-act"><svg viewBox="0 0 24 24" width="15" height="15"><path fill="currentColor" d="M8.75 21V3h2v18h-2zM18 21V8.5h2V21h-2zM4 21l.004-10h2L6 21H4zm9.248 0v-7h2v7h-2z"/></svg><span>${v}</span></span>
    ${extra}
  </div>`;

function baseDoc(title, css, body) {
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8" />
<title>${title}</title>
<style>
  *, *::before, *::after { box-sizing: border-box; }
  html, body {
    margin: 0;
    padding: 0;
    font-family: "PingFang SC", -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
    -webkit-font-smoothing: antialiased;
    overflow: hidden;
  }
  ${css}
</style>
</head>
<body>${body}</body>
</html>`;
}

function renderShot01Html() {
  return baseDoc(
    'Shot 01 - X Before and After',
    `
    body {
      width: 1280px;
      height: 800px;
      background: #FAF9F5;
      color: #16191D;
      padding: 34px 44px 30px;
      display: flex;
      flex-direction: column;
      justify-content: space-between;
    }
    .slide-head {
      display: flex;
      align-items: flex-end;
      justify-content: space-between;
      gap: 24px;
    }
    .eyebrow {
      display: inline-flex;
      align-items: center;
      gap: 8px;
      padding: 4px 11px 4px 6px;
      border-radius: 999px;
      background: rgba(29, 111, 99, 0.10);
      border: 1px solid rgba(29, 111, 99, 0.22);
      color: #1D6F63;
      font-size: 12.5px;
      font-weight: 600;
      margin-bottom: 10px;
    }
    .eyebrow img { width: 18px; height: 18px; border-radius: 4px; display: block; }
    .slide-title {
      margin: 0;
      font-size: 32px;
      font-weight: 700;
      letter-spacing: -0.025em;
      line-height: 1.18;
      color: #16191D;
    }
    .slide-sub {
      margin: 6px 0 0;
      font-size: 15px;
      color: #5E6469;
    }
    .head-badge {
      padding: 8px 14px;
      border-radius: 10px;
      background: #FDFDFB;
      border: 1px solid #DFDCD4;
      font-size: 12.5px;
      color: #363B40;
      display: flex;
      align-items: center;
      gap: 8px;
      white-space: nowrap;
      box-shadow: 0 2px 8px rgba(22, 25, 29, 0.04);
    }
    .dot-celadon { width: 8px; height: 8px; border-radius: 50%; background: #1D6F63; }

    .compare-grid {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 24px;
      height: 604px;
    }
    .win {
      background: #FFFFFF;
      border: 1px solid #DFDCD4;
      border-radius: 14px;
      overflow: hidden;
      display: flex;
      flex-direction: column;
      box-shadow: 0 10px 30px rgba(22, 25, 29, 0.06);
    }
    .win.is-clean {
      border-color: rgba(29, 111, 99, 0.35);
      box-shadow: 0 12px 34px rgba(29, 111, 99, 0.09);
    }
    .win-bar {
      height: 44px;
      padding: 0 14px;
      background: #F4F2EC;
      border-bottom: 1px solid #E6E3DB;
      display: flex;
      align-items: center;
      justify-content: space-between;
      flex-shrink: 0;
    }
    .win-left { display: flex; align-items: center; gap: 10px; }
    .dots { display: flex; gap: 6px; }
    .dots span { width: 9px; height: 9px; border-radius: 50%; background: #D2CEC4; }
    .state-tag {
      font-size: 12px;
      font-weight: 600;
      padding: 3px 9px;
      border-radius: 999px;
    }
    .state-tag.before { background: rgba(184, 59, 42, 0.10); color: #A63425; }
    .state-tag.after { background: rgba(29, 111, 99, 0.12); color: #19685D; }
    .url-pill {
      font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
      font-size: 11.5px;
      color: #5E6469;
      background: #FFFFFF;
      border: 1px solid #DFDCD4;
      padding: 3px 10px;
      border-radius: 999px;
    }
    .toolbar-ext {
      display: inline-flex;
      align-items: center;
      gap: 7px;
      background: #FFFFFF;
      border: 1px solid rgba(29, 111, 99, 0.25);
      padding: 3px 9px 3px 4px;
      border-radius: 8px;
      font-size: 11.5px;
      color: #19685D;
      font-weight: 600;
    }
    .toolbar-ext img { width: 22px; height: 22px; border-radius: 5px; display: block; }

    .feed { padding: 0; flex: 1; display: flex; flex-direction: column; }
    .tweet {
      display: flex;
      gap: 11px;
      padding: 12px 16px;
      border-bottom: 1px solid #EFF3F4;
      position: relative;
    }
    .tweet.is-focal {
      background: #FFFFFF;
      padding: 13px 16px;
      border-bottom: 1px solid #E1E8ED;
    }
    .tweet.is-slop {
      background: rgba(184, 59, 42, 0.04);
    }
    .tweet.is-human-clean {
      padding: 15px 16px;
    }
    .avatar { width: 34px; height: 34px; border-radius: 50%; flex-shrink: 0; display: block; }
    .t-body { flex: 1; min-width: 0; }
    .t-head {
      display: flex;
      align-items: center;
      gap: 5px;
      font-size: 13px;
      line-height: 1.25;
      margin-bottom: 4px;
    }
    .t-name { font-weight: 700; color: #0F1419; }
    .t-handle { color: #536471; font-size: 12.5px; }
    .slop-chip {
      margin-left: auto;
      font-size: 11px;
      font-weight: 600;
      color: #B83B2A;
      background: rgba(184, 59, 42, 0.10);
      padding: 2px 7px;
      border-radius: 999px;
      white-space: nowrap;
    }
    .human-chip {
      margin-left: auto;
      font-size: 11px;
      font-weight: 600;
      color: #19685D;
      background: rgba(29, 111, 99, 0.10);
      padding: 2px 7px;
      border-radius: 999px;
      white-space: nowrap;
    }
    .t-text {
      font-size: 13px;
      line-height: 1.45;
      color: #0F1419;
    }
    .t-text.is-dim { color: #3B454E; }
    .x-actions {
      display: flex;
      align-items: center;
      gap: 24px;
      margin-top: 7px;
      color: #536471;
      font-size: 11.5px;
    }
    .x-act { display: inline-flex; align-items: center; gap: 4px; }
    .baku-inline-mini {
      margin-left: auto;
      width: 17px;
      height: 17px;
      opacity: 0.78;
      display: block;
    }
    .clean-summary {
      margin: auto 16px 14px;
      padding: 12px 14px;
      border-radius: 10px;
      background: #F4FAF8;
      border: 1px solid rgba(29, 111, 99, 0.22);
      display: flex;
      align-items: center;
      justify-content: space-between;
      font-size: 12.5px;
      color: #19685D;
    }
    .clean-summary strong { font-weight: 600; }
    .clean-summary span.mono {
      font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
      font-size: 12px;
      background: #FFFFFF;
      padding: 3px 8px;
      border-radius: 6px;
      border: 1px solid rgba(29, 111, 99, 0.20);
    }
    `,
    `
    <div class="slide-head">
      <div>
        <div class="eyebrow"><img src="/docs-assets/baku-icon.png" alt="" />Baku for X Slop</div>
        <h1 class="slide-title">把评论区的 AI 水帖安静收走</h1>
        <p class="slide-sub">默认无痕隐藏，只在浏览器右上角静默报数，把对话留给真正在说话的人</p>
      </div>
      <div class="head-badge"><span class="dot-celadon"></span>默认只扫描评论区与引用 · 零配置即用</div>
    </div>

    <div class="compare-grid">
      <section class="win">
        <div class="win-bar">
          <div class="win-left">
            <div class="dots"><span></span><span></span><span></span></div>
            <span class="state-tag before">开启前</span>
          </div>
          <span class="url-pill">x.com/lin_infra/status/20194827</span>
        </div>
        <div class="feed">
          <article class="tweet is-focal">
            <img class="avatar" src="${avatarSvg('L', '#181C20')}" alt="" />
            <div class="t-body">
              <div class="t-head"><span class="t-name">Lin</span><span class="t-handle">@lin_infra · 2小时</span></div>
              <div class="t-text">把批处理查询拆成 25 条一组并加一层边缘缓存后，P95 延迟从 140ms 压到了 18ms。</div>
              ${X_ACTIONS_HTML('19', '34', '268', '1.4万')}
            </div>
          </article>

          <article class="tweet is-slop">
            <img class="avatar" src="${avatarSvg('T', '#5B6470')}" alt="" />
            <div class="t-body">
              <div class="t-head"><span class="t-name">Tech Horizon</span>${VERIFIED_BADGE_SVG}<span class="t-handle">@insight_echo_ai · 1小时</span><span class="slop-chip">AI 复读水帖</span></div>
              <div class="t-text is-dim">说得太深刻了，归根结底技术迭代的本质还是要回到商业闭环与长期护城河的底层逻辑。</div>
              ${X_ACTIONS_HTML('0', '0', '1', '89')}
            </div>
          </article>

          <article class="tweet is-slop">
            <img class="avatar" src="${avatarSvg('P', '#7C5E48')}" alt="" />
            <div class="t-body">
              <div class="t-head"><span class="t-name">Prompt Daily</span>${VERIFIED_BADGE_SVG}<span class="t-handle">@prompt_drops_hq · 52分</span><span class="slop-chip">评论引流</span></div>
              <div class="t-text is-dim">Comment FREE + Follow me and I will DM you 500+ system optimization prompts!</div>
              ${X_ACTIONS_HTML('4', '0', '0', '142')}
            </div>
          </article>

          <article class="tweet">
            <img class="avatar" src="${avatarSvg('A', '#1D6F63')}" alt="" />
            <div class="t-body">
              <div class="t-head"><span class="t-name">Alice Chen</span><span class="t-handle">@alice_systems · 38分</span></div>
              <div class="t-text">我们线上也是 25 条一组的批大小，再大容易触发单次 SQL 参数绑定上限。</div>
              ${X_ACTIONS_HTML('2', '1', '14', '610')}
            </div>
          </article>

          <article class="tweet is-slop" style="border-bottom:none;">
            <img class="avatar" src="${avatarSvg('S', '#645A82')}" alt="" />
            <div class="t-body">
              <div class="t-head"><span class="t-name">Solana Genesis</span><span class="t-handle">@sol_airdrop_now · 21分</span><span class="slop-chip">空投垃圾</span></div>
              <div class="t-text is-dim">Drop your Solana address below to claim the Genesis developer airdrop before snapshot!</div>
              ${X_ACTIONS_HTML('1', '0', '0', '53')}
            </div>
          </article>
        </div>
      </section>

      <section class="win is-clean">
        <div class="win-bar">
          <div class="win-left">
            <div class="dots"><span></span><span></span><span></span></div>
            <span class="state-tag after">开启 Baku 后</span>
          </div>
          <div class="toolbar-ext">
            <img src="/captures/icon-active-6.png" alt="Baku toolbar counter" />
            <span>左上星光报数 · 本页吞掉 6 条</span>
          </div>
        </div>
        <div class="feed">
          <article class="tweet is-focal">
            <img class="avatar" src="${avatarSvg('L', '#181C20')}" alt="" />
            <div class="t-body">
              <div class="t-head"><span class="t-name">Lin</span><span class="t-handle">@lin_infra · 2小时</span></div>
              <div class="t-text">把批处理查询拆成 25 条一组并加一层边缘缓存后，P95 延迟从 140ms 压到了 18ms。</div>
              ${X_ACTIONS_HTML('19', '34', '268', '1.4万', `<img class="baku-inline-mini" src="/assets/baku-trigger-idle.png" alt="" />`)}
            </div>
          </article>

          <article class="tweet is-human-clean">
            <img class="avatar" src="${avatarSvg('A', '#1D6F63')}" alt="" />
            <div class="t-body">
              <div class="t-head"><span class="t-name">Alice Chen</span><span class="t-handle">@alice_systems · 38分</span><span class="human-chip">真人回复</span></div>
              <div class="t-text">我们线上也是 25 条一组的批大小，再大容易触发单次 SQL 参数绑定上限。缓存命中率大概拉到了多少？</div>
              ${X_ACTIONS_HTML('2', '1', '14', '610', `<img class="baku-inline-mini" src="/assets/baku-trigger-idle.png" alt="" />`)}
            </div>
          </article>

          <article class="tweet is-human-clean">
            <img class="avatar" src="${avatarSvg('K', '#2E4C6D')}" alt="" />
            <div class="t-body">
              <div class="t-head"><span class="t-name">Kenji</span><span class="t-handle">@kenji_rust · 15分</span><span class="human-chip">真人回复</span></div>
              <div class="t-text">如果写多读少，还可以顺便把同一条父帖的上下文拼成一段共享头，文本 token 能省一半以上。</div>
              ${X_ACTIONS_HTML('1', '0', '9', '388', `<img class="baku-inline-mini" src="/assets/baku-trigger-idle.png" alt="" />`)}
            </div>
          </article>

          <div class="clean-summary">
            <div><strong>页面保持干净，不留灰条占位</strong> · 3 条水帖已无痕隐藏</div>
            <span class="mono">误拦可随时放行</span>
          </div>
        </div>
      </section>
    </div>
    `
  );
}

function renderShot02Html() {
  return baseDoc(
    'Shot 02 - One Click Eat and Mask',
    `
    body {
      width: 1280px;
      height: 800px;
      background: radial-gradient(circle at 14% 12%, rgba(83, 229, 206, 0.14), transparent 42%), #0F1215;
      color: #F0EEE9;
      padding: 34px 44px 30px;
      display: flex;
      flex-direction: column;
      justify-content: space-between;
    }
    .slide-head { display: flex; align-items: flex-end; justify-content: space-between; gap: 24px; }
    .eyebrow {
      display: inline-flex; align-items: center; gap: 8px;
      padding: 4px 12px; border-radius: 999px;
      background: rgba(94, 194, 178, 0.14);
      border: 1px solid rgba(94, 194, 178, 0.28);
      color: #5EC2B2; font-size: 12.5px; font-weight: 600; margin-bottom: 10px;
    }
    .slide-title { margin: 0; font-size: 32px; font-weight: 700; letter-spacing: -0.025em; line-height: 1.18; color: #F0EEE9; }
    .slide-sub { margin: 6px 0 0; font-size: 15px; color: #98A3AA; }

    .grid-2 { display: grid; grid-template-columns: 1fr 1fr; gap: 24px; height: 604px; }
    .panel {
      background: #15202B;
      border: 1px solid rgba(139, 152, 165, 0.26);
      border-radius: 16px;
      padding: 20px 22px;
      display: flex;
      flex-direction: column;
      position: relative;
      box-shadow: 0 18px 44px rgba(0, 0, 0, 0.36);
    }
    .panel-label {
      font-size: 13px; font-weight: 600; color: #5EC2B2;
      margin-bottom: 14px; display: flex; align-items: center; justify-content: space-between;
    }
    .panel-label span.hint { color: #8B98A5; font-weight: 400; font-size: 12px; }

    .x-card {
      background: #192734;
      border: 1px solid rgba(139, 152, 165, 0.24);
      border-radius: 12px;
      padding: 14px 16px;
      color: #F7F9F9;
      position: relative;
    }
    .x-row { display: flex; gap: 11px; }
    .x-avatar { width: 36px; height: 36px; border-radius: 50%; flex-shrink: 0; }
    .x-head { display: flex; align-items: center; gap: 6px; font-size: 13.5px; margin-bottom: 5px; }
    .x-name { font-weight: 700; color: #F7F9F9; }
    .x-handle { color: #8B98A5; font-size: 12.5px; }
    .x-text { font-size: 14px; line-height: 1.5; color: #E7E9EA; }
    .x-actions { display: flex; align-items: center; gap: 26px; margin-top: 10px; color: #8B98A5; font-size: 12px; }
    .x-act { display: inline-flex; align-items: center; gap: 4px; }

    /* Real content.css overrides for static showcase alignment */
    .baku-btn-hovered {
      opacity: 1 !important;
      background: rgba(94, 194, 178, 0.22) !important;
      outline: 1.5px solid rgba(94, 194, 178, 0.55);
    }
    .baku-btn-hovered .is-idle { display: none !important; }
    .baku-btn-hovered .is-alert { display: block !important; transform: scale(1.08); }

    .static-menu {
      position: static !important;
      align-self: flex-end;
      margin-top: 10px;
      width: 248px;
    }
    .static-menu-recover {
      position: static !important;
      align-self: flex-end;
      margin-top: 10px;
      width: 236px;
    }
    .static-toast {
      position: static !important;
      transform: none !important;
      margin-top: auto;
      width: 100%;
      justify-content: space-between;
      max-width: none !important;
    }
    .toast-left { display: inline-flex; align-items: center; gap: 10px; }

    .mask-card-wrap {
      border: 1px solid rgba(139, 152, 165, 0.28);
      border-radius: 12px;
      overflow: hidden;
      background: #192734;
    }
    .streak-wrap {
      margin-top: auto;
      border: 1px solid rgba(139, 152, 165, 0.24);
      border-radius: 10px;
      overflow: hidden;
      background: #192734;
    }
    .streak-wrap .antislop-streak-bar { border-bottom: none; }
    .mode-note {
      margin-top: 12px;
      padding: 10px 12px;
      border-radius: 10px;
      background: rgba(255, 255, 255, 0.04);
      border: 1px solid rgba(139, 152, 165, 0.18);
      font-size: 12.5px;
      line-height: 1.5;
      color: #B6C2CC;
    }
    `,
    `
    <link rel="stylesheet" href="/src/content.css" />
    <div class="slide-head">
      <div>
        <div class="eyebrow">一击吞帖 · 随时反悔</div>
        <h1 class="slide-title">点一下静貘吞掉水帖，也可切换毛玻璃遮罩</h1>
        <p class="slide-sub">左键单击静貘直接收起单条，右键展开拉黑菜单；误拦随时一键放行或信任账号</p>
      </div>
    </div>

    <div class="grid-2" data-antislop-theme="dim">
      <section class="panel">
        <div class="panel-label">
          <span>方式一 · 推文底栏一击吞帖</span>
          <span class="hint">左键直接吞掉 · 右键更多选项</span>
        </div>

        <div class="x-card">
          <div class="x-row">
            <img class="x-avatar" src="${avatarSvg('B', '#485A6C')}" alt="" />
            <div style="flex:1;min-width:0;">
              <div class="x-head">
                <span class="x-name">Builder Notes</span>${VERIFIED_BADGE_SVG}<span class="x-handle">@bluecheck_truism · 12分</span>
              </div>
              <div class="x-text">这篇文章含金量拉满，本质上是一次认知升维，建议每个人都转发收藏慢慢品读。</div>
              ${X_ACTIONS_HTML(
                '0',
                '0',
                '2',
                '164',
                `<div class="antislop-report-wrap antislop-in-actionbar" style="margin-left:auto;">
                  <button type="button" class="antislop-report-trigger baku-btn-hovered" aria-label="喂给静貘">
                    <img class="antislop-baku-img is-idle" src="/assets/baku-trigger-idle.png" width="19" height="19" alt="" />
                    <img class="antislop-baku-img is-alert" src="/assets/baku-trigger-alert.png" width="19" height="19" alt="" />
                  </button>
                </div>`
              )}
            </div>
          </div>
        </div>

        <div class="antislop-floating-menu static-menu" role="menu">
          <button type="button" style="background:var(--antislop-menu-hover);">屏蔽这条<span class="antislop-menu-sub">只收起这一条，不拉黑作者</span></button>
          <button type="button">拉黑 @bluecheck_truism<span class="antislop-menu-sub">隐藏该账号的全部推文与回复</span></button>
        </div>

        <div class="mode-note">单击即刻播放吞噬动效收起单条水帖，底部弹出 5 秒可撤销提示，不打断当前阅读位置。</div>

        <div class="antislop-toast static-toast" role="status">
          <div class="toast-left">
            <img class="antislop-toast-mascot" src="/assets/baku-toast-munch.webp" width="28" height="28" alt="" />
            <span class="antislop-toast-text">已吞掉这条帖子</span>
          </div>
          <div class="antislop-toast-actions">
            <button type="button" class="antislop-toast-btn is-primary">拉黑 @bluecheck_truism</button>
            <button type="button" class="antislop-toast-btn">撤销</button>
          </div>
        </div>
      </section>

      <section class="panel">
        <div class="panel-label">
          <span>方式二 · 毛玻璃遮罩与快速放行</span>
          <span class="hint">可在管理台按需开启</span>
        </div>

        <div class="mask-card-wrap">
          <article data-antislop-state="masked" style="padding:12px 16px;">
            <div class="x-row">
              <img class="x-avatar" src="${avatarSvg('S', '#645A82')}" alt="" />
              <div>
                <div class="x-head"><span class="x-name">Solana Genesis</span><span class="x-handle">@sol_airdrop_now</span></div>
                <div class="x-text">Drop your wallet below to claim the Genesis developer airdrop!</div>
              </div>
            </div>
            <div class="antislop-mask-overlay">
              <span class="antislop-mask-label">
                <span class="antislop-mask-badge">Slop</span>
                <span class="antislop-mask-handle">@sol_airdrop_now</span>
              </span>
              <div class="antislop-mask-actions">
                <button type="button" class="antislop-btn">展开</button>
                <button type="button" class="antislop-btn" style="background:var(--antislop-menu-hover);color:#F7F9F9;">不是 Slop</button>
              </div>
            </div>
          </article>
        </div>

        <div class="antislop-floating-menu static-menu-recover" role="menu">
          <button type="button" style="background:var(--antislop-menu-hover);">放行这一条</button>
          <button type="button">信任 @sol_airdrop_now<span class="antislop-menu-sub">加入白名单，不再拦截该账号</span></button>
        </div>

        <div class="mode-note">对疑似正常发言随时点「展开」或「不是 Slop」，立即恢复原帖并加入本机信任白名单，同时自动回流校准公共名单。</div>

        <div class="streak-wrap">
          <div class="antislop-streak-bar">
            <span class="antislop-streak-text">静貘已静默收起 5 条 Slop 回复</span>
            <button type="button" class="antislop-btn">临时切换遮罩查看</button>
          </div>
        </div>
      </section>
    </div>
    `
  );
}

function renderShot03Html() {
  const stages = [
    { img: 'baku-stage-1.png', name: '幼貘', en: 'Fawn', range: '0 – 9 条', desc: '初入时间线', active: false },
    { img: 'baku-stage-2.png', name: '寻貘', en: 'Scout', range: '10 – 99 条', desc: '巡视评论区', active: false },
    { img: 'baku-stage-3.png', name: '静貘', en: 'Baku', range: '100 – 499 条', desc: '当前阶段 · 168 条', active: true },
    { img: 'baku-stage-4.png', name: '禅貘', en: 'Sage', range: '500 – 2,499 条', desc: '云气渐生', active: false },
    { img: 'baku-stage-5.png', name: '栖星', en: 'Astral', range: '2,500+ 条', desc: '万帖留真', active: false },
  ];

  return baseDoc(
    'Shot 03 - Popup and Stages',
    `
    body {
      width: 1280px;
      height: 800px;
      background: #FAF9F5;
      color: #16191D;
      padding: 34px 44px 30px;
      display: flex;
      flex-direction: column;
      justify-content: space-between;
    }
    .eyebrow {
      display: inline-flex; align-items: center; gap: 8px;
      padding: 4px 12px; border-radius: 999px;
      background: rgba(29, 111, 99, 0.10);
      border: 1px solid rgba(29, 111, 99, 0.22);
      color: #1D6F63; font-size: 12.5px; font-weight: 600; margin-bottom: 10px;
    }
    .slide-title { margin: 0; font-size: 32px; font-weight: 700; letter-spacing: -0.025em; line-height: 1.18; }
    .slide-sub { margin: 6px 0 0; font-size: 15px; color: #5E6469; }

    .showcase {
      display: grid;
      grid-template-columns: 400px 1fr;
      gap: 28px;
      align-items: center;
      height: 604px;
    }
    .popup-stage {
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      height: 100%;
    }
    .popup-frame {
      background: #FAF9F5;
      border: 1px solid #D8D4CA;
      border-radius: 14px;
      overflow: hidden;
      box-shadow: 0 18px 42px rgba(22, 25, 29, 0.13);
      display: inline-block;
    }
    .popup-frame img {
      display: block;
      width: 340px;
      height: auto;
      max-height: 556px;
      object-fit: contain;
    }
    .stages-panel {
      background: #FDFDFB;
      border: 1px solid #DFDCD4;
      border-radius: 16px;
      padding: 22px 24px;
      height: 556px;
      display: flex;
      flex-direction: column;
      justify-content: space-between;
      box-shadow: 0 8px 26px rgba(22, 25, 29, 0.05);
    }
    .panel-head {
      display: flex;
      align-items: baseline;
      justify-content: space-between;
      border-bottom: 1px solid #E9E6DE;
      padding-bottom: 12px;
    }
    .panel-head h2 { margin: 0; font-size: 19px; font-weight: 700; color: #16191D; }
    .panel-head span { font-size: 13px; color: #5E6469; }
    .stages-grid {
      display: grid;
      grid-template-columns: repeat(3, 1fr);
      gap: 14px;
      margin-top: 14px;
      flex: 1;
    }
    .stage-card {
      background: #FAF9F5;
      border: 1px solid #E4E1D9;
      border-radius: 12px;
      padding: 12px 12px 10px;
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: space-between;
      text-align: center;
    }
    .stage-card.is-active {
      background: #F3FAF8;
      border: 1.5px solid #1D6F63;
      box-shadow: 0 6px 18px rgba(29, 111, 99, 0.10);
    }
    .stage-card.is-wide { grid-column: span 1; }
    .stage-art {
      width: 112px;
      height: 112px;
      display: flex;
      align-items: center;
      justify-content: center;
    }
    .stage-art img { max-width: 100%; max-height: 100%; object-fit: contain; display: block; }
    .stage-title { font-size: 15px; font-weight: 700; color: #16191D; margin-top: 4px; }
    .stage-en { font-weight: 500; font-size: 12.5px; color: #5E6469; margin-left: 4px; }
    .stage-range {
      margin-top: 2px;
      font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
      font-size: 11.5px;
      color: #5E6469;
    }
    .stage-badge {
      margin-top: 5px;
      font-size: 11.5px;
      font-weight: 600;
      padding: 2px 9px;
      border-radius: 999px;
      background: #E9E6DE;
      color: #363B40;
    }
    .stage-card.is-active .stage-badge {
      background: #1D6F63;
      color: #FAF9F5;
    }
    .stage-footer-note {
      margin-top: 12px;
      padding-top: 10px;
      border-top: 1px solid #E9E6DE;
      display: flex;
      justify-content: space-between;
      font-size: 12.5px;
      color: #5E6469;
    }
    `,
    `
    <div>
      <div class="eyebrow">Popup 快审与阶段伴侣</div>
      <h1 class="slide-title">极简弹窗一秒核查，五阶段静貘随清净成长</h1>
      <p class="slide-sub">随时放行误拦或信任账号，幼貘到栖星按累计拦截数单向演进，只升不降</p>
    </div>

    <div class="showcase">
      <div class="popup-stage">
        <div class="popup-frame">
          <img src="/captures/popup.png" alt="Baku real popup UI" />
        </div>
      </div>

      <section class="stages-panel">
        <div class="panel-head">
          <h2>五阶段伴侣演进</h2>
          <span>按本机累计拦截数自动成长 · 点击静貘可互动</span>
        </div>
        <div class="stages-grid">
          ${stages
            .map(
              (s) => `
            <div class="stage-card${s.active ? ' is-active' : ''}">
              <div class="stage-art"><img src="/docs-assets/stages/${s.img}" alt="${s.name}" /></div>
              <div>
                <div class="stage-title">${s.name}<span class="stage-en">${s.en}</span></div>
                <div class="stage-range">${s.range}</div>
                <div class="stage-badge">${s.desc}</div>
              </div>
            </div>`
            )
            .join('')}
          <div class="stage-card" style="background:#FAF9F5;border-style:dashed;justify-content:center;gap:8px;padding:16px;">
            <div style="font-size:14px;font-weight:700;color:#16191D;">克制不打扰</div>
            <div style="font-size:12px;line-height:1.55;color:#5E6469;">只留 2px 霁青细进度线与单行提示，绝不往 X 页面弹窗催促打卡</div>
          </div>
        </div>
        <div class="stage-footer-note">
          <span>左图直接采自扩展真实 Popup 界面</span>
          <span>支持快速放行、信任账号与直达管理台</span>
        </div>
      </section>
    </div>
    `
  );
}

function renderShot04Html() {
  return baseDoc(
    'Shot 04 - Dashboard Audit',
    `
    body {
      width: 1280px;
      height: 800px;
      background: #FAF9F5;
      color: #16191D;
      padding: 26px 44px 22px;
      display: flex;
      flex-direction: column;
      justify-content: space-between;
    }
    .slide-head { display: flex; align-items: flex-end; justify-content: space-between; gap: 20px; }
    .eyebrow {
      display: inline-flex; align-items: center; gap: 8px;
      padding: 4px 12px; border-radius: 999px;
      background: rgba(29, 111, 99, 0.10);
      border: 1px solid rgba(29, 111, 99, 0.22);
      color: #1D6F63; font-size: 12.5px; font-weight: 600; margin-bottom: 8px;
    }
    .slide-title { margin: 0; font-size: 31px; font-weight: 700; letter-spacing: -0.025em; line-height: 1.18; }
    .slide-sub { margin: 5px 0 0; font-size: 14.5px; color: #5E6469; }
    .feature-pills { display: flex; gap: 8px; }
    .pill {
      padding: 6px 12px; border-radius: 999px;
      background: #FDFDFB; border: 1px solid #DFDCD4;
      font-size: 12px; font-weight: 500; color: #363B40; white-space: nowrap;
    }

    .browser-frame {
      background: #FAF9F5;
      border: 1px solid #D6D2C8;
      border-radius: 14px;
      overflow: hidden;
      box-shadow: 0 18px 46px rgba(22, 25, 29, 0.10);
      height: 626px;
      display: flex;
      flex-direction: column;
    }
    .browser-chrome {
      height: 36px;
      background: #F1EFE9;
      border-bottom: 1px solid #DFDCD4;
      padding: 0 14px;
      display: flex;
      align-items: center;
      justify-content: space-between;
      flex-shrink: 0;
    }
    .dots { display: flex; gap: 6px; }
    .dots span { width: 9px; height: 9px; border-radius: 50%; background: #CCC8BD; }
    .addr {
      font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
      font-size: 11.5px; color: #5E6469;
      background: #FAF9F5; border: 1px solid #DFDCD4;
      padding: 2px 12px; border-radius: 999px;
    }
    .shot-wrap { flex: 1; overflow: hidden; background: #FAF9F5; }
    .shot-wrap img { width: 100%; height: auto; display: block; }
    `,
    `
    <div class="slide-head">
      <div>
        <div class="eyebrow">管理台审计与名单</div>
        <h1 class="slide-title">最近拦截全量检索，黑白名单随时备份</h1>
        <p class="slide-sub">完整记录每条拦截来源与原文，支持搜索 @账号或正文、单条放行、拉黑与 JSON 导入导出</p>
      </div>
      <div class="feature-pills">
        <span class="pill">全文检索</span>
        <span class="pill">5 秒可撤销</span>
        <span class="pill">JSON 导入导出</span>
      </div>
    </div>

    <div class="browser-frame">
      <div class="browser-chrome">
        <div class="dots"><span></span><span></span><span></span></div>
        <span class="addr">chrome-extension://baku/src/dashboard.html#feedback</span>
        <span style="width:42px;"></span>
      </div>
      <div class="shot-wrap">
        <img src="/captures/dash_feedback.png" alt="Baku real dashboard recent interceptions UI" />
      </div>
    </div>
    `
  );
}

function renderShot05Html() {
  return baseDoc(
    'Shot 05 - Privacy and Cloud Modes',
    `
    body {
      width: 1280px;
      height: 800px;
      background: #FAF9F5;
      color: #16191D;
      padding: 26px 44px 22px;
      display: flex;
      flex-direction: column;
      justify-content: space-between;
    }
    .slide-head { display: flex; align-items: flex-end; justify-content: space-between; gap: 20px; }
    .eyebrow {
      display: inline-flex; align-items: center; gap: 8px;
      padding: 4px 12px; border-radius: 999px;
      background: rgba(29, 111, 99, 0.10);
      border: 1px solid rgba(29, 111, 99, 0.22);
      color: #1D6F63; font-size: 12.5px; font-weight: 600; margin-bottom: 8px;
    }
    .slide-title { margin: 0; font-size: 31px; font-weight: 700; letter-spacing: -0.025em; line-height: 1.18; color: #16191D; }
    .slide-sub { margin: 5px 0 0; font-size: 14.5px; color: #5E6469; }

    .browser-frame {
      background: #FAF9F5;
      border: 1px solid #D6D2C8;
      border-radius: 14px;
      overflow: hidden;
      box-shadow: 0 18px 46px rgba(22, 25, 29, 0.10);
      height: 594px;
      display: flex;
      flex-direction: column;
    }
    .browser-chrome {
      height: 34px;
      background: #F1EFE9;
      border-bottom: 1px solid #DFDCD4;
      padding: 0 14px;
      display: flex;
      align-items: center;
      justify-content: space-between;
      flex-shrink: 0;
    }
    .dots { display: flex; gap: 6px; }
    .dots span { width: 9px; height: 9px; border-radius: 50%; background: #CCC8BD; }
    .addr {
      font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
      font-size: 11.5px; color: #5E6469;
      background: #FAF9F5; border: 1px solid #DFDCD4;
      padding: 2px 12px; border-radius: 999px;
    }
    .shot-wrap { flex: 1; overflow: hidden; background: #FAF9F5; }
    .shot-wrap img { width: 100%; height: auto; display: block; }

    .trust-strip {
      display: grid;
      grid-template-columns: repeat(3, 1fr);
      gap: 14px;
    }
    .trust-chip {
      padding: 9px 14px;
      border-radius: 10px;
      background: #FDFDFB;
      border: 1px solid #DFDCD4;
      display: flex;
      align-items: center;
      gap: 9px;
      font-size: 12.5px;
      color: #363B40;
      box-shadow: 0 2px 6px rgba(22, 25, 29, 0.03);
    }
    .trust-dot { width: 7px; height: 7px; border-radius: 50%; background: #1D6F63; flex-shrink: 0; }
    `,
    `
    <div class="slide-head">
      <div>
        <div class="eyebrow">数据透明 · 自由切换</div>
        <h1 class="slide-title">开箱连接共享服务，也可随时切回纯本机</h1>
        <p class="slide-sub">只改写当前页面元素，不动 X 登录状态与原生屏蔽列表；支持自建后端与自有接口密钥</p>
      </div>
    </div>

    <div class="browser-frame">
      <div class="browser-chrome">
        <div class="dots"><span></span><span></span><span></span></div>
        <span class="addr">chrome-extension://baku/src/dashboard.html#cloud</span>
        <span style="width:42px;"></span>
      </div>
      <div class="shot-wrap">
        <img src="/captures/dash_cloud.png" alt="Baku real cloud and privacy settings UI" />
      </div>
    </div>

    <div class="trust-strip">
      <div class="trust-chip"><span class="trust-dot"></span><span>MIT 协议完整开源 · 代码与判别策略全公开</span></div>
      <div class="trust-chip"><span class="trust-dot"></span><span>可随时关闭云端 · 仅凭本机黑白名单运行</span></div>
      <div class="trust-chip"><span class="trust-dot"></span><span>不读取 X 登录令牌与私信 · 不改动原生关注</span></div>
    </div>
    `
  );
}

function renderTileHtml() {
  return baseDoc(
    'Store Tile 440x280',
    `
    body {
      width: 440px;
      height: 280px;
      background: radial-gradient(circle at 15% 15%, rgba(83, 229, 206, 0.22), transparent 52%), #0F1215;
      color: #F0EEE9;
      padding: 20px 22px;
      display: grid;
      grid-template-columns: 1.05fr 0.95fr;
      gap: 16px;
      align-items: center;
    }
    .left {
      display: flex;
      flex-direction: column;
      align-items: flex-start;
      justify-content: center;
    }
    .icon-wrap {
      width: 68px;
      height: 68px;
      border-radius: 16px;
      border: 1px solid rgba(255, 255, 255, 0.16);
      overflow: hidden;
      margin-bottom: 14px;
      box-shadow: 0 8px 22px rgba(0, 0, 0, 0.4);
    }
    .icon-wrap img { width: 100%; height: 100%; display: block; }
    .brand {
      margin: 0;
      font-size: 20px;
      font-weight: 700;
      letter-spacing: -0.02em;
      line-height: 1.15;
      color: #FAF9F5;
    }
    .tagline {
      margin: 7px 0 0;
      font-size: 13px;
      line-height: 1.45;
      color: #A9B5BC;
    }
    .pill {
      margin-top: 12px;
      padding: 3px 9px;
      border-radius: 999px;
      background: rgba(83, 229, 206, 0.14);
      border: 1px solid rgba(83, 229, 206, 0.30);
      color: #53E5CE;
      font-size: 11px;
      font-weight: 600;
    }
    .right-card {
      background: #171D23;
      border: 1px solid rgba(255, 255, 255, 0.14);
      border-radius: 12px;
      padding: 12px;
      height: 228px;
      display: flex;
      flex-direction: column;
      justify-content: space-between;
      box-shadow: 0 12px 26px rgba(0, 0, 0, 0.4);
    }
    .mini-top {
      display: flex;
      align-items: center;
      justify-content: space-between;
      font-size: 11px;
      color: #8F989E;
      padding-bottom: 8px;
      border-bottom: 1px solid rgba(255, 255, 255, 0.08);
    }
    .mini-top img { width: 22px; height: 22px; border-radius: 5px; display: block; }
    .mini-slop {
      background: rgba(184, 59, 42, 0.14);
      border: 1px dashed rgba(224, 120, 103, 0.45);
      border-radius: 8px;
      padding: 8px 9px;
      font-size: 11px;
      color: #E8A398;
      display: flex;
      align-items: center;
      justify-content: space-between;
    }
    .mini-clean {
      background: #1E2730;
      border: 1px solid rgba(94, 194, 178, 0.34);
      border-radius: 8px;
      padding: 9px 10px;
    }
    .mini-clean-head {
      font-size: 10.5px;
      font-weight: 600;
      color: #53E5CE;
      margin-bottom: 4px;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .mini-clean-txt { font-size: 11.5px; line-height: 1.45; color: #E7E9EA; }
    `,
    `
    <div class="left">
      <div class="icon-wrap"><img src="/docs-assets/baku-icon.png" alt="Baku" /></div>
      <h1 class="brand">Baku for X Slop</h1>
      <p class="tagline">安静清掉 X 评论区水帖</p>
      <span class="pill">无痕隐藏 · 开源免费</span>
    </div>
    <div class="right-card">
      <div class="mini-top">
        <span>X 评论区</span>
        <img src="/captures/icon-active-6.png" alt="6" />
      </div>
      <div class="mini-slop">
        <span>AI 复读 · 引流广告</span>
        <span>已收起</span>
      </div>
      <div class="mini-clean">
        <div class="mini-clean-head">@alice_systems · 真人回复</div>
        <div class="mini-clean-txt">批大小设为 25 最稳，P95 延迟直接降到 18ms。</div>
      </div>
    </div>
    `
  );
}

function renderPromoHtml() {
  return baseDoc(
    'Store Promo 1280x800',
    `
    body {
      width: 1280px;
      height: 800px;
      background: radial-gradient(circle at 12% 18%, rgba(83, 229, 206, 0.18), transparent 44%),
                  radial-gradient(circle at 88% 82%, rgba(29, 111, 99, 0.20), transparent 46%),
                  #0F1215;
      color: #F0EEE9;
      padding: 64px 72px;
      display: grid;
      grid-template-columns: 1.02fr 0.98fr;
      gap: 54px;
      align-items: center;
    }
    .icon-box {
      width: 132px;
      height: 132px;
      border-radius: 30px;
      border: 1.5px solid rgba(255, 255, 255, 0.16);
      overflow: hidden;
      margin-bottom: 28px;
      box-shadow: 0 20px 44px rgba(0, 0, 0, 0.48);
    }
    .icon-box img { width: 100%; height: 100%; display: block; }
    .brand {
      margin: 0;
      font-size: 56px;
      font-weight: 700;
      letter-spacing: -0.03em;
      line-height: 1.08;
      color: #FAF9F5;
    }
    .headline {
      margin: 16px 0 0;
      font-size: 26px;
      font-weight: 500;
      color: #DCE2E6;
      line-height: 1.38;
    }
    .pills {
      margin-top: 28px;
      display: flex;
      flex-wrap: wrap;
      gap: 10px;
    }
    .pill {
      padding: 7px 14px;
      border-radius: 999px;
      background: rgba(83, 229, 206, 0.12);
      border: 1px solid rgba(83, 229, 206, 0.28);
      color: #53E5CE;
      font-size: 14px;
      font-weight: 600;
    }

    .demo-card {
      background: #151D24;
      border: 1px solid rgba(255, 255, 255, 0.14);
      border-radius: 18px;
      padding: 24px;
      box-shadow: 0 24px 60px rgba(0, 0, 0, 0.5);
      display: flex;
      flex-direction: column;
      gap: 14px;
    }
    .demo-top {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding-bottom: 14px;
      border-bottom: 1px solid rgba(255, 255, 255, 0.08);
    }
    .demo-top-title { font-size: 14px; font-weight: 600; color: #9AA7B3; }
    .demo-ext {
      display: inline-flex;
      align-items: center;
      gap: 9px;
      padding: 5px 12px 5px 6px;
      border-radius: 999px;
      background: rgba(83, 229, 206, 0.10);
      border: 1px solid rgba(83, 229, 206, 0.28);
      font-size: 13px;
      font-weight: 600;
      color: #53E5CE;
    }
    .demo-ext img { width: 24px; height: 24px; border-radius: 6px; display: block; }
    .slop-fade {
      background: rgba(184, 59, 42, 0.11);
      border: 1px dashed rgba(224, 120, 103, 0.40);
      border-radius: 12px;
      padding: 13px 16px;
      display: flex;
      align-items: center;
      justify-content: space-between;
      font-size: 13.5px;
      color: #E39F94;
    }
    .slop-fade span.tag {
      font-size: 11.5px; font-weight: 600; padding: 3px 9px; border-radius: 999px;
      background: rgba(224, 120, 103, 0.18); color: #F2B6AC;
    }
    .human-card {
      background: #1B252F;
      border: 1px solid rgba(94, 194, 178, 0.34);
      border-radius: 12px;
      padding: 16px 18px;
      display: flex;
      gap: 12px;
    }
    .human-card img.av { width: 40px; height: 40px; border-radius: 50%; flex-shrink: 0; }
    .human-meta { font-size: 13.5px; color: #8F989E; margin-bottom: 5px; }
    .human-meta strong { color: #FAF9F5; margin-right: 6px; }
    .human-txt { font-size: 14.5px; line-height: 1.5; color: #E7E9EA; }
    `,
    `
    <div>
      <div class="icon-box"><img src="/docs-assets/baku-icon.png" alt="Baku" /></div>
      <h1 class="brand">Baku for X Slop</h1>
      <p class="headline">把 X 评论区的 AI 水帖安静收走<br/>只留下真正在说话的人</p>
      <div class="pills">
        <span class="pill">装上即跑</span>
        <span class="pill">无痕隐藏</span>
        <span class="pill">一击吞帖</span>
        <span class="pill">开源免费</span>
      </div>
    </div>

    <div class="demo-card">
      <div class="demo-top">
        <span class="demo-top-title">X 评论区静默过滤</span>
        <div class="demo-ext">
          <img src="/captures/icon-active-6.png" alt="6" />
          <span>本页已吞掉 6 条</span>
        </div>
      </div>

      <div class="slop-fade">
        <span>@insight_echo_ai · 「归根结底还是要回到商业闭环…」</span>
        <span class="tag">已隐藏</span>
      </div>
      <div class="slop-fade">
        <span>@prompt_drops_hq · 「Comment FREE for DM prompts」</span>
        <span class="tag">已隐藏</span>
      </div>

      <div class="human-card">
        <img class="av" src="${avatarSvg('A', '#1D6F63')}" alt="" />
        <div>
          <div class="human-meta"><strong>Alice Chen</strong>@alice_systems</div>
          <div class="human-txt">实测把批大小拆成 25 条一组最稳，P95 延迟稳定在 18ms 左右。</div>
        </div>
      </div>

      <div class="human-card">
        <img class="av" src="${avatarSvg('K', '#2E4C6D')}" alt="" />
        <div>
          <div class="human-meta"><strong>Kenji</strong>@kenji_rust</div>
          <div class="human-txt">控制好单次 SQL 参数绑定上限后，冷启动也几乎感觉不到抖动。</div>
        </div>
      </div>
    </div>
    `
  );
}

function startAssetServer(captureMap) {
  const shim = buildChromeShimScript();
  const pages = {
    '/capture/01.html': renderShot01Html,
    '/capture/02.html': renderShot02Html,
    '/capture/03.html': renderShot03Html,
    '/capture/04.html': renderShot04Html,
    '/capture/05.html': renderShot05Html,
    '/capture/tile.html': renderTileHtml,
    '/capture/promo.html': renderPromoHtml,
  };

  const server = http.createServer((req, res) => {
    const reqPath = decodeURIComponent((req.url || '/').split('?')[0]);
    if (pages[reqPath]) {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(pages[reqPath]());
      return;
    }

    if (reqPath.startsWith('/captures/')) {
      const name = reqPath.slice('/captures/'.length);
      const filePath = captureMap[name];
      if (filePath && existsSync(filePath)) {
        res.writeHead(200, { 'Content-Type': 'image/png' });
        res.end(readFileSync(filePath));
        return;
      }
    }

    let diskPath = null;
    if (reqPath.startsWith('/docs-assets/')) {
      diskPath = resolve(DOCS_ASSETS_DIR, reqPath.slice('/docs-assets/'.length));
      if (!diskPath.startsWith(DOCS_ASSETS_DIR)) diskPath = null;
    } else {
      diskPath = resolve(EXT_DIR, reqPath.replace(/^\/+/, ''));
      if (!diskPath.startsWith(EXT_DIR)) diskPath = null;
    }

    if (!diskPath || !existsSync(diskPath)) {
      res.writeHead(404);
      res.end('Not Found');
      return;
    }

    if (reqPath === '/src/popup.html' || reqPath === '/src/dashboard.html') {
      const html = readFileSync(diskPath, 'utf8').replace(
        '<script src="shared.js"></script>',
        `${shim}\n  <script src="shared.js"></script>`
      );
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(html);
      return;
    }

    const mime = MIME_TYPES[extname(diskPath)] || 'application/octet-stream';
    res.writeHead(200, { 'Content-Type': mime });
    res.end(readFileSync(diskPath));
  });

  return new Promise((resolvePromise) => {
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      resolvePromise({ server, baseUrl: `http://127.0.0.1:${addr.port}` });
    });
  });
}

async function captureChrome(url, outFile, width, height, scale = 2) {
  const profileDir = join(TMP_DIR, 'chrome-profile');
  mkdirSync(profileDir, { recursive: true });
  await execFileAsync(
    CHROME_BIN,
    [
      '--headless=new',
      '--disable-gpu',
      '--no-first-run',
      '--no-default-browser-check',
      '--hide-scrollbars',
      `--user-data-dir=${profileDir}`,
      `--force-device-scale-factor=${scale}`,
      `--window-size=${width},${height}`,
      '--virtual-time-budget=2500',
      `--screenshot=${outFile}`,
      url,
    ],
    { timeout: 25000 }
  );
}

function finalizeRgbPng(srcPath, destPath, targetW, targetH) {
  execFileSync(
    'python3',
    [
      '-c',
      `from PIL import Image
im = Image.open(${JSON.stringify(srcPath)}).convert('RGB')
if im.size != (${targetW}, ${targetH}):
    im = im.resize((${targetW}, ${targetH}), Image.Resampling.LANCZOS)
im.save(${JSON.stringify(destPath)}, format='PNG', optimize=True)
print('SAVED', ${JSON.stringify(destPath)}, im.size, im.mode)`,
    ],
    { stdio: 'inherit' }
  );
}

function trimPopupBottom(srcPath, destPath) {
  execFileSync(
    'python3',
    [
      '-c',
      `from PIL import Image
im = Image.open(${JSON.stringify(srcPath)}).convert('RGB')
bg = im.getpixel((4, 4))
w, h = im.size
px = im.load()
last_non_bg = 0
for y in range(h - 1, -1, -1):
    row_diff = False
    for x in range(0, w, 4):
        r, g, b = px[x, y]
        if abs(r - bg[0]) + abs(g - bg[1]) + abs(b - bg[2]) > 8:
            row_diff = True
            break
    if row_diff:
        last_non_bg = y
        break
crop_h = min(h, last_non_bg + 32)
im.crop((0, 0, w, crop_h)).save(${JSON.stringify(destPath)}, format='PNG')
print('POPUP_TRIMMED', (w, crop_h))`,
    ],
    { stdio: 'inherit' }
  );
}

async function main() {
  if (!existsSync(CHROME_BIN)) {
    throw new Error(`找不到 Chrome 可执行文件: ${CHROME_BIN}`);
  }
  rmSync(TMP_DIR, { recursive: true, force: true });
  mkdirSync(TMP_DIR, { recursive: true });
  mkdirSync(STORE_DIR, { recursive: true });

  const icon6Path = buildRealCornerActiveIcon();
  const popupRaw = join(TMP_DIR, 'popup_raw.png');
  const popupTrimmed = join(TMP_DIR, 'popup.png');
  const dashFeedbackPath = join(TMP_DIR, 'dash_feedback.png');
  const dashCloudPath = join(TMP_DIR, 'dash_cloud.png');

  const captureMap = {
    'icon-active-6.png': icon6Path,
    'popup.png': popupTrimmed,
    'dash_feedback.png': dashFeedbackPath,
    'dash_cloud.png': dashCloudPath,
  };

  const { server, baseUrl } = await startAssetServer(captureMap);
  try {
    console.log('[assets] 捕获真实扩展 Popup 与管理台界面...');
    await captureChrome(`${baseUrl}/src/popup.html`, popupRaw, 360, 620, 2);
    trimPopupBottom(popupRaw, popupTrimmed);

    await captureChrome(`${baseUrl}/src/dashboard.html#feedback`, dashFeedbackPath, 1220, 602, 2);
    await captureChrome(`${baseUrl}/src/dashboard.html#cloud`, dashCloudPath, 1320, 620, 2);

    const realOnly = process.argv.includes('--real-only');
    const allTargets = [
      { id: '01', url: `${baseUrl}/capture/01.html`, out: join(STORE_DIR, '01-x-before-after.png'), w: 1280, h: 800, real: false },
      { id: '02', url: `${baseUrl}/capture/02.html`, out: join(STORE_DIR, '02-one-click-eat-and-mask.png'), w: 1280, h: 800, real: false },
      { id: '03', url: `${baseUrl}/capture/03.html`, out: join(STORE_DIR, '03-popup-and-stages.png'), w: 1280, h: 800, real: true },
      { id: '04', url: `${baseUrl}/capture/04.html`, out: join(STORE_DIR, '04-dashboard-audit.png'), w: 1280, h: 800, real: true },
      { id: '05', url: `${baseUrl}/capture/05.html`, out: join(STORE_DIR, '05-privacy-and-modes.png'), w: 1280, h: 800, real: true },
      { id: 'tile', url: `${baseUrl}/capture/tile.html`, out: join(DOCS_ASSETS_DIR, 'baku-store-tile-440x280.png'), w: 440, h: 280, real: false },
      { id: 'promo', url: `${baseUrl}/capture/promo.html`, out: join(DOCS_ASSETS_DIR, 'baku-store-promo-1280x800.png'), w: 1280, h: 800, real: false },
    ];
    const targets = realOnly ? allTargets.filter((t) => t.real) : allTargets;

    for (let i = 0; i < targets.length; i += 1) {
      const t = targets[i];
      const rawOut = join(TMP_DIR, `raw_${i}.png`);
      await captureChrome(t.url, rawOut, t.w, t.h, 2);
      finalizeRgbPng(rawOut, t.out, t.w, t.h);
    }
  } finally {
    server.close();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
