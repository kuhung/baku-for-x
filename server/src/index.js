import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { createSqliteD1Database } from './d1Sqlite.js';
import { createFlywheelApp } from '../../worker/src/app.js';

function loadEnvFile(filePath) {
  try {
    if (!fs.existsSync(filePath)) return;
    const content = fs.readFileSync(filePath, 'utf8');
    for (const line of content.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#') || !trimmed.includes('=')) continue;
      const idx = trimmed.indexOf('=');
      const key = trimmed.slice(0, idx).trim();
      let val = trimmed.slice(idx + 1).trim();
      if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
        val = val.slice(1, -1);
      }
      if (!process.env[key]) {
        process.env[key] = val;
      }
    }
  } catch {
    // ignore
  }
}

function readNodeBody(req, maxBytes = 256 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > maxBytes) {
        const err = new Error('Payload too large');
        err.status = 413;
        reject(err);
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

export function createAppServer(options = {}) {
  const defaultDbFile = path.resolve(process.cwd(), 'server/data/flywheel.sqlite');
  const dbFile = options.dbFile ?? process.env.SQLITE_FILE ?? defaultDbFile;
  const db = options.db ?? createSqliteD1Database(dbFile);

  const env = {
    DB: db,
    API_AUTH_TOKEN: options.apiAuthToken ?? process.env.API_AUTH_TOKEN ?? '',
    BLACKLIST_REPORT_QUORUM: options.reportQuorum ?? process.env.BLACKLIST_REPORT_QUORUM ?? 2,
    POST_REPORT_QUORUM: options.postReportQuorum ?? process.env.POST_REPORT_QUORUM ?? 2,
    ACCOUNT_ESCALATION_THRESHOLD:
      options.escalationThreshold ?? process.env.ACCOUNT_ESCALATION_THRESHOLD ?? 3,
    AI_DAILY_ITEM_LIMIT: options.aiDailyItemLimit ?? process.env.AI_DAILY_ITEM_LIMIT ?? 5000,
    IP_MINUTE_ITEM_LIMIT: options.ipMinuteItemLimit ?? process.env.IP_MINUTE_ITEM_LIMIT ?? 120,
    IP_DAILY_ITEM_LIMIT: options.ipDailyItemLimit ?? process.env.IP_DAILY_ITEM_LIMIT ?? 800,
    ALLOW_PUBLIC_CLASSIFY: options.allowPublicClassify ?? process.env.ALLOW_PUBLIC_CLASSIFY ?? 'true',
    GEMINI_API_KEY: options.geminiKey ?? process.env.GEMINI_API_KEY ?? '',
    AI_API_KEY: options.aiApiKey ?? process.env.AI_API_KEY ?? '',
    AI_BASE_URL: options.aiBaseUrl ?? process.env.AI_BASE_URL ?? '',
    AI_MODEL: options.aiModel ?? process.env.AI_MODEL ?? '',
    IP_HASH_SALT: options.ipHashSalt ?? process.env.IP_HASH_SALT ?? 'anti-slop-local',
  };

  const flywheelApp = createFlywheelApp({
    db,
    aiVerifier: options.aiVerifier,
    apiAuthToken: env.API_AUTH_TOKEN,
    reportQuorum: env.BLACKLIST_REPORT_QUORUM,
    postReportQuorum: env.POST_REPORT_QUORUM,
    escalationThreshold: env.ACCOUNT_ESCALATION_THRESHOLD,
    aiDailyItemLimit: env.AI_DAILY_ITEM_LIMIT,
    ipMinuteItemLimit: env.IP_MINUTE_ITEM_LIMIT,
    ipDailyItemLimit: env.IP_DAILY_ITEM_LIMIT,
    allowPublicClassify: env.ALLOW_PUBLIC_CLASSIFY,
  });

  const server = http.createServer(async (req, res) => {
    try {
      const origin = `http://${req.headers.host || '127.0.0.1'}`;
      const fullUrl = new URL(req.url || '/', origin).toString();
      const headers = new Headers();
      for (const [k, v] of Object.entries(req.headers)) {
        if (Array.isArray(v)) headers.set(k, v.join(', '));
        else if (v !== undefined) headers.set(k, String(v));
      }

      const hasBody = !['GET', 'HEAD', 'OPTIONS'].includes((req.method || 'GET').toUpperCase());
      const bodyBuffer = hasBody ? await readNodeBody(req) : undefined;
      const webReq = new Request(fullUrl, {
        method: req.method,
        headers,
        body: hasBody && bodyBuffer.length > 0 ? bodyBuffer : hasBody ? '' : undefined,
      });

      const webRes = await flywheelApp.handleRequest(webReq, env, null);
      const resHeaders = {};
      webRes.headers.forEach((value, key) => {
        resHeaders[key] = value;
      });
      res.writeHead(webRes.status, resHeaders);
      const outBuf = Buffer.from(await webRes.arrayBuffer());
      res.end(outBuf);
    } catch (err) {
      const status = err.status || 500;
      res.writeHead(status, {
        'Content-Type': 'application/json; charset=utf-8',
        'Access-Control-Allow-Origin': '*',
      });
      res.end(JSON.stringify({ error: err.message || 'Internal server error' }));
    }
  });

  return { server, db, flywheelApp, env };
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname);
if (isMain) {
  loadEnvFile(path.resolve(process.cwd(), '.env.local'));
  loadEnvFile(path.resolve(process.cwd(), '.env'));

  const port = Number(process.env.PORT || 8787);
  const host = process.env.HOST || '127.0.0.1';
  const { server, flywheelApp, env } = createAppServer();
  const verifier = flywheelApp.getVerifier(env);

  server.listen(port, host, () => {
    console.log(
      `[anti-slop-flywheel] listening on http://${host}:${port} (ai=${verifier.isConfigured() ? verifier.provider : 'unconfigured->quorum-only'})`
    );
  });
}
