import { spawn } from 'child_process';
import { fileURLToPath } from 'url';
import { dirname } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Spawn Claude with a request to modify the file
const claude = spawn('claude', [
  '--print',
  '--output-format', 'stream-json',
  '--verbose',
  'modify hello-world.js to add a timestamp to the greeting message'
], {
  cwd: __dirname,
  stdio: ['pipe', 'pipe', 'pipe']
});

// Track if we've seen an approval request
let approvalRequested = false;
let autoApprove = process.argv[2] === 'approve';

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
        
        // Check for approval request
        if (json.type === 'user' && json.subtype === 'approval_request') {
          console.log('\n=== APPROVAL REQUEST DETECTED ===');
          approvalRequested = true;
          
          // Auto-approve if requested
          if (autoApprove) {
            setTimeout(() => {
              console.log('Auto-approving edit...');
              claude.stdin.write('y\n');
            }, 1000);
          }
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
  console.log(`Approval was requested: ${approvalRequested}`);
  process.exit(0);
});

// Set timeout
setTimeout(() => {
  console.log('\nTimeout reached, killing process...');
  claude.kill();
}, 30000);