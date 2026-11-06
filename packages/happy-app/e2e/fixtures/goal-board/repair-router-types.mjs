import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const sourceRoot = path.join(appRoot, 'sources/app');
// The application uses a custom sources/app root; never infer app/ or src/app/ in fixture tooling.
process.env.EXPO_ROUTER_APP_ROOT = sourceRoot;
const require = createRequire(path.join(appRoot, 'package.json'));
const { requireContext } = require('expo-router/internal/testing');
const { EXPO_ROUTER_CTX_IGNORE } = require('expo-router/_ctx-shared');
const { getTypedRoutesDeclarationFile } = require('@expo/router-server/build/typed-routes/generate');
const sourceContext = requireContext(sourceRoot, true, EXPO_ROUTER_CTX_IGNORE);
// Mirror Metro's existing test-file blockList. Expo's standalone typed-route scanner does not consume it.
const ctx = Object.assign(key => sourceContext(key), sourceContext);
ctx.keys = () => sourceContext.keys().filter(key => !/\.test\.[cm]?[jt]sx?$/.test(key));
assert(ctx.keys().length > 0, 'Explicit App route root must contain routes');
const declaration = getTypedRoutesDeclarationFile(ctx, {});
assert(declaration.includes('/session/'), 'Typed route output must contain actual application routes');
const output = path.join(appRoot, '.expo/types/router.d.ts');
await fs.mkdir(path.dirname(output), { recursive: true });
await fs.writeFile(output, declaration);
console.log(JSON.stringify({ sourceRoot, output, routes: ctx.keys().length, bytes: declaration.length }));
