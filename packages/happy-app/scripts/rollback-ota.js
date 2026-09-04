// scripts/rollback-ota.js
// 作用：交互式回退自建 OTA 到任意历史版本。
// 用法：pnpm ota:rollback [--channel <channel>] [--platform <platform>] [--runtime-version <runtime>]
//   --channel  回退哪个频道，缺省 production
//   --platform 平台，缺省 android
//   --runtime-version  覆盖默认 runtime；默认 preview/development=23，production=24
//
// 原理：每次 publish-ota.js 发布都会在 OSS 留一份按时间戳命名的 manifest 备份
//（manifests/<platform>/<runtime>/<channel>/<时间戳>.json），而 latest.json 只是「当前线上」指针。
// 回退 = 把选中的历史 manifest 覆盖回 latest.json。对应的 JS 包从不删除，所以老版本始终可用。
//
// 凭证来源：复用 aliyun CLI 默认 profile（~/.aliyun/config.json），需能读写该桶。

const readline = require('readline');
const { execFileSync } = require('child_process');
const { defaultRuntimeVersion } = require('./ota-runtime-config.js');

// ---- 解析命令行参数（--channel / --platform） ----
function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--channel') out.channel = argv[++i];
    else if (a === '--platform') out.platform = argv[++i];
    else if (a === '--runtime-version' || a === '--runtime') out.runtimeVersion = argv[++i];
    else if (a.startsWith('--channel=')) out.channel = a.slice('--channel='.length);
    else if (a.startsWith('--platform=')) out.platform = a.slice('--platform='.length);
    else if (a.startsWith('--runtime-version=')) out.runtimeVersion = a.slice('--runtime-version='.length);
    else if (a.startsWith('--runtime=')) out.runtimeVersion = a.slice('--runtime='.length);
  }
  return out;
}
const ARGS = parseArgs(process.argv.slice(2));

// ============ 配置区：与 publish-ota.js 保持一致 ============
const BUCKET = 'happy-app-ota-jacky';
const REGION = 'oss-cn-hangzhou';
const PLATFORM = ARGS.platform || 'android';
const CHANNEL = ARGS.channel || 'production';
const RUNTIME_VERSION = ARGS.runtimeVersion || process.env.HAPPY_OTA_RUNTIME_VERSION || defaultRuntimeVersion(CHANNEL);
const ALIYUN_BIN = process.env.ALIYUN_BIN || 'aliyun';
// ==========================================================

const PREFIX = `manifests/${PLATFORM}/${RUNTIME_VERSION}/${CHANNEL}/`;
const LATEST_KEY = `${PREFIX}latest.json`;
const META_PREFIX = `meta/${PLATFORM}/${RUNTIME_VERSION}/${CHANNEL}/`; // 轻量版本元信息（含 git commit）

// 把毫秒时间戳格式化成 本地可读时间
function fmtTime(ms) {
  const d = new Date(Number(ms));
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ` +
    `${p(d.getHours())}:${p(d.getMinutes())}`;
}

// 列出 OSS 上某前缀下的对象，返回 [{ key, etag }]
function listObjects() {
  const out = execFileSync(
    ALIYUN_BIN,
    ['ossutil', 'ls', `oss://${BUCKET}/${PREFIX}`],
    { encoding: 'utf8' }
  );
  const rows = [];
  for (const line of out.split('\n')) {
    // 每行形如：<时间> ... <Size> Standard <ETAG(32hex)> oss://bucket/key.json
    const m = line.match(/([A-Fa-f0-9]{32})\s+(oss:\/\/\S+\.json)\s*$/);
    if (m) rows.push({ etag: m[1].toUpperCase(), key: m[2] });
  }
  return rows;
}

// 读取某版本的轻量 meta（含 git commit）。老版本发布时未记录则返回 null。
function readMeta(stamp) {
  try {
    const out = execFileSync(
      ALIYUN_BIN,
      ['ossutil', 'cat', `oss://${BUCKET}/${META_PREFIX}${stamp}.json`],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }
    );
    return JSON.parse(out);
  } catch (e) {
    return null;
  }
}

// 把一个版本的信息压成一行简短描述，供菜单展示
function describeVersion(meta) {
  if (!meta || !meta.git || !meta.git.sha) return '(无 commit 记录)';
  const g = meta.git;
  const title = meta.display && meta.display.title ? ` ${meta.display.title}` : '';
  const dirty = g.dirty ? '*' : '';
  const subject = g.subject ? ' ' + g.subject : '';
  return `${g.sha}${dirty}${title || subject}`;
}

// 问一个问题，返回用户输入（去空白）
function ask(rl, q) {
  return new Promise((resolve) => rl.question(q, (a) => resolve(a.trim())));
}

async function main() {
  // 0) 自检 aliyun 可用
  try {
    execFileSync(ALIYUN_BIN, ['ossutil', 'version'], { stdio: 'ignore' });
  } catch (e) {
    console.error('错误：找不到可用的 aliyun CLI（ossutil）。请先安装并 `aliyun configure`。');
    process.exit(1);
  }

  // 1) 拉取对象列表
  const objs = listObjects();
  const latest = objs.find((o) => o.key.endsWith('/latest.json'));
  // 历史版本：排除 latest.json，按时间戳升序
  const versions = objs
    .filter((o) => !o.key.endsWith('/latest.json'))
    .map((o) => {
      const stamp = o.key.match(/\/(\d{10,})\.json$/);
      return { ...o, stamp: stamp ? stamp[1] : null };
    })
    .filter((o) => o.stamp)
    .sort((a, b) => Number(a.stamp) - Number(b.stamp));

  if (versions.length === 0) {
    console.error('没有找到任何历史版本（manifests 目录为空？）。');
    process.exit(1);
  }

  // 2) 用 etag 判断当前线上指向哪个版本
  const currentStamp = latest
    ? (versions.find((v) => v.etag === latest.etag) || {}).stamp
    : null;

  // 3) 为每个版本读取 meta（commit 信息），再打印菜单
  console.log(`\n  频道 ${CHANNEL} · 平台 ${PLATFORM} · runtimeVersion ${RUNTIME_VERSION}\n`);
  for (const v of versions) {
    v.desc = describeVersion(readMeta(v.stamp));
  }
  versions.forEach((v, i) => {
    const isCurrent = v.stamp === currentStamp;
    const tag = isCurrent ? '  ← 当前线上' : '';
    console.log(`  [${String(i + 1).padStart(2)}] ${fmtTime(v.stamp)}  ${v.desc}${tag}`);
  });
  console.log('');

  // 4) 交互选择
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const input = await ask(rl, `请选择要回退到的版本序号（1-${versions.length}，回车取消）> `);
  if (!input) {
    console.log('已取消。');
    rl.close();
    return;
  }
  const idx = Number(input) - 1;
  if (!Number.isInteger(idx) || idx < 0 || idx >= versions.length) {
    console.error('无效的序号。');
    rl.close();
    process.exit(1);
  }
  const target = versions[idx];

  if (target.stamp === currentStamp) {
    console.log('该版本已经是当前线上版本，无需回退。');
    rl.close();
    return;
  }

  const confirm = await ask(
    rl,
    `确认把线上切到 ${target.stamp}（${fmtTime(target.stamp)}）？(y/N) > `
  );
  rl.close();
  if (confirm.toLowerCase() !== 'y') {
    console.log('已取消。');
    return;
  }

  // 5) 覆盖 latest.json
  console.log('正在切换...');
  execFileSync(
    ALIYUN_BIN,
    ['ossutil', 'cp', `oss://${BUCKET}/${target.key}`, `oss://${BUCKET}/${LATEST_KEY}`,
      '--force'],
    { stdio: ['ignore', 'pipe', 'pipe'] }
  );

  console.log(`\n✅ 已回退到 ${target.stamp}（${fmtTime(target.stamp)}）`);
  console.log('   手机端杀掉 App 重开两次即可拉到该版本。');
}

main().catch((err) => {
  console.error('回退失败:', (err && (err.stderr ? err.stderr.toString() : err.message)) || err);
  process.exit(1);
});
