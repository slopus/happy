const readline = require('node:readline');
readline.createInterface({ input: process.stdin }).on('line', line => {
  console.log(line
    .replace(/(?:https?|wss?):\/\/\S+|tc[A-Za-z0-9_-]{20,}/g, '[redacted]')
    .replace(/\/[a-f0-9]{64}\//g, '/[redacted]/'));
});