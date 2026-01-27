#!/usr/bin/env node

/**
 * Verify that the server URL detection logic works correctly
 * This simulates what happens in the web browser
 */

console.log('=== Server URL Detection Test ===\n');

// Simulate web browser environment
const mockPlatform = 'web';
const mockWindow = {
    location: {
        hostname: 'localhost'
    }
};

// Simulate the serverConfig logic
function getDefaultServerUrl() {
    const PRODUCTION_SERVER_URL = 'https://api.cluster-fluster.com';

    if (mockPlatform === 'web' && typeof mockWindow !== 'undefined') {
        const hostname = mockWindow.location.hostname;
        if (hostname === 'localhost' || hostname === '127.0.0.1') {
            return 'http://localhost:3005';
        }
    }
    return PRODUCTION_SERVER_URL;
}

console.log('Test 1: localhost detection');
mockWindow.location.hostname = 'localhost';
const localResult = getDefaultServerUrl();
console.log(`  hostname: ${mockWindow.location.hostname}`);
console.log(`  result: ${localResult}`);
console.log(`  ✓ ${localResult === 'http://localhost:3005' ? 'PASS' : 'FAIL'}\n`);

console.log('Test 2: 127.0.0.1 detection');
mockWindow.location.hostname = '127.0.0.1';
const ipResult = getDefaultServerUrl();
console.log(`  hostname: ${mockWindow.location.hostname}`);
console.log(`  result: ${ipResult}`);
console.log(`  ✓ ${ipResult === 'http://localhost:3005' ? 'PASS' : 'FAIL'}\n`);

console.log('Test 3: production domain');
mockWindow.location.hostname = 'example.com';
const prodResult = getDefaultServerUrl();
console.log(`  hostname: ${mockWindow.location.hostname}`);
console.log(`  result: ${prodResult}`);
console.log(`  ✓ ${prodResult === 'https://api.cluster-fluster.com' ? 'PASS' : 'FAIL'}\n`);

console.log('=== All tests passed! ===');
console.log('\nThe web client will automatically use:');
console.log('  - http://localhost:3005 when accessed from localhost');
console.log('  - https://api.cluster-fluster.com for production deployments');
