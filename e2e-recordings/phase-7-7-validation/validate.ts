/**
 * Phase 7.7 Validation: web drag-to-reorder delivery
 *
 * Validates that DraggableProjectGroup now produces real [draggable="true"] DOM
 * nodes by using a raw HTML div instead of react-native-web View.
 *
 * Tests:
 * 1. [draggable="true"] nodes exist in the session list
 * 2. Drag changes order
 * 3. Reload preserves order
 * 4. Archive/grouping still works
 */

import { chromium, Page } from 'playwright';
import * as fs from 'fs';
import * as path from 'path';

const WEB_PORT = process.env.WEB_PORT || '54931';
const BASE_URL = `http://localhost:${WEB_PORT}`;
const DEV_TOKEN = process.env.DEV_TOKEN || 'eyJhbGciOiJFZERTQSJ9.eyJzdWIiOiJjbW5kdzVyNnkwMDAweTdoc2J5cGF0a2QyIiwiaWF0IjoxNzc0OTE3NjgwLCJuYmYiOjE3NzQ5MTc2ODAsImlzcyI6ImhhbmR5IiwianRpIjoiMWYyMmI1MmItYjdiNi00MTZkLWFjZWYtM2FmOWZiMTU4Mzc4In0.F-4feH8y4JK03AMu82Z8o9gZFs99h7jiXfpj0-ey4MyEr3wIjBIt6M24Q8ZCZiYWqZizbemhwWCexQaQD7d9Cw';
const DEV_SECRET = process.env.DEV_SECRET || 'JFhy68X23lyS_PIwlUPy2H5Sf-FzYUZ-gDE5BaLc0mI';
const AUTH_URL = `${BASE_URL}/?dev_token=${DEV_TOKEN}&dev_secret=${DEV_SECRET}`;
const OUTPUT_DIR = path.dirname(new URL(import.meta.url).pathname);

interface ValidationResult {
    draggableCount: number;
    groupCount: number;
    initialOrder: string[];
    afterDragOrder: string[];
    afterReloadOrder: string[];
    rightClickArchiveVisible: boolean;
    reorderWorked: boolean;
    notes: string[];
}

async function extractProjectGroupPaths(page: Page): Promise<string[]> {
    // Extract project group path text from the sidebar / session list
    const body = await page.textContent('body') || '';
    // Find all paths that look like project paths (start with / or ~)
    const paths: string[] = [];
    const lines = body.split('\n');
    for (const line of lines) {
        const trimmed = line.trim();
        if (trimmed.startsWith('/') || trimmed.startsWith('~')) {
            // Filter for likely project group paths
            if (trimmed.includes('/tmp/happy-p7') || trimmed.includes('lab-rat') || trimmed.includes('/projects/')) {
                paths.push(trimmed);
            }
        }
    }
    // Deduplicate
    return [...new Set(paths)];
}

async function waitForSessionList(page: Page, timeoutMs = 60000): Promise<void> {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
        const body = await page.textContent('body') || '';
        // Check for any session content
        if (body.length > 200) {
            await page.waitForTimeout(2000);
            return;
        }
        await page.waitForTimeout(500);
    }
    throw new Error('Timed out waiting for session list to render');
}

async function main() {
    const result: ValidationResult = {
        draggableCount: 0,
        groupCount: 0,
        initialOrder: [],
        afterDragOrder: [],
        afterReloadOrder: [],
        rightClickArchiveVisible: false,
        reorderWorked: false,
        notes: [],
    };

    const browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({
        viewport: { width: 1280, height: 900 },
        recordVideo: { dir: OUTPUT_DIR, size: { width: 1280, height: 900 } },
    });

    try {
        // ========== AUTHENTICATE ==========
        console.log('Authenticating...');
        const authPage = await context.newPage();
        await authPage.goto(AUTH_URL, { waitUntil: 'networkidle', timeout: 60000 });
        await authPage.waitForTimeout(3000);
        await authPage.close();

        // ========== TEST 1: Check for [draggable="true"] ==========
        console.log('\n=== TEST 1: Draggable nodes ===');
        const page = await context.newPage();
        await page.goto(AUTH_URL, { waitUntil: 'networkidle', timeout: 60000 });
        await waitForSessionList(page);

        // Take initial screenshot
        await page.screenshot({ path: path.join(OUTPUT_DIR, '01-session-list-initial.png') });

        // Count draggable elements
        const draggableCount = await page.locator('[draggable="true"]').count();
        result.draggableCount = draggableCount;
        console.log(`  draggable="true" count: ${draggableCount}`);

        if (draggableCount === 0) {
            result.notes.push('No [draggable="true"] nodes found. The fix may not have been picked up by the bundler.');
            console.log('  FAIL: No draggable nodes found');

            // Debug: check what div elements exist
            const allDivs = await page.locator('div').count();
            console.log(`  Total divs: ${allDivs}`);

            // Check if the reorder icon is present
            const body = await page.textContent('body') || '';
            console.log(`  Body length: ${body.length}`);
            console.log(`  Body snippet: ${body.substring(0, 300)}`);

            // Check page HTML for draggable
            const html = await page.content();
            const hasDraggableInHtml = html.includes('draggable');
            console.log(`  HTML contains "draggable": ${hasDraggableInHtml}`);

            result.notes.push(`Total divs: ${allDivs}, Body length: ${body.length}, HTML has draggable: ${hasDraggableInHtml}`);
        }

        // Count project groups (sections with reorder handles)
        // On web, the reorder glyph (reorder-two icon) is in each group header
        const groupHeaders = await page.locator('div[draggable="true"]').count();
        result.groupCount = groupHeaders;
        console.log(`  Draggable project groups: ${groupHeaders}`);

        // Extract initial order
        if (draggableCount >= 2) {
            // Get text content of each draggable group's first text child (the path)
            const draggableElements = page.locator('[draggable="true"]');
            for (let i = 0; i < draggableCount; i++) {
                const text = await draggableElements.nth(i).textContent() || '';
                // Extract path-like text
                const pathMatch = text.match(/(\/[^\s]+|~[^\s]+)/);
                if (pathMatch) {
                    result.initialOrder.push(pathMatch[0]);
                } else {
                    result.initialOrder.push(text.substring(0, 60).trim());
                }
            }
            console.log(`  Initial order: ${JSON.stringify(result.initialOrder)}`);

            // ========== TEST 2: Drag changes order ==========
            console.log('\n=== TEST 2: Drag changes order ===');

            const source = draggableElements.nth(0);
            const target = draggableElements.nth(1);

            const sourceBox = await source.boundingBox();
            const targetBox = await target.boundingBox();

            if (sourceBox && targetBox) {
                console.log(`  Source box: ${JSON.stringify(sourceBox)}`);
                console.log(`  Target box: ${JSON.stringify(targetBox)}`);

                // Perform HTML5 drag and drop
                // Playwright's dragTo should work with HTML5 drag events
                await source.dragTo(target, {
                    sourcePosition: { x: sourceBox.width / 2, y: sourceBox.height / 2 },
                    targetPosition: { x: targetBox.width / 2, y: targetBox.height / 2 },
                });

                await page.waitForTimeout(1000);
                await page.screenshot({ path: path.join(OUTPUT_DIR, '02-after-drag.png') });

                // Re-read order
                const afterDragElements = page.locator('[draggable="true"]');
                const afterCount = await afterDragElements.count();
                for (let i = 0; i < afterCount; i++) {
                    const text = await afterDragElements.nth(i).textContent() || '';
                    const pathMatch = text.match(/(\/[^\s]+|~[^\s]+)/);
                    if (pathMatch) {
                        result.afterDragOrder.push(pathMatch[0]);
                    } else {
                        result.afterDragOrder.push(text.substring(0, 60).trim());
                    }
                }
                console.log(`  After drag order: ${JSON.stringify(result.afterDragOrder)}`);

                result.reorderWorked = result.initialOrder.length > 0 &&
                    result.afterDragOrder.length > 0 &&
                    JSON.stringify(result.initialOrder) !== JSON.stringify(result.afterDragOrder);
                console.log(`  Reorder worked: ${result.reorderWorked}`);
            } else {
                result.notes.push('Could not get bounding boxes for drag source/target');
            }

            // ========== TEST 3: Reload preserves order ==========
            console.log('\n=== TEST 3: Reload preserves order ===');
            await page.reload({ waitUntil: 'networkidle', timeout: 60000 });
            await waitForSessionList(page);
            await page.waitForTimeout(2000);
            await page.screenshot({ path: path.join(OUTPUT_DIR, '03-after-reload.png') });

            const afterReloadElements = page.locator('[draggable="true"]');
            const reloadCount = await afterReloadElements.count();
            for (let i = 0; i < reloadCount; i++) {
                const text = await afterReloadElements.nth(i).textContent() || '';
                const pathMatch = text.match(/(\/[^\s]+|~[^\s]+)/);
                if (pathMatch) {
                    result.afterReloadOrder.push(pathMatch[0]);
                } else {
                    result.afterReloadOrder.push(text.substring(0, 60).trim());
                }
            }
            console.log(`  After reload order: ${JSON.stringify(result.afterReloadOrder)}`);
        } else if (draggableCount === 1) {
            result.notes.push('Only 1 draggable group found — need at least 2 to test reordering');
        }

        // ========== TEST 4: Archive/grouping still works ==========
        console.log('\n=== TEST 4: Archive/grouping ===');
        // Right-click to check popover
        const sessionLinks = await page.locator('a[href*="/session/"]').all();
        if (sessionLinks.length > 0) {
            await sessionLinks[0].click({ button: 'right' });
            await page.waitForTimeout(1000);
            await page.screenshot({ path: path.join(OUTPUT_DIR, '04-right-click-popover.png') });

            const body = await page.textContent('body') || '';
            result.rightClickArchiveVisible = body.includes('Archive');
            console.log(`  Archive visible: ${result.rightClickArchiveVisible}`);

            // Dismiss popover
            await page.keyboard.press('Escape');
        } else {
            // Try right-clicking on a session row (Pressable, not necessarily an <a>)
            const draggableGroups = page.locator('[draggable="true"]');
            if (await draggableGroups.count() > 0) {
                await draggableGroups.first().click({ button: 'right' });
                await page.waitForTimeout(1000);
                await page.screenshot({ path: path.join(OUTPUT_DIR, '04-right-click-popover.png') });

                const body = await page.textContent('body') || '';
                result.rightClickArchiveVisible = body.includes('Archive');
                console.log(`  Archive visible: ${result.rightClickArchiveVisible}`);

                await page.keyboard.press('Escape');
            } else {
                result.notes.push('No session links or draggable groups found for archive test');
            }
        }

        await page.close();

    } finally {
        await context.close();
        await browser.close();
    }

    // ========== Write results ==========
    console.log('\n\n=== VALIDATION RESULTS ===');
    console.log(`Draggable count: ${result.draggableCount}`);
    console.log(`Group count: ${result.groupCount}`);
    console.log(`Initial order: ${JSON.stringify(result.initialOrder)}`);
    console.log(`After drag order: ${JSON.stringify(result.afterDragOrder)}`);
    console.log(`After reload order: ${JSON.stringify(result.afterReloadOrder)}`);
    console.log(`Archive visible: ${result.rightClickArchiveVisible}`);
    console.log(`Reorder worked: ${result.reorderWorked}`);
    console.log(`Notes: ${JSON.stringify(result.notes)}`);

    const passed = result.draggableCount > 0;
    console.log(`\nOverall: ${passed ? 'PASS' : 'FAIL'} — draggable nodes ${passed ? 'exist' : 'missing'}`);

    fs.writeFileSync(
        path.join(OUTPUT_DIR, 'validation-results.json'),
        JSON.stringify(result, null, 2),
    );
}

main().catch(err => {
    console.error('FATAL:', err);
    process.exit(1);
});
