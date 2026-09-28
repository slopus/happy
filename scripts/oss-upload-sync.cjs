// Upload only objects that are absent from an immutable OSS prefix. A matching
// size alone is insufficient: a retried build can produce different bytes.
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const aliyunBin = process.env.ALIYUN_BIN || 'aliyun';
const endpoint = process.env.OSS_UPLOAD_ENDPOINT || 'https://oss-cn-hangzhou.aliyuncs.com';
const addressingStyle = process.env.OSS_ADDRESSING_STYLE || 'virtual';

function aliyun(args, inherit = false) {
  return execFileSync(aliyunBin, args, {
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
    stdio: inherit ? 'inherit' : ['ignore', 'pipe', 'pipe'],
  });
}

function listObjects(bucket, prefix) {
  const objects = new Map();
  let continuationToken;
  do {
    const args = [
      'ossutil', 'api', 'list-objects-v2', '--bucket', bucket,
      '--prefix', prefix, '--max-keys', '1000', '--output-format', 'json',
      '--endpoint', endpoint, '--addressing-style', addressingStyle,
    ];
    if (continuationToken) args.push('--continuation-token', continuationToken);
    const page = JSON.parse(aliyun(args));
    const contents = page.Contents ? [].concat(page.Contents) : [];
    for (const object of contents) objects.set(object.Key, object);
    // ossutil renders the OSS XML boolean as a string ("false" is truthy).
    const isTruncated = page.IsTruncated === true || page.IsTruncated === 'true';
    continuationToken = isTruncated ? page.NextContinuationToken : undefined;
    if (isTruncated && !continuationToken) {
      throw new Error(`OSS listing ${prefix} is truncated without a continuation token`);
    }
  } while (continuationToken);
  return objects;
}

function localFiles(directory) {
  const files = [];
  function visit(current) {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const fullPath = path.join(current, entry.name);
      if (entry.isDirectory()) visit(fullPath);
      else if (entry.isFile()) files.push(fullPath);
      else throw new Error(`Unsupported export entry: ${fullPath}`);
    }
  }
  visit(directory);
  return files;
}

function md5(file) {
  return crypto.createHash('md5').update(fs.readFileSync(file)).digest('hex');
}

function matches(object, file) {
  return object && Number(object.Size) === file.size &&
    String(object.ETag || '').replace(/^"|"$/g, '').toLowerCase() === file.md5;
}

function syncDirectory(sourceDirectory, bucket, prefix, options = {}) {
  if (!prefix.endsWith('/')) throw new Error(`OSS prefix must end with /: ${prefix}`);
  const source = path.resolve(sourceDirectory);
  const files = localFiles(source).map((filePath) => {
    const relativePath = path.relative(source, filePath).split(path.sep).join('/');
    return {
      path: filePath,
      relativePath,
      key: prefix + relativePath,
      size: fs.statSync(filePath).size,
      md5: md5(filePath),
    };
  });
  const existing = listObjects(bucket, prefix);
  const missing = [];
  let reusedBytes = 0;
  for (const file of files) {
    const remote = existing.get(file.key);
    if (matches(remote, file)) {
      reusedBytes += file.size;
    } else if (remote) {
      throw new Error(`Immutable OSS object differs from local content: ${file.key}`);
    } else {
      missing.push(file);
    }
  }

  if (missing.length) {
    const staging = fs.mkdtempSync(path.join(os.tmpdir(), 'paws-oss-upload-'));
    try {
      for (const file of missing) {
        const stagedPath = path.join(staging, file.relativePath);
        fs.mkdirSync(path.dirname(stagedPath), { recursive: true });
        fs.copyFileSync(file.path, stagedPath);
      }
      const args = [
        'ossutil', 'cp', '-r', `${staging}/`, `oss://${bucket}/${prefix}`,
        '--force', '--bigfile-threshold', '5G',
        '--endpoint', endpoint, '--addressing-style', addressingStyle,
      ];
      if (options.cacheControl) args.push('--cache-control', options.cacheControl);
      if (options.contentType) args.push('--content-type', options.contentType);
      aliyun(args, true);
    } finally {
      fs.rmSync(staging, { recursive: true, force: true });
    }
  }

  const uploaded = listObjects(bucket, prefix);
  for (const file of files) {
    if (!matches(uploaded.get(file.key), file)) {
      throw new Error(`OSS object failed checksum verification: ${file.key}`);
    }
  }
  const uploadedBytes = missing.reduce((sum, file) => sum + file.size, 0);
  console.log(`OSS sync ${prefix}: ${missing.length} uploaded (${uploadedBytes} B), ${files.length - missing.length} reused (${reusedBytes} B)`);
  return { uploadedFiles: missing.length, uploadedBytes, reusedFiles: files.length - missing.length, reusedBytes };
}

if (require.main === module) {
  const [source, bucket, prefix, cacheControl] = process.argv.slice(2);
  if (!source || !bucket || !prefix) {
    console.error('Usage: node scripts/oss-upload-sync.cjs <source-directory> <bucket> <prefix> [cache-control]');
    process.exit(2);
  }
  try {
    syncDirectory(source, bucket, prefix, { cacheControl });
  } catch (error) {
    console.error(error.stderr ? error.stderr.toString() : error.message);
    process.exit(1);
  }
}

module.exports = { syncDirectory };
