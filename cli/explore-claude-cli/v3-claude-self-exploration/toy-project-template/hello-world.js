const args = process.argv.slice(2);
const name = args[0] || 'World';
console.log(`Hello ${name}!`);