// Keep automatic OTA conservative: only explicit Web files may bypass it.
// A component name or a Platform.OS branch alone cannot establish that its
// shared imports and module-level effects are absent from the Android bundle.
const fs = require('node:fs');
const { execFileSync } = require('node:child_process');

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

module.exports = { classifyOtaImpact };
