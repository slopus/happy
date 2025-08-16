/**
 * Test setup file for vitest
 * 
 * Configures the test environment before running tests
 */

// Extend test timeout for integration tests
process.env.VITEST_POOL_TIMEOUT = '60000'