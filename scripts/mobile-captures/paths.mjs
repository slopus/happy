import { fileURLToPath } from 'node:url';
import { readFile } from 'node:fs/promises';
export const root = fileURLToPath(new URL('.', import.meta.url));
export const presets = JSON.parse(await readFile(new URL('presets.json', import.meta.url)));
export const names = ['01-home', '02-feed', '03-model-accounts', '04-servers', '05-voice'];
export function preset(name) {
  if (!Object.hasOwn(presets, name)) throw Error(`Unknown preset ${name}; choose ${Object.keys(presets).join(', ')}`);
  return presets[name];
}