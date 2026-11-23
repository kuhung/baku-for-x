import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createSqliteD1Database } from './d1Sqlite.js';
import { createAiVerifierFromEnv } from '../../worker/src/aiVerifier.js';

const BUILTIN_BENCHMARK_SAMPLES = [
  {
    sampleId: 'bench-1',
    handle: 'prompt_wizard_9911',
    displayName: 'AI Growth Free Prompts 🚀🔥💎',
    text: 'Comment "AI" and I will DM you my 50 ChatGPT prompts for free!',
    signalType: 'FN_TWEET',
  },
  {
    sampleId: 'bench-2',
    handle: 'airdrop_king_88421',
    displayName: 'Free Mint 100x',
    text: 'HUGE AIRDROP! Like + RT + Follow and drop your ETH wallet address to claim!',
    signalType: 'FN_ACCOUNT',
  },
  {
    sampleId: 'bench-3',
    handle: 'growth_guru_01',
    displayName: 'Alex Growth',
    text: 'Unpopular opinion: remote work killed engineering culture. Agree or disagree?',
    signalType: 'FN_TWEET',
  },
  {
    sampleId: 'bench-4',
    handle: 'bot_farm_202601',
    displayName: 'Daily Alpha 空投福利',
    text: 'Check out our airdrop link https://example.com/claim',
    signalType: 'FN_ACCOUNT',
  },
  {
    sampleId: 'bench-5',
    handle: 'normal_commenter',
    displayName: 'Sam',
    text: 'Wait what is this?',
    quotedHandle: 'scam_giveaway_888',
    quotedText: 'HUGE AIRDROP! Like + RT + Follow and drop your ETH wallet address!',
    signalType: 'FN_TWEET',
  },
  {
    sampleId: 'bench-6',
    handle: 'alice_eng',
    displayName: 'Alice Chen',
    text: 'Just fixed a subtle memory leak in our Node.js WebSocket worker. Happy Friday!',
    signalType: 'FP_TWEET',
  },
  {
    sampleId: 'bench-7',
    handle: 'bob_research',
    displayName: 'Bob Lin',
    text: 'Here is our open-source benchmark comparing SQLite WAL mode vs DuckDB on 10M rows.',
    signalType: 'FP_ACCOUNT',
  },
  {
    sampleId: 'bench-8',
    handle: 'crypto_dev_note',
    displayName: 'ETH Core Notes',
    text: 'Detailed writeup on EIP-7702 gas accounting edge cases and wallet compatibility.',
    signalType: 'FP_TWEET',
  },
  {
    sampleId: 'bench-9',
    handle: 'zh_promo_bot',
    displayName: '福利助手',
    text: '点赞收藏转发私信我，评论区回复“工具”免费领取全套合集！',
    signalType: 'FN_TWEET',
  },
];

function isGroundTruthSlop(signalType) {
  return signalType === 'FN_ACCOUNT' || signalType === 'FN_TWEET';
}

function queryRemoteD1(sql) {
  const out = execFileSync(
    'npx',
    ['--yes', 'wrangler@4', 'd1', 'execute', 'anti-slop-db', '--remote', '--json', '--command', sql],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }
  );
  const trimmed = out.trim();
  const arrStart = trimmed.indexOf('[');
  const parsed = JSON.parse(arrStart >= 0 ? trimmed.slice(arrStart) : trimmed);
  return parsed?.[0]?.results || [];
}

async function loadDecisionLogs({ isRemote, dbFile, limit = 50 }) {
  const sql = `SELECT id, tweet_id, handle, is_reply, is_verified, verdict, slop_prob, confidence, text_excerpt, parent_excerpt, created_at FROM decision_logs ORDER BY id DESC LIMIT ${limit}`;
  if (isRemote) {
    return { source: 'remote-d1:anti-slop-db', logs: queryRemoteD1(sql) };
  }
  if (dbFile && fs.existsSync(dbFile)) {
    const db = createSqliteD1Database(dbFile);
    try {
      const table = await db
        .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='decision_logs'")
        .first();
      if (table) {
        const res = await db.prepare(sql).all();
        return { source: dbFile, logs: res?.results || [] };
      }
    } finally {
      db.close();
    }
  }
  return { source: 'none', logs: [] };
}

function formatLogEntry(row) {
  const prob = Number(row.slop_prob || 0).toFixed(3);
  const tags = [row.is_reply ? 'REPLY' : 'TWEET', row.is_verified ? 'BLUE' : 'STD'].join(',');
  const text = String(row.text_excerpt || '').replace(/\s+/g, ' ').trim();
  const parent = String(row.parent_excerpt || '').replace(/\s+/g, ' ').trim();
  const base = `  p=${prob} [${tags}] @${row.handle || 'unknown'} (${row.tweet_id || '-'}) | "${text}"`;
  return parent ? `${base}  <-- parent: "${parent}"` : base;
}

function printDecisionLogsReport({ source, logs }) {
  const slop = [];
  const grey = [];
  const clean = [];

  for (const row of logs) {
    const p = Number(row.slop_prob || 0);
    if (row.verdict === 'SLOP') slop.push(row);
    else if (p >= 0.35) grey.push(row);
    else clean.push(row);
  }

  console.log('=== Anti-Slop Recent AI Decision Audit Logs ===');
  console.log(`Source : ${source} (showing latest ${logs.length} items)`);
  console.log(`Summary: SLOP=${slop.length}  GREY(p>=0.35)=${grey.length}  ALLOW=${clean.length}\n`);

  if (logs.length === 0) {
    console.log('No AI decision logs recorded yet.');
    return;
  }

  console.log(`[1] SLOP (已拦截: ${slop.length})`);
  if (slop.length === 0) console.log('  (none)');
  else slop.forEach((r) => console.log(formatLogEntry(r)));

  console.log(`\n[2] 灰区待调优 (0.35 <= p < 阈值: ${grey.length})`);
  if (grey.length === 0) console.log('  (none)');
  else grey.forEach((r) => console.log(formatLogEntry(r)));

  console.log(`\n[3] ALLOW (低分放行: ${clean.length})`);
  if (clean.length === 0) console.log('  (none)');
  else clean.forEach((r) => console.log(formatLogEntry(r)));
}

const SAMPLE_SELECT_COLS =
  'id, signal_type, handle, tweet_id, display_name, text, quoted_handle, quoted_text, parent_handle, parent_text, is_reply, is_verified, orig_verdict, orig_slop_prob, orig_source, created_at';

function mapDbSampleRow(r, prefix) {
  return {
    sampleId: `${prefix}-${r.id}`,
    handle: r.handle,
    tweetId: r.tweet_id,
    displayName: r.display_name,
    text: r.text,
    quotedHandle: r.quoted_handle || '',
    quotedText: r.quoted_text || '',
    parentHandle: r.parent_handle || '',
    parentText: r.parent_text || '',
    isReply: Boolean(r.is_reply),
    isVerified: Boolean(r.is_verified),
    origVerdict: r.orig_verdict || '',
    origSlopProb: r.orig_slop_prob ?? null,
    origSource: r.orig_source || '',
    signalType: r.signal_type,
    createdAt: r.created_at,
  };
}

async function loadRemoteSamples() {
  const rows = queryRemoteD1(`SELECT ${SAMPLE_SELECT_COLS} FROM flywheel_samples ORDER BY id DESC LIMIT 500`);
  const statsRows = queryRemoteD1(
    `SELECT
       active_blacklist_count AS activeBlacklist,
       slop_post_count AS slopPosts,
       cached_post_count AS cachedPosts
     FROM flywheel_counters
     WHERE id = 1`
  );
  return {
    source: 'remote-d1:anti-slop-db',
    remoteSummary: statsRows[0] || null,
    samples: rows.map((r) => mapDbSampleRow(r, 'd1')),
  };
}

async function loadLocalSamples(dbFile) {
  if (dbFile && fs.existsSync(dbFile)) {
    const db = createSqliteD1Database(dbFile);
    try {
      const table = await db
        .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='flywheel_samples'")
        .first();
      if (table) {
        const res = await db
          .prepare(`SELECT ${SAMPLE_SELECT_COLS} FROM flywheel_samples ORDER BY id DESC LIMIT 1000`)
          .all();
        if (Array.isArray(res.results) && res.results.length > 0) {
          return {
            source: dbFile,
            remoteSummary: null,
            samples: res.results.map((r) => mapDbSampleRow(r, 'db')),
          };
        }
      }
    } catch (err) {
      console.warn(`[eval] Failed to read ${dbFile}: ${err.message}`);
    } finally {
      db.close();
    }
  }
  return { source: 'builtin-benchmark', remoteSummary: null, samples: BUILTIN_BENCHMARK_SAMPLES };
}

function getArgValue(flag) {
  const idx = process.argv.indexOf(flag);
  return idx >= 0 && process.argv[idx + 1] && !process.argv[idx + 1].startsWith('--')
    ? process.argv[idx + 1]
    : '';
}

function loadAnnotationsMap(annotationsPath) {
  if (!annotationsPath) return null;
  const parsed = JSON.parse(fs.readFileSync(path.resolve(process.cwd(), annotationsPath), 'utf8'));
  return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
}

function loadDatasetSamples(datasetPath, annotationsPath = '') {
  const resolved = path.resolve(process.cwd(), datasetPath);
  const raw = fs.readFileSync(resolved, 'utf8').trim();
  const rows = raw.startsWith('[')
    ? JSON.parse(raw)
    : raw
        .split('\n')
        .map((line) => line.trim())
        .filter(Boolean)
        .map((line) => JSON.parse(line));

  const annMap = loadAnnotationsMap(annotationsPath);
  const samples = [];
  let skipped = 0;

  for (const row of rows) {
    const caseId = row.caseId || row.sampleId || '';
    const inp = row.input && typeof row.input === 'object' ? row.input : row;
    const rawText = String(inp.text || '').trim();
    const isAccountPlaceholder =
      (!rawText && !inp.quotedText) ||
      (row.scope === 'account' && !inp.tweetId && !inp.quotedText && rawText.startsWith('（账号级申诉'));
    if (isAccountPlaceholder) {
      skipped += 1;
      continue;
    }

    let verdict = null;
    if (annMap && caseId && annMap[caseId]) {
      verdict = annMap[caseId].verdict || null;
    } else if (row.expectedVerdict) {
      verdict = row.expectedVerdict;
    } else if (row.signalType) {
      verdict = isGroundTruthSlop(row.signalType) ? 'SLOP' : 'ALLOW';
    }

    const normalizedVerdict = String(verdict || '').toUpperCase();
    if (normalizedVerdict !== 'SLOP' && normalizedVerdict !== 'ALLOW') {
      skipped += 1;
      continue;
    }

    const createdAt =
      row.createdAt ||
      row.modelEvidence?.userActionTime ||
      row.modelEvidence?.modelTime ||
      inp.createdAt ||
      '';

    samples.push({
      sampleId: caseId || `row-${samples.length + 1}`,
      tweetId: inp.tweetId || '',
      handle: inp.handle || '',
      displayName: inp.displayName || '',
      text: inp.text || '',
      quotedHandle: inp.quotedHandle || '',
      quotedText: inp.quotedText || '',
      parentHandle: inp.parentHandle || '',
      parentText: inp.parentText || '',
      isReply: Boolean(inp.isReply),
      isVerified: Boolean(inp.isVerified),
      signalType: normalizedVerdict === 'SLOP' ? 'FN_TWEET' : 'FP_TWEET',
      createdAt,
    });
  }

  return {
    source: `${resolved}${annotationsPath ? ` + ${path.resolve(process.cwd(), annotationsPath)}` : ''}`,
    remoteSummary: null,
    samples,
    skipped,
  };
}

export function summarizeSamples(samples) {
  const byType = { FN_TWEET: 0, FP_TWEET: 0, FN_ACCOUNT: 0, FP_ACCOUNT: 0 };
  const handleCounts = new Map();

  for (const s of samples) {
    if (Object.prototype.hasOwnProperty.call(byType, s.signalType)) {
      byType[s.signalType] += 1;
    }
    if (s.handle && isGroundTruthSlop(s.signalType)) {
      handleCounts.set(s.handle, (handleCounts.get(s.handle) || 0) + 1);
    }
  }

  const topHandles = Array.from(handleCounts.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
    .map(([handle, count]) => ({ handle, count }));

  return { total: samples.length, byType, topHandles };
}

export async function evaluateWithVerifier(samples, aiVerifier) {
  let tp = 0;
  let fp = 0;
  let tn = 0;
  let fn = 0;
  let failures = 0;
  const mismatches = [];

  const decisions = [];
  for (let start = 0; start < samples.length; start += 50) {
    const chunk = samples.slice(start, start + 50);
    const batchOut = await aiVerifier.classifyTweetsBatch(
      chunk.map((s) => ({
        tweetId: s.tweetId || s.sampleId,
        handle: s.handle || '',
        displayName: s.displayName || '',
        text: s.text || '',
        quotedHandle: s.quotedHandle || '',
        quotedText: s.quotedText || '',
        parentHandle: s.parentHandle || '',
        parentText: s.parentText || '',
        isReply: Boolean(s.isReply),
        isVerified: Boolean(s.isVerified),
      }))
    );
    decisions.push(...batchOut);
  }

  for (let i = 0; i < samples.length; i += 1) {
    const s = samples[i];
    const res = decisions[i] || { verdict: 'ALLOW', source: 'ai_fallback_allow', reason: '' };
    if (res.source === 'ai_fallback_allow' || res.source === 'ai_unconfigured') {
      failures += 1;
      continue;
    }

    const expectedSlop = isGroundTruthSlop(s.signalType);
    const predictedSlop = res.verdict === 'SLOP';

    if (expectedSlop && predictedSlop) {
      tp += 1;
    } else if (!expectedSlop && predictedSlop) {
      fp += 1;
      mismatches.push({
        type: 'FP',
        sampleId: s.sampleId,
        handle: s.handle,
        signalType: s.signalType,
        slopProb: res.slopProb ?? null,
        reason: res.reason,
        text: (s.text || '').slice(0, 90),
      });
    } else if (!expectedSlop && !predictedSlop) {
      tn += 1;
    } else {
      fn += 1;
      mismatches.push({
        type: 'FN',
        sampleId: s.sampleId,
        handle: s.handle,
        signalType: s.signalType,
        slopProb: res.slopProb ?? null,
        reason: res.reason,
        text: (s.text || '').slice(0, 90),
      });
    }
  }

  const evaluated = tp + fp + tn + fn;
  const accuracy = evaluated > 0 ? (tp + tn) / evaluated : 0;
  const precision = tp + fp > 0 ? tp / (tp + fp) : 1;
  const recall = tp + fn > 0 ? tp / (tp + fn) : 1;
  const f1 = precision + recall > 0 ? (2 * precision * recall) / (precision + recall) : 0;
  const fpRate = fp + tn > 0 ? fp / (fp + tn) : 0;

  return {
    total: samples.length,
    evaluated,
    failures,
    tp,
    fp,
    tn,
    fn,
    accuracy: Number(accuracy.toFixed(3)),
    precision: Number(precision.toFixed(3)),
    recall: Number(recall.toFixed(3)),
    f1: Number(f1.toFixed(3)),
    fpRate: Number(fpRate.toFixed(3)),
    mismatches,
  };
}

function printEvalReport(label, report) {
  console.log(`\n[${label}] Evaluated=${report.evaluated}/${report.total}  Failures=${report.failures}`);
  console.log(`Metrics      : TP=${report.tp}  FP=${report.fp}  TN=${report.tn}  FN=${report.fn}`);
  console.log(
    `Scores       : Acc=${(report.accuracy * 100).toFixed(1)}%  Precision=${(report.precision * 100).toFixed(1)}%  Recall=${(report.recall * 100).toFixed(1)}%  F1=${(report.f1 * 100).toFixed(1)}%  FP_Rate=${(report.fpRate * 100).toFixed(1)}%`
  );
  if (report.mismatches.length > 0) {
    console.log('Mismatches:');
    for (const m of report.mismatches) {
      const probStr = typeof m.slopProb === 'number' ? ` p=${m.slopProb}` : '';
      console.log(`  [${m.type}] ${m.sampleId} @${m.handle || 'unknown'} (${m.signalType}${probStr}) | ${m.reason} | "${m.text}"`);
    }
  }
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname);
if (isMain) {
  const isRemote = process.argv.includes('--remote');
  const showLogs = process.argv.includes('--logs');
  const shouldVerify = process.argv.includes('--verify');
  const datasetPath = getArgValue('--dataset');
  const annotationsPath = getArgValue('--annotations');
  const splitDate = getArgValue('--split-date');
  const fileArg = getArgValue('--file');
  const targetDb = fileArg
    ? path.resolve(process.cwd(), fileArg)
    : path.resolve(process.cwd(), 'server/data/flywheel.sqlite');

  if (showLogs) {
    const logsReport = await loadDecisionLogs({ isRemote, dbFile: targetDb, limit: 50 });
    printDecisionLogsReport(logsReport);
    process.exit(0);
  }

  let loaded;
  if (datasetPath) {
    loaded = loadDatasetSamples(datasetPath, annotationsPath);
  } else {
    loaded = isRemote ? await loadRemoteSamples() : await loadLocalSamples(targetDb);
  }
  const { source, remoteSummary, samples } = loaded;
  const summary = summarizeSamples(samples);

  console.log('=== Anti-Slop Flywheel Sample Inspection & Eval ===');
  console.log(`Dataset      : ${source} (${summary.total} samples${loaded.skipped ? `, ${loaded.skipped} skipped` : ''})`);
  if (remoteSummary) {
    console.log(
      `Remote State : activeBlacklist=${remoteSummary.activeBlacklist}  slopPosts=${remoteSummary.slopPosts}  cachedPosts=${remoteSummary.cachedPosts}`
    );
  }
  console.log(
    `Distribution : FN_TWEET=${summary.byType.FN_TWEET}  FP_TWEET=${summary.byType.FP_TWEET}  FN_ACCOUNT=${summary.byType.FN_ACCOUNT}  FP_ACCOUNT=${summary.byType.FP_ACCOUNT}`
  );
  if (summary.topHandles.length > 0) {
    console.log(
      `Top Reported : ${summary.topHandles.map((h) => `@${h.handle}(${h.count})`).join(', ')}`
    );
  }

  let inSample = null;
  let outSample = null;
  if (splitDate) {
    const splitMs = Date.parse(splitDate);
    if (Number.isNaN(splitMs)) {
      console.error(`Invalid --split-date: ${splitDate}`);
      process.exit(1);
    }
    inSample = samples.filter((s) => {
      const ts = Date.parse(s.createdAt || '');
      return !Number.isNaN(ts) && ts < splitMs;
    });
    outSample = samples.filter((s) => {
      const ts = Date.parse(s.createdAt || '');
      return !Number.isNaN(ts) && ts >= splitMs;
    });
    console.log(`TemporalSplit: < ${splitDate} -> In-Sample=${inSample.length}, >= ${splitDate} -> Out-of-Sample=${outSample.length}`);
  }

  const aiVerifier = createAiVerifierFromEnv(process.env);
  if (aiVerifier.isConfigured() && (shouldVerify || Boolean(process.env.GEMINI_API_KEY || process.env.AI_API_KEY))) {
    console.log(`\nModel Eval   : ${aiVerifier.provider} (${aiVerifier.model})`);
    if (splitDate && inSample && outSample) {
      if (inSample.length > 0) printEvalReport('In-Sample', await evaluateWithVerifier(inSample, aiVerifier));
      if (outSample.length > 0) printEvalReport('Out-of-Sample', await evaluateWithVerifier(outSample, aiVerifier));
    } else {
      const evalTargets = datasetPath ? samples : samples.slice(0, 50);
      printEvalReport('All', await evaluateWithVerifier(evalTargets, aiVerifier));
    }
  } else if (shouldVerify) {
    console.log('\n[eval] Skipped model replay: configure GEMINI_API_KEY to run AI replay.');
  }
}
