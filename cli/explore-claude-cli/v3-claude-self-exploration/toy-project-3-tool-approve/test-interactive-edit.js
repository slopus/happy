import { spawn } from 'child_process';
import { fileURLToPath } from 'url';
import { dirname } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Spawn Claude in interactive mode (no --print)
const claude = spawn('claude', [
  '--output-format', 'stream-json',
  '--verbose',
  'modify hello-world.js to add a timestamp to the greeting message'
], {
  cwd: __dirname,
  stdio: ['pipe', 'pipe', 'pipe']
});

// Track messages
let messages = [];

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
        messages.push(json);
        console.log(`[${new Date().toISOString()}] ${json.type}:`, JSON.stringify(json, null, 2));
        
        // Look for approval requests
        if (json.type === 'user' && json.subtype === 'approval_request') {
          console.log('\n=== APPROVAL REQUEST DETECTED ===');
          console.log('Tool:', json.tool_use?.name);
          console.log('Waiting 2 seconds then approving...\n');
          
          setTimeout(() => {
            console.log('Sending approval: y');
            claude.stdin.write('y\n');
          }, 2000);
        }
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
  console.log(`\nProcess exited with code ${code}`);
  console.log(`Total messages: ${messages.length}`);
  
  // Check for approval messages
  const approvalRequests = messages.filter(m => m.type === 'user' && m.subtype === 'approval_request');
  console.log(`Approval requests found: ${approvalRequests.length}`);
  
  process.exit(0);
});

// Set timeout
setTimeout(() => {
  console.log('\nTimeout reached, sending exit...');
  claude.stdin.write('exit\n');
  setTimeout(() => {
    claude.kill();
  }, 1000);
}, 25000);