import { spawn } from 'child_process';

// Test with JSONL format input as mentioned in search results
const claude = spawn('claude', [
  '-p',
  '--output-format', 'stream-json',
  '--verbose'
], {
  cwd: process.cwd(),
  stdio: ['pipe', 'pipe', 'pipe']
});

// Handle output
let outputBuffer = '';
claude.stdout.on('data', (data) => {
  outputBuffer += data.toString();
  const lines = outputBuffer.split('\n');
  outputBuffer = lines.pop();
  
  lines.forEach(line => {
    if (line.trim()) {
      try {
        const json = JSON.parse(line);
        console.log('Output:', JSON.stringify(json, null, 2));
      } catch (e) {
        console.log('Raw:', line);
      }
    }
  });
});

claude.stderr.on('data', (data) => {
  console.error('Error:', data.toString());
});

claude.on('close', (code) => {
  console.log(`Process exited with code ${code}`);
  process.exit(0);
});

// Send messages in JSONL format (one JSON object per line)
const message1 = { role: 'user', content: 'list the files in this directory' };
console.log('Sending:', JSON.stringify(message1));
claude.stdin.write(JSON.stringify(message1) + '\n');

// Send second message after delay
setTimeout(() => {
  const message2 = { role: 'user', content: 'show me hello-world.js contents' };
  console.log('\nSending:', JSON.stringify(message2));
  claude.stdin.write(JSON.stringify(message2) + '\n');
  
  // Close stdin to signal end of input
  setTimeout(() => {
    claude.stdin.end();
  }, 1000);
}, 3000);

// Timeout
setTimeout(() => {
  console.log('\nTimeout reached');
  claude.kill();
}, 15000);