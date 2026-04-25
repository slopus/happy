/**
 * E2E Screenshot Test for Tauri Desktop
 *
 * This script captures screenshots of the running Tauri app and saves them
 * for visual verification. Run with: npx tsx sources/trash/e2e-tauri-screenshot-test.ts
 *
 * Prerequisites: Tauri app must be running (pnpm tauri:dev)
 *
 * Test Cases:
 * 1. TC-LAUNCH: App launches with correct window size (1280x800)
 * 2. TC-LAYOUT: Three-column layout visible (SidebarView + Center + ContextPanel)
 * 3. TC-TRAY: System tray icon visible with menu
 * 4. TC-ZEN: Zen mode toggles side panels
 * 5. TC-CLOSE: Close dialog appears on window close
 * 6. TC-NAV: Navigation between routes preserves sidebar
 */

import { execSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

const SCREENSHOT_DIR = path.join(__dirname, '../../trash/e2e-screenshots');
const WINDOW_TITLE = 'Happy (dev)';

// Ensure screenshot directory exists
if (!fs.existsSync(SCREENSHOT_DIR)) {
    fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });
}

function sleep(ms: number) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

function captureWindow(name: string): string {
    const filepath = path.join(SCREENSHOT_DIR, `${name}.png`);
    try {
        // macOS: capture specific window by title
        execSync(`screencapture -l $(osascript -e 'tell app "System Events" to tell process "app" to get id of window 1') ${filepath}`, {
            timeout: 5000,
        });
    } catch {
        // Fallback: capture entire screen
        execSync(`screencapture -x ${filepath}`, { timeout: 5000 });
    }
    console.log(`📸 Captured: ${filepath}`);
    return filepath;
}

function simulateKeyCombo(key: string, modifiers: string[] = []) {
    const modStr = modifiers.map(m => `${m} down`).join(', ');
    const script = modifiers.length > 0
        ? `tell app "System Events" to keystroke "${key}" using {${modStr}}`
        : `tell app "System Events" to keystroke "${key}"`;
    execSync(`osascript -e '${script}'`, { timeout: 3000 });
}

function focusTauriWindow() {
    try {
        execSync(`osascript -e 'tell app "Happy (dev)" to activate'`, { timeout: 3000 });
    } catch {
        console.warn('⚠️  Could not focus Tauri window');
    }
}

async function runTests() {
    console.log('🧪 Tauri Desktop E2E Screenshot Tests\n');
    console.log(`📁 Screenshots: ${SCREENSHOT_DIR}\n`);

    const results: { name: string; status: 'pass' | 'fail' | 'manual'; note: string }[] = [];

    // TC-LAUNCH: App window visible
    console.log('--- TC-LAUNCH: App launches ---');
    focusTauriWindow();
    await sleep(2000);
    captureWindow('01-launch');
    results.push({ name: 'TC-LAUNCH', status: 'manual', note: 'Verify: window is 1280x800, app content visible' });

    // TC-LAYOUT: Three-column layout
    console.log('--- TC-LAYOUT: Three-column layout ---');
    captureWindow('02-layout');
    results.push({ name: 'TC-LAYOUT', status: 'manual', note: 'Verify: SidebarView (left) + Center content + ContextPanel "Coming soon" (right)' });

    // TC-ZEN: Zen mode toggle
    console.log('--- TC-ZEN: Zen mode (Cmd+0) ---');
    focusTauriWindow();
    await sleep(500);
    simulateKeyCombo('0', ['command']);
    await sleep(1000);
    captureWindow('03-zen-on');
    results.push({ name: 'TC-ZEN-ON', status: 'manual', note: 'Verify: side panels hidden, center fills window' });

    // Toggle back
    simulateKeyCombo('0', ['command']);
    await sleep(1000);
    captureWindow('04-zen-off');
    results.push({ name: 'TC-ZEN-OFF', status: 'manual', note: 'Verify: side panels restored' });

    // TC-TRAY: System tray
    console.log('--- TC-TRAY: System tray ---');
    captureWindow('05-tray');
    results.push({ name: 'TC-TRAY', status: 'manual', note: 'Verify: Happy icon in menu bar' });

    // Summary
    console.log('\n📋 Test Results:\n');
    console.log('| Test | Status | Note |');
    console.log('|------|--------|------|');
    for (const r of results) {
        const icon = r.status === 'pass' ? '✅' : r.status === 'fail' ? '❌' : '👁️';
        console.log(`| ${r.name} | ${icon} ${r.status} | ${r.note} |`);
    }
    console.log(`\n📸 ${results.length} screenshots saved to ${SCREENSHOT_DIR}`);
    console.log('👁️  Review screenshots manually to verify each test case.');
}

runTests().catch(console.error);
