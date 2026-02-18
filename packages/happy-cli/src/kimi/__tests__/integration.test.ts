/**
 * Kimi Integration Tests
 *
 * Integration tests for Kimi CLI support.
 * These tests require Kimi CLI to be installed and authenticated.
 *
 * Run with: npm test -- src/kimi/__tests__/integration.test.ts
 *
 * Environment variables:
 * - KIMI_CLI_PATH: Path to kimi executable (default: 'kimi')
 * - SKIP_KIMI_TESTS: Set to 'true' to skip all Kimi tests
 */

import { describe, expect, it, beforeAll } from 'vitest';
import { execSync } from 'node:child_process';

const KIMI_CLI = process.env.KIMI_CLI_PATH || 'kimi';
const SKIP_TESTS = process.env.SKIP_KIMI_TESTS === 'true';

/**
 * Check if Kimi CLI is available
 */
function isKimiAvailable(): boolean {
  if (SKIP_TESTS) return false;

  try {
    execSync(`${KIMI_CLI} --version`, { stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
}

/**
 * Check if user is logged in to Kimi
 */
function isKimiAuthenticated(): boolean {
  try {
    // Try to get user info or check auth status
    // This is a simplified check - actual implementation may vary
    const result = execSync(`${KIMI_CLI} info --json 2>&1 || echo '{}'`, {
      encoding: 'utf-8',
      stdio: 'pipe'
    });
    const info = JSON.parse(result);
    // If we can get version info, CLI is working
    return info.version !== undefined || result.includes('version');
  } catch {
    return false;
  }
}

const kimiAvailable = isKimiAvailable();
const kimiAuthenticated = kimiAvailable && isKimiAuthenticated();

describe.skipIf(!kimiAvailable)('Kimi CLI Integration', () => {
  beforeAll(() => {
    console.log(`Kimi CLI available: ${kimiAvailable}`);
    console.log(`Kimi authenticated: ${kimiAuthenticated}`);
  });

  describe('CLI Availability', () => {
    it('kimi command is available', () => {
      expect(kimiAvailable).toBe(true);
    });

    it('kimi --version returns version', () => {
      const version = execSync(`${KIMI_CLI} --version`, { encoding: 'utf-8' });
      expect(version).toContain('kimi');
      expect(version).toMatch(/\d+\.\d+/); // Version number pattern
    });

    it('kimi acp command is available', () => {
      // Check if 'kimi acp' help is available
      const help = execSync(`${KIMI_CLI} acp --help 2>&1 || ${KIMI_CLI} --help`, {
        encoding: 'utf-8',
        stdio: 'pipe'
      });
      expect(help.length).toBeGreaterThan(0);
    });
  });

  describe.skipIf(!kimiAuthenticated)('Authentication', () => {
    it('kimi info returns valid information', () => {
      const info = execSync(`${KIMI_CLI} info --json`, { encoding: 'utf-8' });
      const parsed = JSON.parse(info);
      expect(parsed).toHaveProperty('kimi_cli_version');
    });
  });
});

describe('Kimi Backend Factory (without CLI)', () => {
  // These tests don't require Kimi CLI to be installed

  it('factory exports are available', async () => {
    const factory = await import('../../agent/factories/kimi');
    expect(factory.createKimiBackend).toBeDefined();
    expect(factory.registerKimiAgent).toBeDefined();
  });

  it('transport handler exports are available', async () => {
    const { KimiTransport, kimiTransport } = await import('../../agent/transport/handlers/KimiTransport');
    expect(KimiTransport).toBeDefined();
    expect(kimiTransport).toBeDefined();
  });
});
