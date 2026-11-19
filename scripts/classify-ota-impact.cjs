// Keep automatic OTA conservative: only explicit Web files may bypass it.
// A component name or a Platform.OS branch alone cannot establish that its
// shared imports and module-level effects are absent from the Android bundle.
const fs = require('node:fs');
const { execFileSync } = require('node:child_process');
const { posix } = require('node:path');

const nativeFiles = new Set([
  'packages/happy-app/app.config.js', 'packages/happy-app/expo-project.json',
  'packages/happy-app/google-services.json', 'packages/happy-app/package.json',
  'packages/happy-app/ota-runtime-versions.json', 'packages/happy-app/ota-ios-runtime-versions.json',
  'packages/happy-app/eas.json', 'patches/fix-expo-camera-scanner-transitions.cjs',
  'scripts/postinstall.cjs', 'pnpm-lock.yaml',
]);
const descriptions = {
  manual: '手动触发 OTA，沿用显式发布操作。',
  'native-sensitive': '包含原生依赖或配置变更；跳过 OTA，需要匹配的原生安装包。',
  'mobile-or-shared': '包含手机或共享运行代码；保守执行 OTA。',
  'web-only': '仅 Web 运行文件改变；跳过手机 OTA 构建和上传。',
  'no-runtime-change': '没有手机运行代码变更；跳过 OTA。',
};

// Removing an unrelated workspace importer does not change the App native graph.
// Retained dependency records must stay byte-for-byte identical; only
// unreachable package/snapshot records may be pruned with the importer.
function onlyRemovedWorkspaceImporters(before, after, deletedManifests) {
  const removable = new Set(deletedManifests
    .filter(file => /^packages\/[^/]+\/package\.json$/.test(file) && file !== 'packages/happy-app/package.json')
    .map(file => file.slice(0, -'/package.json'.length)));
  if (!removable.size) return false;
  const start = before.indexOf('\nimporters:\n');
  const end = before.indexOf('\npackages:\n', start);
  if (start < 0 || end < 0) return false;
  const importers = before.slice(start, end).replace(/^  ([^ \n][^\n]*):\n[\s\S]*?(?=^  [^ \n]|$(?![\s\S]))/gm,
    (block, key) => removable.has(key) ? '' : block);
  const stripped = before.slice(0, start) + importers + before.slice(end);
  return stripped === after || onlyPrunedLockRecords(stripped, after, removable);
}

// This deliberately supports only pnpm's stable v9 block layout. Unknown shapes
// fail closed; it is not a general YAML parser and adds no CI runtime dependency.
function onlyPrunedLockRecords(before, after, removedImporters) {
  const unquote = value => {
    if (value.startsWith("'")) return value.endsWith("'") ? value.slice(1, -1).replaceAll("''", "'") : null;
    if (value.startsWith('"')) { try { return JSON.parse(value); } catch { return null; } }
    return value;
  };
  const records = text => {
    const starts = [...text.matchAll(/^  (\S.*):(?: \{\})?$/gm)];
    if (text.slice(0, starts[0]?.index ?? text.length).trim()) return null;
    const result = new Map();
    for (let i = 0; i < starts.length; i++) {
      const key = unquote(starts[i][1]);
      if (!key || result.has(key)) return null;
      result.set(key, text.slice(starts[i].index, starts[i + 1]?.index ?? text.length));
    }
    return result;
  };
  const sections = text => {
    const match = text.match(/^([\s\S]*?\npackages:\n)([\s\S]*?)\nsnapshots:\n([\s\S]*)$/);
    if (!match) return null;
    return { header: match[1], packages: records(match[2]), snapshots: records(match[3]) };
  };
  const a = sections(before), b = sections(after);
  if (!a || !b || a.header !== b.header || !a.packages || !b.packages || !a.snapshots || !b.snapshots) return false;
  // Record separators may lose blank lines when their final neighbor is pruned.
  for (const kind of ['packages', 'snapshots']) {
    for (const [key, block] of b[kind]) {
      const original = a[kind].get(key);
      if (original === undefined || original.replace(/\n+$/, '') !== block.replace(/\n+$/, '')) return false;
    }
  }
  // Every surviving snapshot must retain the package metadata it originally used.
  for (const key of b.snapshots.keys()) {
    const base = key.split('(')[0];
    if (a.packages.has(base) && !b.packages.has(base)) return false;
  }
  const retainedImporters = records(b.header.slice(b.header.indexOf('\nimporters:\n') + '\nimporters:\n'.length, -'\npackages:\n'.length));
  if (!retainedImporters) return false;
  const removedVersions = new Set(['packages', 'snapshots'].flatMap(kind => [...a[kind].keys()].filter(key => !b[kind].has(key)).map(key => key.split('(')[0])));
  const exists = (name, version, owner) => {
    if (!name || !version) return false;
    if (version.startsWith('link:')) {
      return !!owner && !removedImporters.has(posix.normalize(posix.join(owner, version.slice(5))));
    }
    const key = /^(?:@[^/\s:@]+\/)?[^@()\s:/]+@\d/.test(version) ? version : `${name}@${version}`;
    if (a.snapshots.has(key)) return b.snapshots.has(key);
    // Some existing locks omit a peer-context variant referenced by an importer.
    // Do not bless a changed graph: such an unchanged reference is safe only
    // when no record of that exact package version was removed at all.
    return /^(?:@[^/\s:@]+\/)?[^@()\s:/]+@\d[^\s]*$/.test(key) && !removedVersions.has(key.split('(')[0]);
  };
  for (const [owner, block] of retainedImporters) {
    let dependency;
    for (const line of block.split('\n')) {
      if (/^    \S/.test(line)) dependency = undefined;
      const name = line.match(/^      (.+):$/);
      if (name) dependency = unquote(name[1]);
      const version = line.match(/^        version: (.+)$/);
      if (version && !exists(dependency, unquote(version[1]), owner)) return false;
    }
  }
  for (const block of b.snapshots.values()) {
    for (const line of block.split('\n')) {
      const ref = line.match(/^      (.+): (.+)$/);
      if (ref && !exists(unquote(ref[1]), unquote(ref[2]))) return false;
    }
  }
  return true;
}

function classifyOtaImpact(paths, eventName) {
  if (eventName === 'workflow_dispatch') {
    return { otaCompatible: true, reason: 'manual', native: [], mobile: [], web: [] };
  }
  const native = [], mobile = [], web = [];
  for (const file of new Set(paths)) {
    if (nativeFiles.has(file) || /^packages\/happy-app\/(android|ios|plugins)\//.test(file)) {
      native.push(file);
    } else if (!file.startsWith('packages/happy-app/')) {
      continue;
    } else if (/\.(?:md|d\.ts)$/.test(file) || /\.(?:test|spec)\.[^/]+$/.test(file)
      || /^packages\/happy-app\/(?:scripts|e2e)\//.test(file)
      || /^packages\/happy-app\/sources\/(?:trash|test)\//.test(file)
      || /\/(?:__tests__|__mocks__)\//.test(file)) {
      continue;
    } else if (/\.web\.(?:[cm]?[jt]sx?|css)$/.test(file) || file.startsWith('packages/happy-app/public/')) {
      web.push(file);
    } else {
      mobile.push(file);
    }
  }
  const reason = native.length ? 'native-sensitive' : mobile.length ? 'mobile-or-shared'
    : web.length ? 'web-only' : 'no-runtime-change';
  return { otaCompatible: !native.length && !!mobile.length, reason, native, mobile, web };
}

if (require.main === module) {
  try {
    const eventName = process.env.GITHUB_EVENT_NAME;
    let paths = [];
    if (eventName !== 'workflow_dispatch') {
      const { BASE_SHA: base, HEAD_SHA: head } = process.env;
      if (![base, head].every(value => /^[a-f0-9]{40}$/i.test(value ?? '') && !/^0+$/.test(value))) {
        throw new Error('A valid BASE_SHA and HEAD_SHA are required; refusing an uncertain OTA classification');
      }
      // Renames must include both sides: deleting a mobile implementation is
      // still mobile-affecting even when its replacement has a .web suffix.
      paths = execFileSync('git', ['diff', '--name-only', '--no-renames', '-z', base, head], { encoding: 'utf8' }).split('\0').filter(Boolean);
    }
    if (paths.includes('pnpm-lock.yaml')) {
      const { BASE_SHA: base, HEAD_SHA: head } = process.env;
      const deleted = execFileSync('git', ['diff', '--diff-filter=D', '--name-only', '-z', base, head], { encoding: 'utf8' }).split('\0').filter(Boolean);
      const readLock = sha => execFileSync('git', ['show', `${sha}:pnpm-lock.yaml`], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
      if (onlyRemovedWorkspaceImporters(readLock(base), readLock(head), deleted)) {
        paths = paths.filter(file => file !== 'pnpm-lock.yaml');
      }
    }
    const result = classifyOtaImpact(paths, eventName);
    if (process.env.GITHUB_OUTPUT) {
      fs.appendFileSync(process.env.GITHUB_OUTPUT, `ota_compatible=${result.otaCompatible}\ndelivery_reason=${result.reason}\n`);
    }
    if (process.env.GITHUB_STEP_SUMMARY) {
      fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, `### OTA 发布判定\n\n${descriptions[result.reason]}\n\nWeb 文件：${result.web.length}；手机/共享文件：${result.mobile.length}；原生敏感文件：${result.native.length}。\n`);
    }
    console.log(JSON.stringify({ ...result, description: descriptions[result.reason] }, null, 2));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}

module.exports = { classifyOtaImpact, onlyRemovedWorkspaceImporters };
