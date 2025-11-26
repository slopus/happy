/**
 * Post-build script to fix incorrect .ts imports in bundled files
 * pkgroll incorrectly rewrites .js imports to .ts for @modelcontextprotocol/sdk
 */

const fs = require('fs');
const path = require('path');

function fixImportsInFile(filePath) {
  if (!fs.existsSync(filePath)) {
    return;
  }

  let content = fs.readFileSync(filePath, 'utf8');
  const originalContent = content;

  // Fix @modelcontextprotocol/sdk imports: change .ts to .js
  content = content.replace(
    /@modelcontextprotocol\/sdk\/([^'"]+)\.ts(['"])/g,
    '@modelcontextprotocol/sdk/$1.js$2'
  );

  if (content !== originalContent) {
    fs.writeFileSync(filePath, content, 'utf8');
    console.log(`Fixed imports in ${filePath}`);
  }
}

// Fix imports in all .mjs and .cjs files in dist
const distDir = path.join(__dirname, '..', 'dist');

if (!fs.existsSync(distDir)) {
  console.log('dist directory does not exist, skipping import fix');
  process.exit(0);
}

function walkDir(dir) {
  const files = fs.readdirSync(dir);
  
  for (const file of files) {
    const filePath = path.join(dir, file);
    const stat = fs.statSync(filePath);
    
    if (stat.isDirectory()) {
      walkDir(filePath);
    } else if (file.endsWith('.mjs') || file.endsWith('.cjs')) {
      fixImportsInFile(filePath);
    }
  }
}

walkDir(distDir);
console.log('Import fixes completed');

