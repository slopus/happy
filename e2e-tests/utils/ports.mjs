/**
 * Port allocation utility for E2E tests
 *
 * Allocates random ports in a test range (10000-20000) to avoid
 * conflicts with production services (typically on 3005, 8081, 9000, etc.)
 */

import { createServer } from 'net';

// Test port range: 10000-20000 (separate from production ports)
const TEST_PORT_MIN = 10000;
const TEST_PORT_MAX = 20000;

/**
 * Check if a port is available
 */
function isPortAvailable(port) {
    return new Promise((resolve) => {
        const server = createServer();
        server.once('error', () => resolve(false));
        server.once('listening', () => {
            server.close();
            resolve(true);
        });
        server.listen(port, '127.0.0.1');
    });
}

/**
 * Get a random port in the test range
 */
function getRandomPort() {
    return Math.floor(Math.random() * (TEST_PORT_MAX - TEST_PORT_MIN + 1)) + TEST_PORT_MIN;
}

/**
 * Allocate a random available port in the test range
 */
export async function allocatePort() {
    const maxAttempts = 100;
    for (let i = 0; i < maxAttempts; i++) {
        const port = getRandomPort();
        if (await isPortAvailable(port)) {
            return port;
        }
    }
    throw new Error(`Failed to allocate port after ${maxAttempts} attempts`);
}

/**
 * Allocate multiple random available ports
 */
export async function allocatePorts(count) {
    const ports = [];
    const usedPorts = new Set();

    for (let i = 0; i < count; i++) {
        let attempts = 0;
        while (attempts < 100) {
            const port = getRandomPort();
            if (!usedPorts.has(port) && await isPortAvailable(port)) {
                ports.push(port);
                usedPorts.add(port);
                break;
            }
            attempts++;
        }
        if (attempts >= 100) {
            throw new Error(`Failed to allocate port ${i + 1} of ${count}`);
        }
    }

    return ports;
}

/**
 * Allocate a set of ports for a full test environment
 */
export async function allocateTestPorts() {
    const [serverPort, webappPort, minioPort, minioConsolePort] = await allocatePorts(4);

    return {
        serverPort,
        webappPort,
        minioPort,
        minioConsolePort,
        // These are shared infrastructure - use existing ports
        // We could make these dynamic too if needed
        postgresPort: 5432,
        redisPort: 6379
    };
}
