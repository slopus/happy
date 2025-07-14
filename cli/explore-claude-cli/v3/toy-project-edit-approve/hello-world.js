const args = process.argv.slice(2);
const name = args[0] || 'World';
const timestamp = new Date().toISOString();
console.log(`Hello ${name}! [${timestamp}]`);