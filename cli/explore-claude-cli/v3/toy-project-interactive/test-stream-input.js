import { spawn } from 'child_process';

// Test interactive mode with stream-json input format
const claude = spawn('claude', [
  '--print',
  '--output-format', 'stream-json',
  '--input-format', 'stream-json',
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
  outputBuffer = lines.pop(); // Keep incomplete line in buffer
  
  lines.forEach(line => {
    if (line.trim()) {
      console.log('Output:', line);
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

// Send a test message in stream-json format
const message = {
  type: 'text-input',
  content: 'list the files in this directory'
};

console.log('Sending:', JSON.stringify(message));
claude.stdin.write(JSON.stringify(message) + '\n');

// Wait a bit then send another message
setTimeout(() => {
  const message2 = {
    type: 'text-input', 
    content: 'show me the contents of hello-world.js'
  };
  console.log('Sending:', JSON.stringify(message2));
  claude.stdin.write(JSON.stringify(message2) + '\n');
}, 5000);

// Set overall timeout
setTimeout(() => {
  console.log('Timeout reached, killing process...');
  claude.kill();
}, 15000);