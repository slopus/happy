import { dirname, resolve } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

export function projectPath() {
    const path = resolve(__dirname, '..');
    // console.log('path', path)
    return path;
}