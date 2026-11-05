import { chromium } from 'playwright';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { root } from './paths.mjs';

export async function withBrowser(action) {
  await mkdir(join(root, '.cache'), { recursive: true });
  const temp = await mkdtemp(join(root, '.cache/browser-'));
  process.env.TMPDIR = temp;
  let browser;
  try {
    browser = await chromium.launch({ headless: true, executablePath: process.env.CHROMIUM || undefined,
      args: ['--allow-file-access-from-files', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
    return await action(browser, temp);
  } finally {
    if (browser) await browser.close();
    await rm(temp, { recursive: true, force: true });
  }
}