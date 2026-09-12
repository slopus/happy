const { execFileSync } = require('node:child_process');
const { devices } = JSON.parse(execFileSync('xcrun', ['simctl', 'list', 'devices', 'available', '--json'], { encoding: 'utf8' }));
const simulator = Object.entries(devices)
  .filter(([runtime]) => runtime.includes('iOS'))
  .flatMap(([, devices]) => devices)
  .find(device => device.isAvailable && device.name.startsWith('iPhone'));
if (!simulator) throw new Error('No available iPhone simulator installed');
if (simulator.state !== 'Booted') execFileSync('xcrun', ['simctl', 'boot', simulator.udid]);
console.log(`TAILCAT_SIMULATOR_ID=${simulator.udid}`);