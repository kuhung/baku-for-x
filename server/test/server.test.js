import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createAppServer } from '../src/index.js';
import { AiVerifier } from '../../worker/src/aiVerifier.js';

function createTempDbPath() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'anti-slop-flywheel-'));
  return path.join(dir, 'flywheel.sqlite');
}

async function startTestServer(options = {}) {
  const dbFile = options.dbFile ?? createTempDbPath();
  const app = createAppServer({ reportQuorum: 2, ...options, dbFile });
  await new Promise((resolve) => app.server.listen(0, '127.0.0.1', resolve));
  const addr = app.server.address();
  const baseUrl = `http://127.0.0.1:${addr.port}`;
  return {
    ...app,
    baseUrl,
    close: async () => {
      await new Promise((resolve) => app.server.close(resolve));
      app.db.close();
    },
  };
}

test('GET /health and GET /api/v1/stats return two-tier flywheel configuration and counts', async () => {
  const srv = await startTestServer({
    reportQuorum: 2,
    escalationThreshold: 3,
    aiDailyItemLimit: 4000,
    aiVerifier: new AiVerifier({ apiKey: '' }),
  });
  try {
    const health = await (await fetch(`${srv.baseUrl}/health`)).json();
    assert.equal(health.ok, true);
    assert.equal(health.service, 'anti-slop-flywheel');
    assert.equal(health.aiConfigured, false);
    assert.equal(health.reportQuorum, 2);
    assert.equal(health.escalationThreshold, 3);
    assert.equal(health.aiDailyItemLimit, 4000);
    assert.equal(health.blacklistCount, 0);
    assert.equal(health.slopPostCount, 0);
    assert.equal(health.cachedPostCount, 0);

    const stats = await (await fetch(`${srv.baseUrl}/api/v1/stats`)).json();
    assert.equal(stats.ok, true);
    assert.equal(stats.sampleCount, 0);
    assert.equal(stats.todayAiCalls, 0);
    assert.equal(stats.todayAiItems, 0);
  } finally {
    await srv.close();
  }
});

test('Gemini Decision 1 batch classify evaluates multiple posts in 1 request, caches post_decisions, and escalates repeat offenders at threshold 3', async () => {
  let aiCalls = 0;
  const mockGemini = new AiVerifier({
    geminiKey: 'gm-test-key',
    fetchImpl: async (url, init) => {
      aiCalls += 1;
      assert.equal(url, 'https://generativelanguage.googleapis.com/v1beta/decisions');
      assert.equal(init.headers['x-goog-api-key'], 'gm-test-key');
      const body = JSON.parse(init.body);
      assert.equal(body.model, 'gemini-decision-1');
      assert.ok(typeof body.input === 'string' && body.input.includes('[0]'));
      assert.ok(typeof body.questions?.p_0_slop?.criteria?.true_description === 'string');
      if (aiCalls === 1) {
        assert.ok(body.input.includes('SharedParentPost (@focal_op): New Gemini Decision model benchmarked'));
        assert.ok(body.input.includes('VerifiedBlue: yes'));
      }

      const answers = {};
      for (const qKey of Object.keys(body.questions)) {
        if (qKey.endsWith('_slop')) {
          const idx = Number(qKey.split('_')[1]);
          const isClean = body.input.includes(`[${idx}] Handle: @alice_dev`);
          answers[qKey] = { type: 'noul', noul: isClean ? 0.04 : 0.92, confidence: 0.95 };
        }
      }
      return new Response(JSON.stringify({ answers }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    },
  });

  const srv = await startTestServer({
    escalationThreshold: 3,
    aiVerifier: mockGemini,
  });

  try {
    // Batch 1: 2 slop posts from @repeat_bot + 1 clean post from @alice_dev -> 1 single AI request
    const b1 = await (
      await fetch(`${srv.baseUrl}/api/v1/classify/batch`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          items: [
            {
              tweetId: '100001',
              handle: 'repeat_bot',
              isReply: true,
              isVerified: true,
              parentHandle: 'focal_op',
              parentText: 'New Gemini Decision model benchmarked',
              text: 'Comment FREE for AI prompts!',
            },
            { tweetId: '100002', handle: 'repeat_bot', isReply: true, text: 'Drop your ETH wallet to claim!' },
            { tweetId: '100003', handle: 'alice_dev', isReply: true, text: 'Debugging D1 SQLite indexes today.' },
          ],
        }),
      })
    ).json();

    assert.equal(aiCalls, 1);
    assert.equal(b1.results[0].verdict, 'SLOP');
    assert.equal(b1.results[0].scope, 'TWEET');
    assert.equal(b1.results[0].slopProb, 0.92);
    assert.equal(b1.results[1].verdict, 'SLOP');
    assert.equal(b1.results[1].scope, 'TWEET');
    assert.equal(b1.results[2].verdict, 'ALLOW');

    // Ring-buffer decision_logs recorded all 3 AI-evaluated items with context
    const logRows = await srv.db.prepare('SELECT handle, is_reply, is_verified, verdict, slop_prob, parent_excerpt FROM decision_logs ORDER BY id ASC').all();
    assert.equal(logRows.results.length, 3);
    assert.equal(logRows.results[0].is_reply, 1);
    assert.equal(logRows.results[0].is_verified, 1);
    assert.equal(logRows.results[0].slop_prob, 0.92);
    assert.ok(logRows.results[0].parent_excerpt.includes('New Gemini Decision model'));

    // Batch 2: Resending the exact same tweetIds hits post_cache with 0 AI calls
    const b2 = await (
      await fetch(`${srv.baseUrl}/api/v1/classify/batch`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          items: [
            { tweetId: '100001', handle: 'repeat_bot', text: 'Comment FREE for AI prompts!' },
            { tweetId: '100003', handle: 'alice_dev', text: 'Debugging D1 SQLite indexes today.' },
          ],
        }),
      })
    ).json();
    assert.equal(aiCalls, 1);
    assert.equal(b2.results[0].source, 'post_cache');
    assert.equal(b2.results[0].verdict, 'SLOP');
    assert.equal(b2.results[1].source, 'post_cache');
    assert.equal(b2.results[1].verdict, 'ALLOW');

    // Batch 3: 3rd slop post from @repeat_bot triggers L1 -> L2 escalation into blacklist
    await fetch(`${srv.baseUrl}/api/v1/classify/batch`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        items: [{ tweetId: '100004', handle: 'repeat_bot', text: 'Like + RT + Follow for $GEM!' }],
      }),
    });
    assert.equal(aiCalls, 2);

    const bl = await (await fetch(`${srv.baseUrl}/api/v1/blacklist`)).json();
    assert.equal(bl.accounts.length, 1);
    assert.equal(bl.accounts[0].handle, 'repeat_bot');
    assert.equal(bl.accounts[0].source, 'post_escalation');

    // Batch 4: New post from @repeat_bot now hits L2 blacklist directly without calling AI
    const b4 = await (
      await fetch(`${srv.baseUrl}/api/v1/classify/batch`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          items: [{ tweetId: '100005', handle: 'repeat_bot', text: 'Good morning!' }],
        }),
      })
    ).json();
    assert.equal(aiCalls, 2);
    assert.equal(b4.results[0].verdict, 'SLOP');
    assert.equal(b4.results[0].scope, 'ACCOUNT');
    assert.equal(b4.results[0].source, 'blacklist');
  } finally {
    await srv.close();
  }
});

test('Single-reporter BLOCK_ACCOUNT aggregates historical samples for Gemini Decision, and downgrades occasional noisy author to L1', async () => {
  const capturedInputs = [];
  const mockGemini = new AiVerifier({
    geminiKey: 'gm-test-key',
    fetchImpl: async (_url, init) => {
      const body = JSON.parse(init.body);
      capturedInputs.push(body.input);
      const isDedicatedBot = body.input.includes('@dedicated_bot');
      return new Response(
        JSON.stringify({
          answers: {
            is_slop_account: {
              type: 'noul',
              noul: isDedicatedBot ? 0.93 : 0.25,
              confidence: 0.92,
            },
            post_is_slop: {
              type: 'noul',
              noul: 0.88,
              confidence: 0.9,
            },
            account_severity: {
              type: 'score',
              score: isDedicatedBot ? 2.8 : 1.0,
            },
          },
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      );
    },
  });

  const srv = await startTestServer({
    reportQuorum: 2,
    aiVerifier: mockGemini,
  });

  try {
    // Prior single-tweet report builds sample history for @dedicated_bot
    await fetch(`${srv.baseUrl}/api/v1/signal`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        type: 'BLOCK_TWEET',
        handle: 'dedicated_bot',
        tweetId: '200001',
        text: 'Comment AI for my Notion template',
        clientId: 'user-a',
      }),
    });

    // 1st account report on @dedicated_bot -> pulls historical samples + promotes to blacklist
    const accRes = await (
      await fetch(`${srv.baseUrl}/api/v1/signal`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          type: 'BLOCK_ACCOUNT',
          handle: 'dedicated_bot',
          tweetId: '200002',
          text: 'Drop your ETH wallet now!',
          clientId: 'user-a',
        }),
      })
    ).json();
    assert.equal(accRes.ok, true);
    assert.equal(accRes.blacklisted, true);
    assert.equal(accRes.aiVerified, true);
    assert.ok(capturedInputs.some((inp) => inp.includes('Comment AI for my Notion template')));

    // 1st account report on @noisy_human -> account NOT blacklisted, but noisy post IS saved in L1 post_decisions
    const humanRes = await (
      await fetch(`${srv.baseUrl}/api/v1/signal`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          type: 'BLOCK_ACCOUNT',
          handle: 'noisy_human',
          tweetId: '200003',
          text: 'One clickbait post today',
          clientId: 'user-a',
        }),
      })
    ).json();
    assert.equal(humanRes.blacklisted, false);
    assert.equal(humanRes.postSlop, true);

    const batchCheck = await (
      await fetch(`${srv.baseUrl}/api/v1/classify/batch`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          items: [
            { tweetId: '200003', handle: 'noisy_human', text: 'One clickbait post today' },
            { tweetId: '200004', handle: 'noisy_human', text: 'Normal engineering writeup' },
          ],
        }),
      })
    ).json();
    assert.equal(batchCheck.results[0].verdict, 'SLOP');
    assert.equal(batchCheck.results[0].scope, 'TWEET');
    assert.equal(batchCheck.results[0].source, 'post_cache');
    assert.equal(batchCheck.results[1].verdict, 'ALLOW');
  } finally {
    await srv.close();
  }
});

test('Innocence-presumption appeals remove ai_verified, post_escalation, and quorum=2 accounts on 1 appeal, and APPEAL_TWEET flips post_decisions', async () => {
  let decisionShouldBeSlop = true;
  const mockGemini = new AiVerifier({
    geminiKey: 'gm-test-key',
    fetchImpl: async (_url, init) => {
      const body = JSON.parse(init.body);
      const answers = {};
      if (body.questions.is_slop_account) {
        answers.is_slop_account = { type: 'noul', noul: decisionShouldBeSlop ? 0.92 : 0.1, confidence: 0.95 };
        answers.post_is_slop = { type: 'noul', noul: 0.9, confidence: 0.95 };
        answers.account_severity = { type: 'score', score: decisionShouldBeSlop ? 3 : 0 };
      } else {
        for (const qKey of Object.keys(body.questions)) {
          if (qKey.endsWith('_slop')) {
            answers[qKey] = { type: 'noul', noul: decisionShouldBeSlop ? 0.92 : 0.1, confidence: 0.95 };
          }
        }
      }
      return new Response(JSON.stringify({ answers }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    },
  });

  const srv = await startTestServer({
    reportQuorum: 2,
    escalationThreshold: 3,
    aiVerifier: mockGemini,
  });

  try {
    // 1. ai_verified account removed by 1 appeal
    await fetch(`${srv.baseUrl}/api/v1/signal`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'BLOCK_ACCOUNT', handle: 'ai_mistake', tweetId: '300001', text: 'spammy?', clientId: 'u1' }),
    });
    const apAi = await (
      await fetch(`${srv.baseUrl}/api/v1/signal`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type: 'APPEAL_ACCOUNT', handle: 'ai_mistake', clientId: 'u2' }),
      })
    ).json();
    assert.equal(apAi.removedFromBlacklist, true);

    // 2. post_escalation account removed by 1 appeal
    await fetch(`${srv.baseUrl}/api/v1/classify/batch`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        items: [
          { tweetId: '300011', handle: 'esc_mistake', text: 'post 1' },
          { tweetId: '300012', handle: 'esc_mistake', text: 'post 2' },
          { tweetId: '300013', handle: 'esc_mistake', text: 'post 3' },
        ],
      }),
    });
    const beforeEscAppeal = await (await fetch(`${srv.baseUrl}/api/v1/blacklist`)).json();
    assert.equal(beforeEscAppeal.accounts.some((a) => a.handle === 'esc_mistake'), true);

    const apEsc = await (
      await fetch(`${srv.baseUrl}/api/v1/signal`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type: 'APPEAL_ACCOUNT', handle: 'esc_mistake', clientId: 'u2' }),
      })
    ).json();
    assert.equal(apEsc.removedFromBlacklist, true);

    // 3. quorum=2 account (2 reports) removed by 1 appeal (1 appeal offsets 2 reports -> 2 - 2*1 = 0 < 2)
    await fetch(`${srv.baseUrl}/api/v1/signal`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'BLOCK_ACCOUNT', handle: 'quorum_mistake', clientId: 'u1' }),
    });
    await fetch(`${srv.baseUrl}/api/v1/signal`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'BLOCK_ACCOUNT', handle: 'quorum_mistake', clientId: 'u2' }),
    });
    const fullCursor = (await (await fetch(`${srv.baseUrl}/api/v1/blacklist`)).json()).version;
    const apQuorum = await (
      await fetch(`${srv.baseUrl}/api/v1/signal`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type: 'APPEAL_ACCOUNT', handle: 'quorum_mistake', clientId: 'u3' }),
      })
    ).json();
    assert.equal(apQuorum.removedFromBlacklist, true);

    const delta = await (await fetch(`${srv.baseUrl}/api/v1/blacklist?sinceVersion=${fullCursor}`)).json();
    assert.equal(delta.incremental, true);
    assert.deepEqual(delta.removed, ['quorum_mistake']);

    // 4. APPEAL_TWEET flips cached post_decisions from SLOP -> ALLOW (appealed)
    const appealPost = await (
      await fetch(`${srv.baseUrl}/api/v1/signal`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type: 'APPEAL_TWEET', handle: 'esc_mistake', tweetId: '300011', clientId: 'u2' }),
      })
    ).json();
    assert.equal(appealPost.flippedToAllow, true);

    const recheck = await (
      await fetch(`${srv.baseUrl}/api/v1/classify/batch`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ items: [{ tweetId: '300011', handle: 'esc_mistake', text: 'post 1' }] }),
      })
    ).json();
    assert.equal(recheck.results[0].verdict, 'ALLOW');
    assert.equal(recheck.results[0].source, 'post_cache');
  } finally {
    await srv.close();
  }
});

test('Passwordless anti-abuse enforces IP limits and daily budget gracefully, and contradiction guard protects uncertain accounts', async () => {
  let aiCalls = 0;
  const mockAi = new AiVerifier({
    geminiKey: 'gm-test-key',
    fetchImpl: async () => {
      aiCalls += 1;
      return new Response(
        JSON.stringify({
          answers: {
            p_0_slop: { type: 'noul', noul: 0.9, confidence: 0.9 },
            p_1_slop: { type: 'noul', noul: 0.9, confidence: 0.9 },
          },
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      );
    },
  });

  // IP minute limit = 2 items
  const srv = await startTestServer({
    ipMinuteItemLimit: 2,
    ipDailyItemLimit: 10,
    aiDailyItemLimit: 10,
    aiVerifier: mockAi,
  });

  try {
    const okRes = await (
      await fetch(`${srv.baseUrl}/api/v1/classify/batch`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-forwarded-for': '203.0.113.5' },
        body: JSON.stringify({
          items: [
            { tweetId: '400001', handle: 'u1', text: 'post 1' },
            { tweetId: '400002', handle: 'u2', text: 'post 2' },
          ],
        }),
      })
    ).json();
    assert.equal(aiCalls, 1);
    assert.equal(okRes.results[0].verdict, 'SLOP');

    // Exceeding IP minute limit gracefully falls back to ALLOW without calling AI
    const limitedRes = await (
      await fetch(`${srv.baseUrl}/api/v1/classify/batch`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-forwarded-for': '203.0.113.5' },
        body: JSON.stringify({
          items: [{ tweetId: '400003', handle: 'u3', text: 'post 3' }],
        }),
      })
    ).json();
    assert.equal(aiCalls, 1);
    assert.equal(limitedRes.results[0].verdict, 'ALLOW');
    assert.equal(limitedRes.results[0].source, 'rate_limited_allow');
  } finally {
    await srv.close();
  }

  // Explicit allowPublicClassify='false' still enforces 403
  const lockedSrv = await startTestServer({
    allowPublicClassify: 'false',
    aiVerifier: new AiVerifier({ apiKey: '' }),
  });
  try {
    const res403 = await fetch(`${lockedSrv.baseUrl}/api/v1/classify/batch`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ items: [{ tweetId: '1', handle: 'test', text: 'hello' }] }),
    });
    assert.equal(res403.status, 403);
  } finally {
    await lockedSrv.close();
  }

  // Contradiction guard on verifyAccountCandidate
  const contradictory = new AiVerifier({
    geminiKey: 'gm-test-key',
    fetchImpl: async () =>
      new Response(
        JSON.stringify({
          answers: {
            is_slop_account: { type: 'noul', noul: 0.85, confidence: 0.9 },
            post_is_slop: { type: 'noul', noul: 0.85, confidence: 0.9 },
            account_severity: { type: 'score', score: 0.4 },
          },
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      ),
  });
  const check = await contradictory.verifyAccountCandidate({ handle: 'maybe_normal', text: 'Debugging streams' });
  assert.equal(check.verdict, 'UNCERTAIN');

  // Ring-buffer decision_logs enforces maxDecisionLogs cap
  const { FlywheelStore } = await import('../../worker/src/flywheelStore.js');
  const { createSqliteD1Database } = await import('../src/d1Sqlite.js');
  const ringDb = createSqliteD1Database(':memory:');
  try {
    const ringStore = new FlywheelStore(ringDb, { maxDecisionLogs: 50 });
    const rows = Array.from({ length: 65 }, (_, idx) => ({
      tweetId: `ring_${idx}`,
      handle: `user_${idx}`,
      isReply: true,
      isVerified: idx % 2 === 0,
      verdict: idx % 5 === 0 ? 'SLOP' : 'ALLOW',
      slopProb: idx / 100,
      confidence: 0.9,
      text: `Sample reply ${idx}`,
      parentText: 'Parent',
    }));
    await ringStore.appendDecisionLogs(rows);
    const cnt = await ringDb.prepare('SELECT COUNT(*) AS cnt, MIN(tweet_id) AS oldest FROM decision_logs').first();
    assert.equal(Number(cnt.cnt), 50);
    const firstRow = await ringDb.prepare('SELECT tweet_id FROM decision_logs ORDER BY id ASC LIMIT 1').first();
    assert.equal(firstRow.tweet_id, 'ring_15');
  } finally {
    ringDb.close();
  }
});

test('FlywheelStore maintains flywheel_counters via triggers, caches getStats, prunes without full scans, and runs 0 COUNT(*) queries', async () => {
  const { FlywheelStore } = await import('../../worker/src/flywheelStore.js');
  const { createSqliteD1Database } = await import('../src/d1Sqlite.js');

  const rawDb = createSqliteD1Database(':memory:');
  const executedSql = [];
  const trackedDb = {
    prepare(sql) {
      executedSql.push(sql);
      return rawDb.prepare(sql);
    },
    batch(stmts) {
      return rawDb.batch(stmts);
    },
    exec(sql) {
      executedSql.push(sql);
      return rawDb.exec(sql);
    },
    close() {
      rawDb.close();
    },
  };

  try {
    const store = new FlywheelStore(trackedDb, {
      reportQuorum: 2,
      escalationThreshold: 2,
      maxSamples: 100,
      maxPostDecisions: 100,
      maxDecisionLogs: 50,
      statsCacheTtlMs: 60_000,
    });

    await store.ensureSchema();
    executedSql.length = 0;

    // 1. Save 2 SLOP + 2 ALLOW decisions and verify counters
    await store.savePostDecisions([
      { tweetId: '100001', handle: 'bot_a', verdict: 'SLOP', confidence: 0.9, source: 'ai_model' },
      { tweetId: '100002', handle: 'bot_b', verdict: 'SLOP', confidence: 0.9, source: 'ai_model' },
      { tweetId: '100003', handle: 'clean_c', verdict: 'ALLOW', confidence: 0.9, source: 'ai_model' },
      { tweetId: '100004', handle: 'clean_d', verdict: 'ALLOW', confidence: 0.9, source: 'ai_model' },
    ]);

    // Upsert existing tweetId 100001 without changing verdict should keep counts unchanged
    await store.savePostDecisions([
      { tweetId: '100001', handle: 'bot_a', verdict: 'SLOP', confidence: 0.95, source: 'ai_model' },
    ]);

    // 2. APPEAL_TWEET flips 100001 from SLOP -> ALLOW (adds 1 sample, slopPostCount 2 -> 1, cachedPostCount stays 4)
    await store.recordSignal({ type: 'APPEAL_TWEET', handle: 'bot_a', tweetId: '100001', clientId: 'u1', text: 'false positive' });

    // 3. BLOCK_ACCOUNT reaching quorum activates blacklist (blacklistCount 0 -> 1, adds 2 samples)
    await store.recordSignal({ type: 'BLOCK_ACCOUNT', handle: 'spammer_x', tweetId: '100005', clientId: 'u1', text: 'spam 1' });
    await store.recordSignal({ type: 'BLOCK_ACCOUNT', handle: 'spammer_x', tweetId: '100006', clientId: 'u2', text: 'spam 2' });

    // Duplicate sample key (same clientId + signalType + handle + tweetId) should upsert without incrementing sampleCount
    await store.recordSignal({ type: 'BLOCK_ACCOUNT', handle: 'spammer_x', tweetId: '100005', clientId: 'u1', text: 'spam 1 edited' });

    executedSql.length = 0;
    const stats1 = await store.getStats();
    assert.equal(stats1.cachedPostCount, 4);
    assert.equal(stats1.slopPostCount, 1);
    assert.equal(stats1.blacklistCount, 1);
    assert.equal(stats1.blacklistVersion, 1);
    assert.equal(stats1.sampleCount, 3);
    assert.equal(
      executedSql.some((s) => /\bCOUNT\s*\(/i.test(s)),
      false,
      `getStats must not run COUNT(*), got: ${executedSql.join(' | ')}`
    );

    // Second getStats() within TTL hits in-memory cache with 0 DB queries
    executedSql.length = 0;
    const statsCached = await store.getStats();
    assert.deepEqual(statsCached, stats1);
    assert.equal(executedSql.length, 0);

    // 4. APPEAL_ACCOUNT deactivates blacklist (blacklistCount 1 -> 0, blacklistVersion 1 -> 2, adds 1 sample)
    await store.recordSignal({ type: 'APPEAL_ACCOUNT', handle: 'spammer_x', clientId: 'u3', text: 'not spam' });
    const statsAfterAppeal = await store.getStats();
    assert.equal(statsAfterAppeal.blacklistCount, 0);
    assert.equal(statsAfterAppeal.blacklistVersion, 2);
    assert.equal(statsAfterAppeal.sampleCount, 4);

    // UNBLOCK_ACCOUNT removes u1's FN_ACCOUNT sample (sampleCount 4 -> 3)
    await store.recordSignal({ type: 'UNBLOCK_ACCOUNT', handle: 'spammer_x', clientId: 'u1' });
    const statsAfterUnblock = await store.getStats();
    assert.equal(statsAfterUnblock.sampleCount, 3);

    // 5. Ring-buffer decision_logs enforces maxDecisionLogs with 0 COUNT(*) queries
    executedSql.length = 0;
    await store.appendDecisionLogs(
      Array.from({ length: 65 }, (_, idx) => ({
        tweetId: `no_count_${idx}`,
        handle: `u_${idx}`,
        verdict: idx % 2 === 0 ? 'SLOP' : 'ALLOW',
        slopProb: 0.5,
        confidence: 0.8,
        text: `text ${idx}`,
      }))
    );
    assert.equal(
      executedSql.some((s) => /\bCOUNT\s*\(/i.test(s)),
      false,
      'appendDecisionLogs must not run COUNT(*)'
    );
    const logCnt = await rawDb.prepare('SELECT COUNT(*) AS cnt FROM decision_logs').first();
    assert.equal(Number(logCnt.cnt), 50);

    // 6. getBlacklist with up-to-date sinceVersion skips the delta row query
    const currentBl = await store.getBlacklist();
    executedSql.length = 0;
    const deltaEmpty = await store.getBlacklist({ sinceVersion: currentBl.version });
    assert.equal(deltaEmpty.incremental, true);
    assert.deepEqual(deltaEmpty.accounts, []);
    assert.deepEqual(deltaEmpty.removed, []);
    assert.equal(executedSql.length, 1);

    // 7. maxPostDecisions & maxSamples pruning keep flywheel_counters accurate
    const smallStore = new FlywheelStore(createSqliteD1Database(':memory:'), {
      maxPostDecisions: 100,
      maxSamples: 100,
      statsCacheTtlMs: 0,
    });
    await smallStore.ensureSchema();
    await smallStore.savePostDecisions(
      Array.from({ length: 105 }, (_, i) => ({
        tweetId: `${200000 + i}`,
        handle: `h_${i}`,
        verdict: i === 0 ? 'SLOP' : 'ALLOW',
        confidence: 0.9,
        source: 'ai_model',
      }))
    );
    for (let i = 0; i < 103; i += 1) {
      await smallStore.recordSignal({
        type: 'BLOCK_TWEET',
        handle: `s_${i}`,
        tweetId: `${300000 + i}`,
        clientId: `c_${i}`,
        text: `slop sample ${i}`,
      });
    }
    const prunedStats = await smallStore.getStats();
    assert.equal(prunedStats.cachedPostCount, 100);
    assert.equal(prunedStats.slopPostCount, 1);
    assert.equal(prunedStats.sampleCount, 100);
    smallStore.db.close();
  } finally {
    trackedDb.close();
  }
});

test('FlywheelStore preserves context & original AI scores in flywheel_samples/post_decisions and migrates pre-0.2.2 schemas cleanly', async () => {
  const { FlywheelStore } = await import('../../worker/src/flywheelStore.js');
  const { createSqliteD1Database } = await import('../src/d1Sqlite.js');

  // 1. Test idempotent migration from pre-0.2.2 tables lacking the new columns
  const legacyDb = createSqliteD1Database(':memory:');
  try {
    await legacyDb.exec(`
      CREATE TABLE post_decisions (
        tweet_id TEXT PRIMARY KEY,
        handle TEXT NOT NULL DEFAULT '',
        verdict TEXT NOT NULL,
        confidence REAL NOT NULL DEFAULT 0,
        source TEXT NOT NULL DEFAULT 'ai_model',
        reason TEXT NOT NULL DEFAULT '',
        report_count INTEGER NOT NULL DEFAULT 0,
        appeal_count INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE flywheel_samples (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        signal_type TEXT NOT NULL,
        handle TEXT NOT NULL DEFAULT '',
        tweet_id TEXT NOT NULL DEFAULT '',
        display_name TEXT NOT NULL DEFAULT '',
        text TEXT NOT NULL DEFAULT '',
        quoted_text TEXT NOT NULL DEFAULT '',
        reason TEXT NOT NULL DEFAULT '',
        client_id TEXT NOT NULL,
        created_at TEXT NOT NULL,
        UNIQUE (client_id, signal_type, handle, tweet_id)
      );
    `);
    const legacyStore = new FlywheelStore(legacyDb, { statsCacheTtlMs: 0 });
    await legacyStore.ensureSchema();
    // Re-running migration should be a safe no-op
    await legacyStore._ensureColumnMigrations();

    await legacyStore.savePostDecisions([
      { tweetId: '500001', handle: 'legacy_u', verdict: 'SLOP', confidence: 0.81, slopProb: 0.81, source: 'ai_model' },
    ]);
    await legacyStore.recordSignal({
      type: 'APPEAL_TWEET',
      tweetId: '500001',
      handle: 'legacy_u',
      text: 'Short genuine reply',
      parentHandle: 'op_legacy',
      parentText: 'Parent body',
      quotedHandle: 'q_legacy',
      quotedText: 'Quoted body',
      isReply: true,
      isVerified: true,
      clientId: 'cli-1',
    });

    const migratedSample = await legacyDb
      .prepare('SELECT quoted_handle, parent_handle, parent_text, is_reply, is_verified, orig_verdict, orig_slop_prob, orig_source FROM flywheel_samples WHERE tweet_id = ?')
      .bind('500001')
      .first();
    assert.equal(migratedSample.quoted_handle, 'q_legacy');
    assert.equal(migratedSample.parent_handle, 'op_legacy');
    assert.equal(migratedSample.parent_text, 'Parent body');
    assert.equal(migratedSample.is_reply, 1);
    assert.equal(migratedSample.is_verified, 1);
    assert.equal(migratedSample.orig_verdict, 'SLOP');
    assert.equal(migratedSample.orig_slop_prob, 0.81);
    assert.equal(migratedSample.orig_source, 'ai_model');

    const postAfterAppeal = await legacyDb
      .prepare('SELECT verdict, source, slop_prob FROM post_decisions WHERE tweet_id = ?')
      .bind('500001')
      .first();
    assert.equal(postAfterAppeal.verdict, 'ALLOW');
    assert.equal(postAfterAppeal.source, 'appealed');
    assert.equal(postAfterAppeal.slop_prob, 0.81);
  } finally {
    legacyDb.close();
  }

  // 2. End-to-end HTTP test verifying slopProb in post_cache and context forwarding on BLOCK_TWEET / APPEAL_TWEET
  const capturedVerifierItems = [];
  let missedAiCalls = 0;
  const mockGemini = new AiVerifier({
    geminiKey: 'gm-test-key',
    fetchImpl: async (_url, init) => {
      const body = JSON.parse(init.body);
      capturedVerifierItems.push(body.input);
      const answers = {};
      if (body.input.includes('Appealable slop reply')) {
        answers.p_0_slop = { type: 'noul', noul: 0.83, confidence: 0.91 };
      } else if (body.input.includes('Missed AI slop')) {
        missedAiCalls += 1;
        answers.p_0_slop =
          missedAiCalls === 1
            ? { type: 'noul', noul: 0.31, confidence: 0.69 }
            : { type: 'noul', noul: 0.79, confidence: 0.88 };
      }
      return new Response(JSON.stringify({ answers }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    },
  });

  const srv = await startTestServer({ reportQuorum: 2, aiVerifier: mockGemini });
  try {
    // Classify SLOP item -> post_decisions stores slop_prob=0.83 -> APPEAL_TWEET snapshots SLOP/0.83 and preserves post_decisions.slop_prob
    await fetch(`${srv.baseUrl}/api/v1/classify/batch`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        items: [
          {
            tweetId: '500010',
            handle: 'human_replier',
            isReply: true,
            isVerified: true,
            parentHandle: 'focal_author',
            parentText: 'Thread context text',
            text: 'Appealable slop reply',
          },
        ],
      }),
    });

    const cachedHit = await (
      await fetch(`${srv.baseUrl}/api/v1/classify/batch`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          items: [{ tweetId: '500010', handle: 'human_replier', text: 'Appealable slop reply' }],
        }),
      })
    ).json();
    assert.equal(cachedHit.results[0].source, 'post_cache');
    assert.equal(cachedHit.results[0].slopProb, 0.83);

    await fetch(`${srv.baseUrl}/api/v1/signal`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        type: 'APPEAL_TWEET',
        tweetId: '500010',
        handle: 'human_replier',
        quotedHandle: 'q_author',
        quotedText: 'Quoted clip',
        parentHandle: 'focal_author',
        parentText: 'Thread context text',
        isReply: true,
        isVerified: true,
        text: 'Appealable slop reply',
        clientId: 'cli-a',
      }),
    });

    const fpSample = await srv.db
      .prepare('SELECT orig_verdict, orig_slop_prob, orig_source, parent_handle, parent_text, quoted_handle, is_reply, is_verified FROM flywheel_samples WHERE tweet_id = ?')
      .bind('500010')
      .first();
    assert.equal(fpSample.orig_verdict, 'SLOP');
    assert.equal(fpSample.orig_slop_prob, 0.83);
    assert.equal(fpSample.orig_source, 'ai_model');
    assert.equal(fpSample.parent_handle, 'focal_author');
    assert.equal(fpSample.parent_text, 'Thread context text');
    assert.equal(fpSample.quoted_handle, 'q_author');
    assert.equal(fpSample.is_reply, 1);
    assert.equal(fpSample.is_verified, 1);

    const postRow = await srv.db.prepare('SELECT verdict, source, slop_prob FROM post_decisions WHERE tweet_id = ?').bind('500010').first();
    assert.equal(postRow.verdict, 'ALLOW');
    assert.equal(postRow.source, 'appealed');
    assert.equal(postRow.slop_prob, 0.83);

    // Classify ALLOW item (p=0.31) -> BLOCK_TWEET preserves orig_verdict=ALLOW/0.31 AND passes parentText/isReply/isVerified to AI verification
    await fetch(`${srv.baseUrl}/api/v1/classify/batch`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        items: [
          {
            tweetId: '500011',
            handle: 'slop_missed',
            isReply: true,
            isVerified: true,
            parentHandle: 'focal_author',
            parentText: 'Original focal post for FN',
            text: 'Missed AI slop text',
          },
        ],
      }),
    });

    await fetch(`${srv.baseUrl}/api/v1/signal`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        type: 'BLOCK_TWEET',
        tweetId: '500011',
        handle: 'slop_missed',
        isReply: true,
        isVerified: true,
        parentHandle: 'focal_author',
        parentText: 'Original focal post for FN',
        text: 'Missed AI slop text',
        clientId: 'cli-b',
      }),
    });

    const fnSample = await srv.db
      .prepare('SELECT orig_verdict, orig_slop_prob, orig_source, parent_handle, parent_text, is_reply, is_verified FROM flywheel_samples WHERE tweet_id = ?')
      .bind('500011')
      .first();
    assert.equal(fnSample.orig_verdict, 'ALLOW');
    assert.equal(fnSample.orig_slop_prob, 0.31);
    assert.equal(fnSample.orig_source, 'ai_model');
    assert.equal(fnSample.parent_handle, 'focal_author');
    assert.equal(fnSample.is_reply, 1);
    assert.equal(fnSample.is_verified, 1);
    assert.ok(capturedVerifierItems[capturedVerifierItems.length - 1].includes('Original focal post for FN'));
  } finally {
    await srv.close();
  }
});
