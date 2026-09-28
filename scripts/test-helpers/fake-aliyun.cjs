#!/usr/bin/env node
// In-memory OSS object metadata persisted as JSON for upload workflow tests.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const args = process.argv.slice(2);
fs.appendFileSync(process.env.FAKE_ALIYUN_LOG, args.join(' ') + '\n');
if (args.includes('--help') || args[0] === 'ossutil' && args[1] === 'version') process.exit(0);
const statePath = process.env.FAKE_OSS_STATE;
const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
const flag = (name) => args[args.indexOf(name) + 1];
const save = () => fs.writeFileSync(statePath, JSON.stringify(state));
const strip = (uri) => uri.replace(/^oss:\/\/[^/]+\//, '');

if (args[0] === 'ossutil' && args[1] === 'set-props') {
  const key = strip(args[2]);
  if (!state[key]) process.exit(1);
  if (args.includes('--cache-control')) state[key].cacheControl = flag('--cache-control');
  if (args.includes('--content-type')) state[key].contentType = flag('--content-type');
  save();
  process.exit(0);
}

if (args[0] === 'ossutil' && args[1] === 'api' && args[2] === 'list-objects-v2') {
  const keys = Object.keys(state).filter((key) => key.startsWith(flag('--prefix'))).sort();
  const start = args.includes('--continuation-token') ? Number(flag('--continuation-token')) : 0;
  const page = keys.slice(start, start + 1000).map((key) => ({
    Key: key, Size: String(state[key].size), ETag: `"${state[key].md5}"`,
  }));
  fs.writeSync(1, JSON.stringify({
    Contents: page,
    IsTruncated: String(start + 1000 < keys.length),
    NextContinuationToken: start + 1000 < keys.length ? String(start + 1000) : undefined,
  }));
  process.exit(0);
}
if (args[0] !== 'ossutil' || args[1] !== 'cp') process.exit(2);

const recursive = args[2] === '-r';
const source = args[recursive ? 3 : 2];
const destination = args[recursive ? 4 : 3];
const files = [];
if (source.startsWith('oss://')) {
  const sourceKey = strip(source);
  for (const key of Object.keys(state).filter((key) => recursive ? key.startsWith(sourceKey) : key === sourceKey)) {
    files.push({ relative: recursive ? key.slice(sourceKey.length) : '', value: state[key] });
  }
} else if (recursive) {
  const visit = (directory, relative = '') => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const nested = path.join(relative, entry.name);
      if (entry.isDirectory()) visit(path.join(directory, entry.name), nested);
      else {
        const bytes = fs.readFileSync(path.join(directory, entry.name));
        files.push({
          relative: nested.split(path.sep).join('/'),
          value: { size: bytes.length, md5: crypto.createHash('md5').update(bytes).digest('hex') },
        });
      }
    }
  };
  visit(source);
} else {
  const bytes = fs.readFileSync(source);
  files.push({ relative: '', value: { size: bytes.length, md5: crypto.createHash('md5').update(bytes).digest('hex') } });
}

const targetPrefix = strip(destination);
if (process.env.FAKE_FAIL_DEST_PREFIX && targetPrefix.startsWith(process.env.FAKE_FAIL_DEST_PREFIX)) process.exit(1);
let copied = 0;
for (const file of files) {
  const key = recursive ? targetPrefix + file.relative : targetPrefix;
  if (args.includes('--checksum') && JSON.stringify(state[key]) === JSON.stringify(file.value)) continue;
  const copyWithoutProps = source.startsWith('oss://') &&
    args.includes('--copy-props') && flag('--copy-props') === 'none';
  state[key] = copyWithoutProps
    ? { size: file.value.size, md5: file.value.md5 }
    : { ...file.value };
  if (!source.startsWith('oss://') && args.includes('--cache-control')) {
    state[key].cacheControl = flag('--cache-control');
  }
  if (!source.startsWith('oss://') && args.includes('--content-type')) {
    state[key].contentType = flag('--content-type');
  }
  if (key.startsWith('manifests/') && !source.startsWith('oss://') && !recursive) {
    state[key].text = fs.readFileSync(source, 'utf8');
  }
  copied++;
  if (Number(process.env.FAKE_FAIL_AFTER) === copied) {
    save();
    process.exit(1);
  }
}
save();
