// Generate notices from the union of all four mobile target dependency graphs.
// Include every referenced module even if dead-code elimination removes parts.
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const options = { cwd: path.join(root, 'go'), encoding: 'utf8', maxBuffer: 20 * 1024 * 1024 };
const modulesByName = new Map();
const tags = fs.readFileSync(path.join(root, 'native-tags.txt'), 'utf8').trim();
for (const target of ['ios/arm64', 'ios/amd64', 'android/arm64', 'android/amd64']) {
  const [GOOS, GOARCH] = target.split('/');
  const output = execFileSync('go', ['list', '-deps', `-tags=${tags}`, '-f',
    '{{with .Module}}{{if not .Main}}{{.Path}}\t{{.Version}}\t{{.Dir}}{{end}}{{end}}', './mobile'],
  { ...options, env: { ...process.env, GOOS, GOARCH, CGO_ENABLED: '1' } });
  for (const line of output.trim().split('\n').filter(Boolean)) {
    const row = line.split('\t'); modulesByName.set(row[0], row);
  }
}
// gomobile contributes generated Go/Java/Objective-C runtime support.
const mobile = execFileSync('go', ['list', '-m', '-f', '{{.Path}}\t{{.Version}}\t{{.Dir}}', 'golang.org/x/mobile'], options).trim().split('\t');
modulesByName.set(mobile[0], mobile);
const modules = [...modulesByName.values()].sort((a, b) => a[0].localeCompare(b[0]));
const goroot = execFileSync('go', ['env', 'GOROOT'], options).trim();
let notices = '# Third-party notices\n\nGenerated from go.mod/go.sum; includes the Go runtime and transitive module licenses.\n';
notices += '\n## Go runtime\n\n```text\n' + fs.readFileSync(path.join(goroot, 'LICENSE'), 'utf8') + '\n```\n';
for (const [name, version, dir] of modules) {
  if (!dir || !fs.existsSync(dir)) throw new Error(`Download dependencies before generating notices: ${name}`);
  const files = fs.readdirSync(dir).filter(name => /^(licen[cs]e|copying|notice|patents)(\..*)?$/i.test(name))
    .filter(name => fs.statSync(path.join(dir, name)).isFile());
  if (!files.some(name => /^(licen[cs]e|copying)/i.test(name))) throw new Error(`Review missing license for ${name}`);
  notices += `\n## ${name} ${version}\n`;
  for (const file of files) notices += `\n### ${file}\n\n\`\`\`text\n${fs.readFileSync(path.join(dir, file), 'utf8')}\n\`\`\`\n`;
}
fs.writeFileSync(path.join(root, 'THIRD_PARTY_NOTICES.md'), notices);
console.log(`Generated notices for Go and ${modules.length} modules`);