#!/usr/bin/env node
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
if (process.platform !== 'win32' || process.arch !== 'x64') {
  throw new Error('The Windows session launcher must be built on Windows x64');
}
const systemRoot = process.env.SystemRoot;
if (!systemRoot || !/^[A-Za-z]:\\/.test(systemRoot) || path.resolve(systemRoot) !== systemRoot) {
  throw new Error('A canonical absolute SystemRoot is required');
}
const compiler = path.join(systemRoot, 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe');
if (!fs.statSync(compiler).isFile()) throw new Error('The Windows .NET Framework x64 compiler is required');
const source = path.resolve(__dirname, '../native/windowsSessionLauncher.cs');
const output = path.resolve(process.argv[2] || path.join(__dirname, '../native/windows-x64/session-launcher.exe'));
fs.mkdirSync(path.dirname(output), { recursive: true });
const result = spawnSync(compiler, ['/nologo', '/target:exe', '/platform:x64', '/optimize+', '/out:' + output, source], { stdio: 'inherit', shell: false });
if (result.error) throw result.error;
if (result.status !== 0) process.exit(result.status || 1);
console.log(output);
