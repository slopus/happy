import { spawn } from 'child_process';

// Spawn Claude in interactive mode (no --print flag)
const claude = spawn('claude', ['--output-format', 'stream-json', '--verbose'], {
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
      try {
        const json = JSON.parse(line);
        console.log(JSON.stringify(json, null, 2));
      } catch (e) {
        console.log('Raw output:', line);
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

// Wait for initial output, then send a message
setTimeout(() => {
  console.log('\n=== Sending first message ===');
  claude.stdin.write('list the files in this directory\n');
}, 2000);

// Send second message after delay
setTimeout(() => {
  console.log('\n=== Sending second message ===');
  claude.stdin.write('show me hello-world.js\n');
}, 8000);

// Exit after timeout
setTimeout(() => {
  console.log('\n=== Timeout reached, exiting ===');
  claude.stdin.write('exit\n');
}, 14000);