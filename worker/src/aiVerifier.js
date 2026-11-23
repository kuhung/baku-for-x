const DEFAULT_GEMINI_DECISIONS_URL = 'https://generativelanguage.googleapis.com/v1beta/decisions';
const DEFAULT_GEMINI_DECISION_MODEL = 'gemini-decision-1';

function clampConfidence(val, fallback = 0) {
  const num = Number(val);
  if (!Number.isFinite(num)) return fallback;
  return Number(Math.max(0, Math.min(1, num)).toFixed(3));
}

function normalizeHandleSimple(raw) {
  if (!raw || typeof raw !== 'string') return '';
  return raw.trim().replace(/^@+/, '').toLowerCase();
}

function readNoul(ans) {
  if (!ans || typeof ans !== 'object') return { prob: null, confidence: 0 };
  const raw = ans.noul ?? ans.probability;
  const prob = typeof raw === 'number' && Number.isFinite(raw) ? clampConfidence(raw) : null;
  const rawConf = ans.confidence;
  const confidence =
    typeof rawConf === 'number' && Number.isFinite(rawConf)
      ? clampConfidence(rawConf)
      : prob !== null
        ? clampConfidence(Math.min(1, 0.5 + Math.abs(prob - 0.5)))
        : 0;
  return { prob, confidence };
}

function readChoice(ans) {
  if (!ans || typeof ans !== 'object') return { choice: '', confidence: 0 };
  const raw = ans.choice ?? ans.selected_option ?? ans.selectedOption ?? '';
  const choice = typeof raw === 'string' ? raw.trim() : String(raw || '').trim();
  const confidence = clampConfidence(ans.confidence, choice ? 0.75 : 0);
  return { choice, confidence };
}

function readScore(ans) {
  if (!ans || typeof ans !== 'object') return 0;
  const raw = ans.score ?? ans.expected_score ?? ans.expectedScore;
  if (typeof raw === 'number' && Number.isFinite(raw)) return raw;
  if (typeof raw === 'string') {
    const m = raw.trim().match(/^(\d+(?:\.\d+)?)/);
    if (m) return Number(m[1]);
  }
  if (typeof ans.choice === 'number' && Number.isFinite(ans.choice)) return ans.choice;
  if (typeof ans.choice === 'string') {
    const m = ans.choice.trim().match(/^(\d+(?:\.\d+)?)/);
    if (m) return Number(m[1]);
  }
  return 0;
}

function buildBatchInputText(chunk) {
  const uniqueParents = [];
  const parentSeen = new Set();
  for (const item of chunk) {
    const pText = String(item.parentText || '').trim().slice(0, 240);
    if (!pText) continue;
    const pHandle = normalizeHandleSimple(item.parentHandle) || '';
    const key = `${pHandle}|${pText}`;
    if (!parentSeen.has(key)) {
      parentSeen.add(key);
      uniqueParents.push({ key, handle: pHandle, text: pText });
    }
  }
  const sharedParent = uniqueParents.length === 1 ? uniqueParents[0] : null;
  const header = sharedParent
    ? `SharedParentPost${sharedParent.handle ? ` (@${sharedParent.handle})` : ''}: ${sharedParent.text}\n\n=== ITEMS ===\n\n`
    : '';

  return (
    header +
    chunk
      .map((item, idx) => {
        const handle = normalizeHandleSimple(item.handle) || 'unknown';
        const isVerified = Boolean(item.isVerified);
        const pText = String(item.parentText || '').trim().slice(0, 240);
        const pHandle = normalizeHandleSimple(item.parentHandle) || '';
        const needsOwnParent = Boolean(pText && (!sharedParent || `${pHandle}|${pText}` !== sharedParent.key));
        return [
          `[${idx}] Handle: @${handle}`,
          isVerified ? 'VerifiedBlue: yes' : null,
          item.displayName ? `DisplayName: ${String(item.displayName).slice(0, 80)}` : null,
          item.isRetweet ? 'Type: RETWEET' : item.isReply ? 'Type: REPLY' : 'Type: TWEET',
          needsOwnParent ? `ParentPost${pHandle ? ` (@${pHandle})` : ''}: ${pText}` : null,
          `Text: ${String(item.text || '').slice(0, 400)}`,
          item.quotedHandle ? `QuotedHandle: @${normalizeHandleSimple(item.quotedHandle)}` : null,
          item.quotedText ? `QuotedText: ${String(item.quotedText).slice(0, 280)}` : null,
        ]
          .filter(Boolean)
          .join('\n');
      })
      .join('\n\n---\n\n')
  );
}

function buildBatchDecisionQuestions(chunk) {
  const questions = {};
  const trueDesc =
    '具有明显「AI 味/人机腔」、营销号套路或引流推广意图的内容（即使看起来有数据、攻略或貌似有道理）：' +
    '1) AI 写作与评论腔：假认同+总结升华（「最认同的一点：」「同感。真正危险的是…」）、工整的中文冒号总分体或攻略模板（「怎么买不踩坑…适合/不适合」）、破折号（「——」）金句收尾、刻意工整的三段式比喻/抖机灵对仗、圆滑的「看着挺香但…」「X是一回事，Y会…」「但…事实上…不过…」分析腔、生硬的英文/机翻夸大资讯腔（「这太疯狂了」「这篇文章精准地指出了…」）、装深刻的长段说教；' +
    '2) 软广与营销引流：先共情痛点或吐槽竞品再顺势推销插件/API/工具/券商开户、惊叹号+👇一惊一乍导流、夸张大师课/假新闻段子搬运；' +
    '3) 养号与水军：互关涨粉标签（#蓝V互关 #真诚交友）、垃圾引战或无意义套话。';
  const falseDesc =
    '自然随口的「活人表达」或正常平台功能互动：简短口语反应、随手点赞/夸赞/附和、日常吐槽与粗口、真实社区玩梗、直接干脆的短反驳或提问、艾特 @grok / @bot 等功能召唤、粗糙真实的一手排障经历，或官方/工具账号的正常公告。';

  for (let idx = 0; idx < chunk.length; idx += 1) {
    const item = chunk[idx];
    questions[`p_${idx}_slop`] = {
      type: 'noul',
      instructions: `Evaluate ONLY item [${idx}]. Judge whether item [${idx}] is AI-written/robotic slop, marketing/promo copy, or account-farming content that should be hidden (TRUE), versus natural spontaneous human speech or utility interaction (FALSE).`,
      criteria: { true_description: trueDesc, false_description: falseDesc },
    };
    if (item.quotedText || item.quotedHandle) {
      questions[`p_${idx}_target`] = {
        type: 'choice',
        instructions: `For item [${idx}], if it contains slop, where is the slop located?`,
        criteria: {
          OUTER: 'The outer post itself is slop/spam.',
          QUOTED_ONLY: 'Only the quoted post is slop while the outer author is making a normal comment/reaction.',
        },
      };
    }
  }
  return questions;
}

function buildAccountInputText(candidate, handle) {
  const parts = [
    `Handle: @${handle}`,
    candidate.displayName ? `DisplayName: ${String(candidate.displayName).slice(0, 100)}` : null,
    candidate.text ? `LatestReportedText: ${String(candidate.text).slice(0, 500)}` : null,
    candidate.quotedHandle ? `LatestQuotedHandle: @${normalizeHandleSimple(candidate.quotedHandle)}` : null,
    candidate.quotedText ? `LatestQuotedText: ${String(candidate.quotedText).slice(0, 320)}` : null,
  ].filter(Boolean);

  const sampleList = Array.isArray(candidate.samples) ? candidate.samples.slice(0, 5) : [];
  if (sampleList.length > 0) {
    parts.push('RecentEvidenceSamples:');
    sampleList.forEach((s, idx) => {
      const rawType = String(s.signal_type || s.signalType || '').toUpperCase();
      const tag = rawType.startsWith('FP') ? '[APPEALED]' : '[REPORTED]';
      const body = [s.text, s.quoted_text || s.quotedText].filter(Boolean).join(' | Quoted: ');
      if (body) {
        parts.push(`Sample ${idx + 1} ${tag}: ${String(body).slice(0, 320)}`);
      }
    });
  }

  return parts.join('\n');
}

export class AiVerifier {
  constructor(options = {}) {
    const rawBaseUrl = String(options.baseUrl ?? '').trim().replace(/\/+$/, '');
    this.provider = 'gemini_decisions';
    this.apiKey = String(options.apiKey ?? options.geminiKey ?? '').trim();
    this.baseUrl = rawBaseUrl || DEFAULT_GEMINI_DECISIONS_URL;
    this.model = String(options.model ?? '').trim() || DEFAULT_GEMINI_DECISION_MODEL;
    this.timeoutMs = Math.max(1000, Number(options.timeoutMs) || 8000);
    this.fetchImpl = options.fetchImpl ?? ((...args) => globalThis.fetch(...args));
  }

  isConfigured() {
    return Boolean(this.apiKey && this.baseUrl);
  }

  async _postJson(payload) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const fetchFn = this.fetchImpl;
      const res = await fetchFn(this.baseUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-goog-api-key': this.apiKey,
        },
        body: JSON.stringify(payload),
        signal: controller.signal,
      });
      if (!res.ok) {
        const errText = await res.text().catch(() => '');
        return { ok: false, error: `HTTP_${res.status}: ${errText.slice(0, 180)}` };
      }
      const data = await res.json();
      return { ok: true, data };
    } catch (err) {
      return { ok: false, error: err?.message || 'REQUEST_FAILED' };
    } finally {
      clearTimeout(timer);
    }
  }

  async verifyAccountCandidate(candidate = {}) {
    if (!this.isConfigured()) {
      return {
        ok: false,
        verdict: 'UNCERTAIN',
        confidence: 0,
        postSlop: false,
        reason: 'AI_NOT_CONFIGURED',
        provider: null,
      };
    }
    const handle = normalizeHandleSimple(candidate.handle);
    if (!handle) {
      return {
        ok: false,
        verdict: 'UNCERTAIN',
        confidence: 0,
        postSlop: false,
        reason: 'HANDLE_REQUIRED',
        provider: this.provider,
      };
    }

    const input = buildAccountInputText(candidate, handle);
    const questions = {
      is_slop_account: {
        type: 'noul',
        instructions:
          'Based on the profile and evidence samples, is this X/Twitter account a dedicated spam, scam, bot-farm, or slop-farming account that should be blacklisted globally?',
        criteria: {
          true_description:
            'Clear pattern of crypto airdrop/wallet/rebate scam, mutual-follow growth farming (e.g. "#蓝V互关", "#真诚交友"), automated AI-slop reply/marketing farm, or disguised ad/DM-bait promotion account.',
          false_description:
            'Ordinary human user, developer, creator, official product/company/service account, platform utility bot (e.g. @grok), or insufficient evidence (e.g. a normal person who posted one noisy or debatable tweet).',
        },
      },
      post_is_slop: {
        type: 'noul',
        instructions: 'Is the latest reported post itself slop (even if the account as a whole should not be blacklisted)?',
        criteria: {
          true_description: 'The specific post is engagement bait, spam, scam, or slop.',
          false_description: 'The specific post is normal human commentary or clean content.',
        },
      },
      account_severity: {
        type: 'score',
        instructions: 'Rate overall account spam severity from 0 (clean human) to 3 (severe dedicated spam/scam bot).',
        criteria: [
          '0 - Clean human account',
          '1 - Occasional noise or promotional post',
          '2 - Frequent slop/bait account',
          '3 - Severe scam or automated spam bot',
        ],
      },
    };

    const resp = await this._postJson({ model: this.model, input, questions });
    if (!resp.ok) {
      return {
        ok: false,
        verdict: 'UNCERTAIN',
        confidence: 0,
        postSlop: false,
        reason: resp.error,
        provider: this.provider,
      };
    }

    const answers = resp.data?.answers || {};
    const acc = readNoul(answers.is_slop_account);
    const post = readNoul(answers.post_is_slop);
    const severity = readScore(answers.account_severity);
    const postSlop = post.prob !== null && post.prob >= 0.72 && post.confidence >= 0.6;
    const postConfidence = post.prob ?? 0;

    if (acc.prob !== null && acc.prob >= 0.6 && severity < 1.0) {
      return {
        ok: true,
        verdict: 'UNCERTAIN',
        confidence: Math.min(acc.confidence, 0.45),
        postSlop,
        postConfidence,
        reason: 'Contradictory severity score',
        provider: this.provider,
      };
    }

    if (acc.prob !== null && acc.prob >= 0.78 && acc.confidence >= 0.65 && severity >= 2.0) {
      return {
        ok: true,
        verdict: 'SLOP',
        confidence: acc.prob,
        postSlop,
        postConfidence,
        reason: `Decisions account slop (p=${acc.prob}, sev=${severity})`,
        provider: this.provider,
      };
    }

    const verdict = acc.prob !== null && acc.prob <= 0.35 ? 'CLEAN' : 'UNCERTAIN';
    return {
      ok: true,
      verdict,
      confidence: acc.prob ?? 0.5,
      postSlop,
      postConfidence,
      reason: `Decisions ${verdict.toLowerCase()} (p=${acc.prob ?? 0}, sev=${severity})`,
      provider: this.provider,
    };
  }

  async classifyTweetsBatch(items = []) {
    if (!Array.isArray(items) || items.length === 0) return [];
    const safeItems = items.slice(0, 50);

    if (!this.isConfigured()) {
      return safeItems.map((item) => ({
        tweetId: item.tweetId || null,
        handle: normalizeHandleSimple(item.handle),
        matchedHandle: normalizeHandleSimple(item.handle),
        verdict: 'ALLOW',
        scope: 'TWEET',
        confidence: 0,
        slopProb: 0,
        source: 'ai_unconfigured',
        reason: 'AI not configured',
      }));
    }

    const out = [];
    for (let i = 0; i < safeItems.length; i += 25) {
      const chunk = safeItems.slice(i, i + 25);
      const input = buildBatchInputText(chunk);
      const questions = buildBatchDecisionQuestions(chunk);
      const resp = await this._postJson({ model: this.model, input, questions });

      if (!resp.ok) {
        for (const item of chunk) {
          const handle = normalizeHandleSimple(item.handle);
          out.push({
            tweetId: item.tweetId || null,
            handle,
            matchedHandle: handle,
            verdict: 'ALLOW',
            scope: 'TWEET',
            confidence: 0,
            slopProb: 0,
            source: 'ai_fallback_allow',
            reason: resp.error,
          });
        }
        continue;
      }

      const answers = resp.data?.answers || {};
      for (let idx = 0; idx < chunk.length; idx += 1) {
        const item = chunk[idx];
        const handle = normalizeHandleSimple(item.handle);
        const quotedHandle = normalizeHandleSimple(item.quotedHandle);
        const slopAns = readNoul(answers[`p_${idx}_slop`]);
        const probThreshold = item.isReply ? 0.5 : 0.55;
        const confThreshold = item.isReply ? 0.5 : 0.55;
        const isSlop = slopAns.prob !== null && slopAns.prob >= probThreshold && slopAns.confidence >= confThreshold;

        if (!isSlop) {
          out.push({
            tweetId: item.tweetId || null,
            handle,
            matchedHandle: handle,
            verdict: 'ALLOW',
            scope: 'TWEET',
            confidence: slopAns.prob !== null ? clampConfidence(1 - slopAns.prob) : 0.5,
            slopProb: slopAns.prob ?? 0,
            source: 'ai_model',
            reason: 'Decisions clean',
          });
          continue;
        }

        let matchedHandle = handle;
        if (item.quotedText || item.quotedHandle) {
          const target = readChoice(answers[`p_${idx}_target`]);
          if (target.choice === 'QUOTED_ONLY' && quotedHandle) {
            matchedHandle = quotedHandle;
          }
        }

        out.push({
          tweetId: item.tweetId || null,
          handle,
          matchedHandle,
          verdict: 'SLOP',
          scope: 'TWEET',
          confidence: slopAns.prob,
          slopProb: slopAns.prob,
          source: 'ai_model',
          reason: `Decisions p=${slopAns.prob} c=${slopAns.confidence}`,
        });
      }
    }
    return out;
  }
}

export function createAiVerifierFromEnv(env = {}) {
  return new AiVerifier({
    apiKey: env.AI_API_KEY,
    geminiKey: env.GEMINI_API_KEY,
    baseUrl: env.AI_BASE_URL || env.GEMINI_DECISIONS_URL,
    model: env.AI_MODEL,
    timeoutMs: env.AI_TIMEOUT_MS,
    fetchImpl: env.fetchImpl,
  });
}
