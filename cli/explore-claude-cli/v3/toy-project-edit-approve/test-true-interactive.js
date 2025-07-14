import { spawn } from 'child_process';
import { fileURLToPath } from 'url';
import { dirname } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

console.log('Starting Claude in true interactive mode (no flags)...\n');

// Spawn Claude with minimal flags
const claude = spawn('claude', [], {
  cwd: __dirname,
  stdio: 'inherit'  // Use inherit to see the raw terminal output
});

claude.on('close', (code) => {
  console.log(`\nClaude exited with code ${code}`);
  process.exit(0);
});

// Send initial message after a delay
setTimeout(() => {
  console.log('\n[Automated input]: modify hello-world.js to add a timestamp\n');
}, 2000);

// Set overall timeout
setTimeout(() => {
  console.log('\n[Timeout reached, killing process]');
  claude.kill();
}, 30000);