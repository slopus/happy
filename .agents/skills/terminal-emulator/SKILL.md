---
name: terminal-emulator
description: Test interactive CLI/TUI applications using @microsoft/tui-test. Use when you need to test CLI tools with interactive prompts, TUI rendering, arrow key navigation, or any command that requires a TTY. Triggers include "test CLI", "test TUI", "run interactively", "automate terminal input", "simulate user input in terminal".
allowed-tools: Bash(npx tui-test:*), Bash(node:*)
---

# Testing Interactive CLI / TUI with @microsoft/tui-test

Playwright-like API for terminals. Real PTY per test. Made by Microsoft.

- **GitHub**: https://github.com/microsoft/tui-test
- **npm**: `@microsoft/tui-test`

## Install

```bash
yarn add -D @microsoft/tui-test
```

## Usage

```typescript
import { test, expect } from '@microsoft/tui-test';

test.use({ program: { file: 'node', args: ['./my-cli.js'] } });

test('selects option and proceeds', async ({ terminal }) => {
    await expect(terminal.getByText('Select an option')).toBeVisible();
    await terminal.write('\x1B[B');  // Arrow Down
    await terminal.submit();          // Enter
    await expect(terminal.getByText('Option 2 selected')).toBeVisible();
});

test('matches snapshot', async ({ terminal }) => {
    await expect(terminal).toMatchSnapshot();
});
```

## API

```typescript
// Navigation
await terminal.write('\x1B[A');    // Arrow Up
await terminal.write('\x1B[B');    // Arrow Down
await terminal.write('\x1B[C');    // Arrow Right
await terminal.write('\x1B[D');    // Arrow Left
await terminal.submit();           // Enter
await terminal.write('\t');        // Tab
await terminal.write('\x03');      // Ctrl+C
await terminal.write('\x1B');      // Escape
await terminal.write('\x7F');      // Backspace
await terminal.write('hello');     // Type text

// Assertions
await expect(terminal.getByText('pattern')).toBeVisible();
await expect(terminal.getByText('pattern', { full: true })).toBeVisible();
await expect(terminal).toMatchSnapshot();

// Reading
const content = terminal.content;  // Full terminal content as string
```

## Running

```bash
npx tui-test                       # Run all tests
npx tui-test --update-snapshots    # Update snapshots
npx tui-test my-test.ts            # Run specific test
```

## Reference

- Used by VS Code terminal team
- Real PTY isolation per test (no mocking)
- Auto-waits for terminal renders
- Cross-platform (macOS, Linux, Windows)
- Snapshot testing built-in
