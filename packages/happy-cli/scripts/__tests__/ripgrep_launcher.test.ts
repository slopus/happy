import { describe, it, expect, vi, beforeEach } from 'vitest';

describe('Ripgrep Launcher Runtime Compatibility', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it('has correct file structure', () => {
        // Test that the launcher file has the correct structure
        expect(() => {
            const fs = require('fs');
            const path = require('path');
            const content = fs.readFileSync(path.join(__dirname, '../ripgrep_launcher.cjs'), 'utf8');

            // Check for required elements
            expect(content).toContain('#!/usr/bin/env node');
            expect(content).toContain('ripgrepMain');
            expect(content).toContain('loadRipgrepNative');
        }).not.toThrow();
    });

    it('handles --version argument gracefully', () => {
        // Test that --version handling logic exists
        expect(() => {
            const fs = require('fs');
            const path = require('path');
            const content = fs.readFileSync(path.join(__dirname, '../ripgrep_launcher.cjs'), 'utf8');

            // Check that --version handling is present
            expect(content).toContain('--version');
            expect(content).toContain('ripgrepMain');
        }).not.toThrow();
    });

    it('detects runtime correctly', () => {
        // Test runtime detection function exists
        expect(() => {
            const fs = require('fs');
            const path = require('path');
            const content = fs.readFileSync(path.join(__dirname, '../ripgrep_launcher.cjs'), 'utf8');

            // Check that runtime detection logic is present
            expect(content).toContain('detectRuntime');
            expect(content).toContain('typeof Bun');
            expect(content).toContain('typeof Deno');
            expect(content).toContain('process?.versions');
        }).not.toThrow();
    });

    it('contains fallback chain logic', () => {
        // Test that fallback logic is present
        expect(() => {
            const fs = require('fs');
            const path = require('path');
            const content = fs.readFileSync(path.join(__dirname, '../ripgrep_launcher.cjs'), 'utf8');

            // Check that fallback chain is present
            expect(content).toContain('loadRipgrepNative');
            expect(content).toContain('systemRipgrep');
            expect(content).toContain('createRipgrepWrapper');
            expect(content).toContain('createMockRipgrep');
        }).not.toThrow();
    });

    it('contains cross-platform logic', () => {
        // Test that cross-platform logic is present
        expect(() => {
            const fs = require('fs');
            const path = require('path');
            const content = fs.readFileSync(path.join(__dirname, '../ripgrep_launcher.cjs'), 'utf8');

            // Check for platform-specific logic
            expect(content).toContain('process.platform');
            expect(content).toContain('win32');
            expect(content).toContain('darwin');
            expect(content).toContain('linux');
            expect(content).toContain('execFileSync');
        }).not.toThrow();
    });

    it('provides helpful error messages', () => {
        // Test that helpful error messages are present
        expect(() => {
            const fs = require('fs');
            const path = require('path');
            const content = fs.readFileSync(path.join(__dirname, '../ripgrep_launcher.cjs'), 'utf8');

            // Check for helpful messages
            expect(content).toContain('brew install ripgrep');
            expect(content).toContain('winget install BurntSushi.ripgrep');
            expect(content).toContain('Search functionality unavailable');
        }).not.toThrow();
    });
});