const args = process.argv.slice(2);
const name = args[0] || 'World';
const now = new Date();
const timestamp = now.toLocaleString('en-US', { 
  weekday: 'short', 
  year: 'numeric', 
  month: 'short', 
  day: 'numeric', 
  hour: '2-digit', 
  minute: '2-digit', 
  second: '2-digit' 
});
console.log(`Hello ${name}! [${timestamp}]`);