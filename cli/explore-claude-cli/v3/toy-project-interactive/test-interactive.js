import { spawn } from 'child_process';
import readline from 'readline';
import { fileURLToPath } from 'url';
import { dirname } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Create interface for user input
const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout
});

// Spawn Claude in interactive mode without --print flag
const claude = spawn('claude', ['--output-format', 'stream-json', '--verbose'], {
  cwd: __dirname,
  stdio: ['pipe', 'pipe', 'pipe']
});

// Handle Claude output
claude.stdout.on('data', (data) => {
  const lines = data.toString().split('\n').filter(line => line.trim());
  lines.forEach(line => {
    try {
      const json = JSON.parse(line);
      console.log('Claude Output:', JSON.stringify(json, null, 2));
    } catch (e) {
      // Not JSON, print as-is
      console.log('Claude Raw:', line);
    }
  });
});

// Handle errors
claude.stderr.on('data', (data) => {
  console.error('Claude Error:', data.toString());
});

// Handle process exit
claude.on('close', (code) => {
  console.log(`Claude process exited with code ${code}`);
  rl.close();
  process.exit(0);
});

// Handle user input
console.log('Interactive Claude CLI Test - Type messages to send to Claude:');
rl.on('line', (input) => {
  if (input.toLowerCase() === 'exit') {
    claude.kill();
    rl.close();
    process.exit(0);
  }
  
  // Send input to Claude
  claude.stdin.write(input + '\n');
});

// Set timeout to kill after 15 seconds
setTimeout(() => {
  console.log('\nTimeout reached, killing Claude process...');
  claude.kill();
  rl.close();
  process.exit(0);
}, 15000);