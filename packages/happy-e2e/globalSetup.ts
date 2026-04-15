import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';

export default async function globalSetup() {
    // Generate a unique PGlite directory for this test run so DB is isolated.
    // Written to a side-channel file so playwright.config.ts can read it.
    const pgliteDir = path.join(os.tmpdir(), `happy-e2e-${Date.now()}`);
    process.env.PGLITE_DIR = pgliteDir;
    fs.writeFileSync(path.join(__dirname, '.pglite-dir'), pgliteDir);
}
