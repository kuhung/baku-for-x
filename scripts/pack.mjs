#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const EXT_DIR = join(ROOT, 'extension');
const DIST_DIR = join(ROOT, 'dist');

function fail(msg) {
  console.error(`[pack] 失败: ${msg}`);
  process.exit(1);
}

function readJson(filePath) {
  if (!existsSync(filePath)) fail(`缺少文件: ${filePath}`);
  try {
    return JSON.parse(readFileSync(filePath, 'utf8'));
  } catch (err) {
    fail(`JSON 解析失败 (${filePath}): ${err.message}`);
  }
}

function formatSize(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  const kib = bytes / 1024;
  if (kib < 1024) return `${kib.toFixed(2)} KiB`;
  return `${(kib / 1024).toFixed(2)} MiB`;
}

// 1. Validate versions match and are SemVer X.Y.Z
const pkg = readJson(join(ROOT, 'package.json'));
const manifest = readJson(join(EXT_DIR, 'manifest.json'));
const semverRe = /^\d+\.\d+\.\d+$/;
if (!semverRe.test(pkg.version || '')) fail(`package.json version 非标准 X.Y.Z: ${pkg.version}`);
if (!semverRe.test(manifest.version || '')) fail(`extension/manifest.json version 非标准 X.Y.Z: ${manifest.version}`);
if (pkg.version !== manifest.version) {
  fail(`版本号不一致: package.json=${pkg.version}, extension/manifest.json=${manifest.version}`);
}
const version = manifest.version;
console.log(`[pack] 版本号校验通过: v${version}`);

// 2. Validate _locales/zh_CN and _locales/zh_TW
for (const locale of ['zh_CN', 'zh_TW']) {
  const msgPath = join(EXT_DIR, '_locales', locale, 'messages.json');
  const messages = readJson(msgPath);
  for (const key of ['extName', 'extDesc', 'actionTitle']) {
    const val = messages?.[key]?.message;
    if (typeof val !== 'string' || !val.trim()) {
      fail(`${msgPath} 缺少有效字段 ${key}.message`);
    }
  }
  const descLen = Array.from(messages.extDesc.message).length;
  if (descLen > 132) {
    fail(`${msgPath} extDesc.message 超过 Chrome 商店 132 字符限制 (${descLen})`);
  }
  console.log(`[pack] 语言包校验通过: ${locale} (extDesc ${descLen} 字)`);
}

// 3. Reject localhost / 127.0.0.1 in production host_permissions
const hostPerms = Array.isArray(manifest.host_permissions) ? manifest.host_permissions : [];
for (const perm of hostPerms) {
  if (/localhost|127\.0\.0\.1/i.test(perm)) {
    fail(`生产 manifest.json host_permissions 不得包含本地调试地址: ${perm}`);
  }
}
console.log('[pack] 生产权限校验通过 (无 localhost / 127.0.0.1)');

// 4. Run full test suite
console.log('[pack] 运行 npm test...');
execFileSync('npm', ['test'], { cwd: ROOT, stdio: 'inherit' });

// 5. Run public-copy lint if script is present
const copyCheckCandidates = [
  process.env.PUBLIC_COPY_CHECK_SCRIPT,
  join(homedir(), '.agents/skills/public-copy/scripts/check-copy.mjs'),
].filter(Boolean);
const copyCheckScript = copyCheckCandidates.find((p) => existsSync(p));
if (copyCheckScript) {
  const copyTargets = ['README.md', 'extension/_locales'];
  if (existsSync(join(ROOT, 'docs/store-listing.md'))) {
    copyTargets.unshift('docs/store-listing.md');
  }
  console.log(`[pack] 运行对外文案检查: ${copyTargets.join(' ')}`);
  execFileSync('node', [copyCheckScript, ...copyTargets], { cwd: ROOT, stdio: 'inherit' });
}

// 6. Build zip archive in dist/ with manifest.json at archive root
mkdirSync(DIST_DIR, { recursive: true });
const zipName = `baku-for-x-slop-v${version}.zip`;
const zipPath = join(DIST_DIR, zipName);
if (existsSync(zipPath)) rmSync(zipPath);

execFileSync(
  '/usr/bin/zip',
  ['-r', '-q', zipPath, '.', '-x', 'test/*', '*.DS_Store', '*/.DS_Store', '*.map'],
  { cwd: EXT_DIR, stdio: 'inherit' }
);

// 7. Verify zip archive contents
const listing = execFileSync('/usr/bin/unzip', ['-l', zipPath], { encoding: 'utf8' });
const requiredEntries = [
  'manifest.json',
  '_locales/zh_CN/messages.json',
  '_locales/zh_TW/messages.json',
  'assets/stages/baku-stage-1.webp',
];
for (const entry of requiredEntries) {
  if (!listing.includes(entry)) {
    fail(`压缩包缺少必要文件: ${entry}`);
  }
}
if (/(^|\s)test\//m.test(listing)) {
  fail('压缩包中意外包含了 test/ 目录');
}

const stats = statSync(zipPath);
console.log(`[pack] 打包完成: dist/${zipName} (${formatSize(stats.size)})`);
