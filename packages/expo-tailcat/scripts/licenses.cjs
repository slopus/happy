// Generate distribution notices from the exact pinned dependency graph. This
// deliberately over-includes licenses rather than guessing what the linker kept.
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const options = { cwd: path.join(root, 'go'), encoding: 'utf8', maxBuffer: 20 * 1024 * 1024 };
const modules = execFileSync('go', ['list', '-m', '-f', '{{if not .Main}}{{.Path}}\t{{.Version}}\t{{.Dir}}{{end}}', 'all'], options)
  .trim().split('\n').filter(Boolean).map(line => line.split('\t'));
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