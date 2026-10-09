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
const multipartThreshold = 8 * 1024 * 1024;
const multipartPartSize = 1024 * 1024;

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

function fileChecksums(file) {
  const bytes = fs.readFileSync(file);
  const md5 = crypto.createHash('md5').update(bytes).digest('hex');
  if (bytes.length <= multipartThreshold) return { md5 };
  // OSS 的分片 ETag 是各分片大写 MD5 文本拼接后的 MD5，加上分片数量。
  const parts = [];
  for (let offset = 0; offset < bytes.length; offset += multipartPartSize) {
    parts.push(crypto.createHash('md5').update(bytes.subarray(offset, offset + multipartPartSize)).digest('hex').toUpperCase());
  }
  const multipartETag = crypto.createHash('md5').update(parts.join('')).digest('hex') + '-' + parts.length;
  return { md5, multipartETag };
}

function matches(object, file) {
  const etag = String(object?.ETag || '').replace(/^"|"$/g, '').toLowerCase();
  return object && Number(object.Size) === file.size &&
    (etag === file.md5 || etag === file.multipartETag);
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
      ...fileChecksums(filePath),
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
        '--force', '--bigfile-threshold', '8Mi', '--part-size', '1Mi', '--parallel', '4',
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

/** Compare one paginated listing locally instead of asking recursive cp to
 * check every remote object. The release source was verified by syncDirectory.
 * Existing public aliases may change, but no old asset is removed.
 */
function syncPublicDirectory(sourceDirectory, bucket, sourcePrefix, destinationPrefix, options = {}) {
  const startedAt = Date.now();
  if (![sourcePrefix, destinationPrefix].every(prefix => prefix.endsWith('/'))) {
    throw new Error('OSS prefixes must end with /');
  }
  const source = path.resolve(sourceDirectory);
  const files = localFiles(source).map(filePath => ({
    path: filePath,
    relativePath: path.relative(source, filePath).split(path.sep).join('/'),
    size: fs.statSync(filePath).size,
    ...fileChecksums(filePath),
  }));
  const existing = listObjects(bucket, destinationPrefix);
  const changed = files.filter(file => !matches(existing.get(destinationPrefix + file.relativePath), file));
  if (changed.length) {
    const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'paws-oss-copy-'));
    try {
      if (changed.some(file => /[\r\n]/.test(file.relativePath))) {
        throw new Error('OSS copy list cannot represent newline-containing paths');
      }
      const selection = path.join(temporary, 'files.txt');
      fs.writeFileSync(selection, changed.map(file => file.relativePath).join('\n') + '\n');
      aliyun(['ossutil', 'cp', '-r', `oss://${bucket}/${sourcePrefix}`, `oss://${bucket}/${destinationPrefix}`,
        '--files-from-raw', selection, '--copy-props', 'metadata', '--job', '4',
        '--force', '--endpoint', endpoint, '--addressing-style', addressingStyle], true);
      // OSS-to-OSS cp can omit explicitly supplied properties. Set them after
      // copying only changed objects; unchanged assets retain their properties.
      if (options.contentType) {
        for (const file of changed) {
          aliyun(['ossutil', 'set-props', `oss://${bucket}/${destinationPrefix}${file.relativePath}`,
            '--content-type', options.contentType, '--cache-control', options.cacheControl,
            '--metadata-directive', 'update', '--force', '--endpoint', endpoint,
            '--addressing-style', addressingStyle], true);
        }
      }
    } finally {
      fs.rmSync(temporary, { recursive: true, force: true });
    }
  }
  // No writes means the first listing already proves the expected checksums.
  const verified = changed.length ? listObjects(bucket, destinationPrefix) : existing;
  for (const file of files) {
    if (!matches(verified.get(destinationPrefix + file.relativePath), file)) {
      throw new Error(`OSS public object failed checksum verification: ${destinationPrefix}${file.relativePath}`);
    }
  }
  console.log(`OSS public sync ${destinationPrefix}: ${changed.length} copied, ${files.length - changed.length} reused (${Date.now() - startedAt} ms)`);
  return { copiedFiles: changed.length, reusedFiles: files.length - changed.length };
}

module.exports = { syncDirectory, syncPublicDirectory };
