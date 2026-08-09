// scripts/publish-ota.js
// 作用：把 `expo export` 的产物上传到阿里云 OSS，并生成 Expo Updates 协议要求的 manifest 清单。
// 用法：node scripts/publish-ota.js [--channel <channel>] [--platform <platform>] [--runtime-version <runtime>] [--skip-latest]
//   --channel  发布到哪个频道，缺省 production；预览发 preview（仅装了 preview 包的设备会拉到）
//   --platform 平台，缺省 android
//   --runtime-version  覆盖默认 runtime；默认 preview/development=22，production=23
//   --skip-latest 只发布时间戳版本和 meta，不覆盖频道 latest.json。PR 自动预览用它避免互相覆盖。
//   人类可读展示信息可通过环境变量传入，或在 GitHub Actions 中从 GITHUB_EVENT_PATH 自动读取：
//     OTA_DISPLAY_TITLE / OTA_DISPLAY_MESSAGE / OTA_SOURCE_TYPE / OTA_SOURCE_NUMBER / OTA_SOURCE_URL
//   本地也可以用参数传入：
//     --display-title "能力中心快捷指令与返回逻辑" --display-message "移除最近资源，新增快捷指令。"
//
// 凭证来源：本脚本通过 `aliyun ossutil` 上传，复用 aliyun CLI 已配置的默认 profile 凭证
//（~/.aliyun/config.json），因此无需在环境变量里再写 AccessKey。
// 前提：本机已 `aliyun configure` 配好可读写该桶的凭证。

const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { execFileSync } = require('child_process');
const { defaultRuntimeVersion } = require('./ota-runtime-config.js');

// ---- 解析命令行参数（--channel / --platform / --runtime-version） ----
function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--channel') out.channel = argv[++i];
    else if (a === '--platform') out.platform = argv[++i];
    else if (a === '--runtime-version' || a === '--runtime') out.runtimeVersion = argv[++i];
    else if (a === '--display-title') out.displayTitle = argv[++i];
    else if (a === '--display-message') out.displayMessage = argv[++i];
    else if (a === '--source-type') out.sourceType = argv[++i];
    else if (a === '--source-number') out.sourceNumber = argv[++i];
    else if (a === '--source-url') out.sourceUrl = argv[++i];
    else if (a === '--skip-latest') out.skipLatest = true;
    else if (a === '--write-latest') out.skipLatest = false;
    else if (a.startsWith('--channel=')) out.channel = a.slice('--channel='.length);
    else if (a.startsWith('--platform=')) out.platform = a.slice('--platform='.length);
    else if (a.startsWith('--runtime-version=')) out.runtimeVersion = a.slice('--runtime-version='.length);
    else if (a.startsWith('--runtime=')) out.runtimeVersion = a.slice('--runtime='.length);
    else if (a.startsWith('--display-title=')) out.displayTitle = a.slice('--display-title='.length);
    else if (a.startsWith('--display-message=')) out.displayMessage = a.slice('--display-message='.length);
    else if (a.startsWith('--source-type=')) out.sourceType = a.slice('--source-type='.length);
    else if (a.startsWith('--source-number=')) out.sourceNumber = a.slice('--source-number='.length);
    else if (a.startsWith('--source-url=')) out.sourceUrl = a.slice('--source-url='.length);
    else if (a.startsWith('--latest=')) out.skipLatest = !/^(1|true|yes)$/i.test(a.slice('--latest='.length));
  }
  return out;
}
const ARGS = parseArgs(process.argv.slice(2));

// ============ 配置区：按你自己的情况修改 ============
const BUCKET = 'happy-app-ota-jacky';          // OSS 桶名
const REGION = 'oss-cn-hangzhou';              // OSS 地域
const PLATFORM = ARGS.platform || 'android';   // 平台（--platform 覆盖）
const CHANNEL = ARGS.channel || 'production';  // 频道（--channel 覆盖），缺省 production 保持旧行为
const RUNTIME_VERSION = ARGS.runtimeVersion || process.env.HAPPY_OTA_RUNTIME_VERSION || defaultRuntimeVersion(CHANNEL);
const WRITE_LATEST = !ARGS.skipLatest;          // PR 预览可跳过 latest，避免覆盖其他 PR
const DIST_DIR = path.join(__dirname, '..', 'dist'); // expo export 输出目录
const ALIYUN_BIN = process.env.ALIYUN_BIN || 'aliyun'; // aliyun CLI 可执行名/路径
const OSS_UPLOAD_ENDPOINT = process.env.OSS_UPLOAD_ENDPOINT || `https://${REGION}.aliyuncs.com`;
const OSS_ADDRESSING_STYLE = process.env.OSS_ADDRESSING_STYLE || 'virtual';
// OSS 公开访问域名（https）
const OSS_PUBLIC_BASE = `https://${BUCKET}.${REGION}.aliyuncs.com`;
// ===================================================

// ---- 工具函数 ----

// sha256 → URL 安全 base64（manifest 的 hash 字段要求这个格式）
function sha256Base64URL(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('base64')
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

// md5 十六进制，作为缓存键 key
function md5Hex(buffer) {
  return crypto.createHash('md5').update(buffer).digest('hex');
}

// 扩展名 → contentType
function mimeOf(ext) {
  const map = {
    png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg',
    gif: 'image/gif', webp: 'image/webp', svg: 'image/svg+xml',
    ttf: 'font/ttf', otf: 'font/otf', woff: 'font/woff', woff2: 'font/woff2',
    json: 'application/json', mp4: 'video/mp4', mp3: 'audio/mpeg',
  };
  return map[(ext || '').toLowerCase()] || 'application/octet-stream';
}

// hash 十六进制 → UUID（manifest 的 id 字段要求 UUID 格式）
function toUUID(hashHex) {
  const h = hashHex.slice(0, 32);
  return (
    h.slice(0, 8) + '-' + h.slice(8, 12) + '-' + h.slice(12, 16) + '-' +
    h.slice(16, 20) + '-' + h.slice(20, 32)
  );
}

// 读取当前 git 信息，作为本次 OTA 版本的人类可读标识（任何子命令失败都退化为空字段，不影响发布）
function gitInfo() {
  const run = (args) => {
    try {
      return execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    } catch (e) {
      return '';
    }
  };
  return {
    sha: run(['rev-parse', '--short', 'HEAD']),
    branch: run(['rev-parse', '--abbrev-ref', 'HEAD']),
    subject: run(['log', '-1', '--pretty=%s']),
    dirty: run(['status', '--porcelain']).length > 0, // 工作区有未提交改动时为 true
  };
}

function githubEventDisplayInfo() {
  const eventPath = process.env.GITHUB_EVENT_PATH;
  if (!eventPath) return {};
  try {
    const event = JSON.parse(fs.readFileSync(eventPath, 'utf8'));
    const pr = event.pull_request;
    if (!pr) return {};
    return {
      title: pr.title,
      message: pr.body,
      sourceType: 'pull_request',
      sourceNumber: pr.number,
      sourceUrl: pr.html_url,
    };
  } catch (e) {
    return {};
  }
}

// 读取 CI/本地注入的人类可读展示信息。PR 预览 OTA 用它记录中文标题和说明，
// 避免列表只能看到自动 merge commit。
function displayInfo(git) {
  const eventDisplay = githubEventDisplayInfo();
  const clean = (value, maxLength) => {
    if (!value) return '';
    return String(value).replace(/\r\n/g, '\n').trim().slice(0, maxLength);
  };
  const title = clean(ARGS.displayTitle || process.env.OTA_DISPLAY_TITLE || eventDisplay.title, 160);
  const message = clean(ARGS.displayMessage || process.env.OTA_DISPLAY_MESSAGE || eventDisplay.message, 2000);
  const sourceType = clean(ARGS.sourceType || process.env.OTA_SOURCE_TYPE || eventDisplay.sourceType, 40);
  const sourceNumber = clean(ARGS.sourceNumber || process.env.OTA_SOURCE_NUMBER || eventDisplay.sourceNumber, 40);
  const sourceUrl = clean(ARGS.sourceUrl || process.env.OTA_SOURCE_URL || eventDisplay.sourceUrl, 400);
  if (CHANNEL === 'preview' && git.dirty && !title) {
    console.error([
      '错误：当前工作区有未提交改动，发布 preview OTA 必须提供人类可读标题。',
      '这样 OTA 版本页才能一眼看出应该选择哪个包。',
      '',
      '示例：',
      '  OTA_DISPLAY_TITLE="能力中心快捷指令与返回逻辑" \\',
      '  OTA_DISPLAY_MESSAGE="移除最近资源，新增快捷指令，并修正右侧面板返回逻辑。" \\',
      '  pnpm ota:selfhost:preview',
      '',
      '或：',
      '  pnpm ota:selfhost:preview -- --display-title "能力中心快捷指令与返回逻辑"',
    ].join('\n'));
    process.exit(1);
  }
  const source = {};
  if (sourceType) source.type = sourceType;
  if (sourceNumber) source.number = sourceNumber;
  if (sourceUrl) source.url = sourceUrl;
  const out = {};
  if (title) out.title = title;
  if (message) out.message = message;
  if (Object.keys(source).length > 0) out.source = source;
  return out;
}

// 用 aliyun ossutil 上传一个本地文件到 OSS 指定 key
function ossUpload(localPath, ossKey, contentType) {
  execFileSync(
    ALIYUN_BIN,
    ['ossutil', 'cp', localPath, `oss://${BUCKET}/${ossKey}`,
      '--force', '--content-type', contentType,
      '--endpoint', OSS_UPLOAD_ENDPOINT,
      '--addressing-style', OSS_ADDRESSING_STYLE],
    { stdio: ['ignore', 'pipe', 'pipe'] }
  );
  console.log('  已上传:', ossKey);
}

// 整目录递归上传到 OSS 指定前缀（assets 有几百个文件，逐个起进程太慢，一次性传）
function ossUploadDir(localDir, ossPrefix) {
  execFileSync(
    ALIYUN_BIN,
    ['ossutil', 'cp', localDir.replace(/\/?$/, '/'), `oss://${BUCKET}/${ossPrefix}`,
      '-r', '--force',
      '--endpoint', OSS_UPLOAD_ENDPOINT,
      '--addressing-style', OSS_ADDRESSING_STYLE],
    { stdio: ['ignore', 'inherit', 'inherit'] }
  );
}

// ---- 主流程 ----
async function main() {
  // 0) 自检 aliyun 是否可用
  try {
    execFileSync(ALIYUN_BIN, ['ossutil', 'version'], { stdio: 'ignore' });
  } catch (e) {
    console.error('错误：找不到可用的 aliyun CLI（ossutil）。请先安装并 `aliyun configure`。');
    process.exit(1);
  }

  // 1) 读取 metadata.json
  const metaPath = path.join(DIST_DIR, 'metadata.json');
  if (!fs.existsSync(metaPath)) {
    console.error(`错误：找不到 ${metaPath}。请先运行 npx expo export --platform ${PLATFORM}`);
    process.exit(1);
  }
  const metadata = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
  const fileMeta = metadata.fileMetadata[PLATFORM];
  if (!fileMeta) {
    console.error(`错误：metadata.json 里没有 ${PLATFORM} 平台数据，确认 export 时带了 --platform ${PLATFORM}`);
    process.exit(1);
  }

  // 2) 先读取/校验展示元信息。dirty preview 缺少标题时必须在任何上传前失败，
  //    避免 OSS 上留下无法从 App 入口选择的无用版本对象。
  const git = gitInfo();
  const display = displayInfo(git);

  // 3) 本次发布目录（时间戳，保证唯一、可回滚）
  const stamp = String(Date.now());
  const baseKey = `updates/${PLATFORM}/${RUNTIME_VERSION}/${stamp}`;
  console.log('本次发布目录:', baseKey);
  console.log('上传端点:', OSS_UPLOAD_ENDPOINT, '· addressing:', OSS_ADDRESSING_STYLE);

  // 4) JS 主包（launchAsset）
  const bundleRelPath = fileMeta.bundle;
  const bundleBuf = fs.readFileSync(path.join(DIST_DIR, bundleRelPath));
  const bundleKey = `${baseKey}/bundle.js`;
  ossUpload(path.join(DIST_DIR, bundleRelPath), bundleKey, 'application/javascript');
  const launchAsset = {
    hash: sha256Base64URL(bundleBuf),
    key: md5Hex(bundleBuf),
    contentType: 'application/javascript',
    url: `${OSS_PUBLIC_BASE}/${bundleKey}`,
  };

  // 5) 资源 assets：整目录递归上传一次（dist/assets/ 下全是扁平 hash 文件名）
  const assetList = fileMeta.assets || [];
  if (assetList.length > 0) {
    console.log(`上传 assets 目录（${assetList.length} 个引用 / 去重后若干）...`);
    ossUploadDir(path.join(DIST_DIR, 'assets'), `${baseKey}/assets/`);
  }
  // 再在本地为每个 asset 算 hash/key、拼 manifest 条目（url 用 a.path，即 assets/<hash>）
  const assets = assetList.map((a) => {
    const assetBuf = fs.readFileSync(path.join(DIST_DIR, a.path));
    return {
      hash: sha256Base64URL(assetBuf),
      key: md5Hex(assetBuf),
      contentType: mimeOf(a.ext),
      fileExtension: '.' + a.ext,
      url: `${OSS_PUBLIC_BASE}/${baseKey}/${a.path}`,
    };
  });

  // 6) 组装 manifest（extra.git 记录本次发布对应的 commit，回退时据此辨认是哪个版本）
  const manifest = {
    id: toUUID(crypto.createHash('sha256').update(bundleBuf.toString('hex') + stamp).digest('hex')),
    createdAt: new Date(Number(stamp)).toISOString(),
    runtimeVersion: RUNTIME_VERSION,
    launchAsset,
    assets,
    metadata: {},
    extra: { git, display },
  };

  // 7) 上传 manifest 到频道下的时间戳版本；按需覆盖 latest.json。先写临时文件再传。
  //    路径含 channel 段：manifests/<platform>/<runtime>/<channel>/latest.json
  const tmpManifest = path.join(os.tmpdir(), `ota-manifest-${stamp}.json`);
  fs.writeFileSync(tmpManifest, JSON.stringify(manifest, null, 2));
  const channelPrefix = `manifests/${PLATFORM}/${RUNTIME_VERSION}/${CHANNEL}`;
  const manifestKey = `${channelPrefix}/latest.json`;
  // 同时按时间戳留一份备份，方便回滚
  const stampedManifestKey = `${channelPrefix}/${stamp}.json`;
  ossUpload(tmpManifest, stampedManifestKey, 'application/json');
  if (WRITE_LATEST) {
    ossUpload(tmpManifest, manifestKey, 'application/json');
  } else {
    console.log('  跳过 latest.json 覆盖:', manifestKey);
  }
  fs.unlinkSync(tmpManifest);

  // 8) 额外上传一份轻量「版本元信息」（meta），只含时间戳 + git + display。
  //    回退脚本读这个小文件即可展示「这是哪个 commit」，无需下载体积较大的整份 manifest。
  const meta = { stamp, createdAt: manifest.createdAt, id: manifest.id, channel: CHANNEL, git, display };
  const tmpMeta = path.join(os.tmpdir(), `ota-meta-${stamp}.json`);
  fs.writeFileSync(tmpMeta, JSON.stringify(meta, null, 2));
  ossUpload(tmpMeta, `meta/${PLATFORM}/${RUNTIME_VERSION}/${CHANNEL}/${stamp}.json`, 'application/json');
  fs.unlinkSync(tmpMeta);

  console.log('\n✅ 发布完成！');
  console.log('频道:', CHANNEL, '· 平台:', PLATFORM, '· runtimeVersion:', RUNTIME_VERSION);
  console.log('manifest 地址:', `${OSS_PUBLIC_BASE}/${WRITE_LATEST ? manifestKey : stampedManifestKey}`);
  console.log('时间戳版本:', stamp);
  console.log('覆盖 latest:', WRITE_LATEST ? 'yes' : 'no');
  console.log('新版本 id:', manifest.id);
  if (git.sha) {
    console.log('对应 commit:', `${git.sha}${git.dirty ? '*' : ''} ${git.subject}`);
  }
  if (display.title) {
    console.log('展示标题:', display.title);
  }

  // 9) CI 集成：若在 GitHub Actions 中（设置了 GITHUB_OUTPUT），把版本信息写入 step output，
  //    供后续步骤在 PR 上评论「预览已发布」。本地运行时该变量不存在，自动跳过。
  if (process.env.GITHUB_OUTPUT) {
    const lines = [
      `ota_id=${manifest.id}`,
      `ota_channel=${CHANNEL}`,
      `ota_platform=${PLATFORM}`,
      `ota_runtime=${RUNTIME_VERSION}`,
      `ota_stamp=${stamp}`,
      `ota_manifest_url=${OSS_PUBLIC_BASE}/${WRITE_LATEST ? manifestKey : stampedManifestKey}`,
      `ota_stamped_manifest_url=${OSS_PUBLIC_BASE}/${stampedManifestKey}`,
      `ota_latest_updated=${WRITE_LATEST ? 'true' : 'false'}`,
      `ota_deep_link=paws://ota-switch?channel=${CHANNEL}&stamp=${stamp}`,
      `ota_commit=${git.sha || ''}`,
    ];
    fs.appendFileSync(process.env.GITHUB_OUTPUT, lines.join('\n') + '\n');
  }
}

main().catch((err) => {
  console.error('发布失败:', err && (err.stderr ? err.stderr.toString() : err.message) || err);
  process.exit(1);
});
