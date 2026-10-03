import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import shellquote from 'shell-quote';
import { SandboxManager } from '@anthropic-ai/sandbox-runtime';
import { describe, expect, it } from 'vitest';
import { SandboxConfigSchema } from '@/persistence';
import { buildSandboxRuntimeConfig } from '@/sandbox/config';
import { wrapCommand } from '@/sandbox/manager';
import { canonicalizeSessionWriteRoot } from './sessionWriteScopePaths';
import { scopeSandboxEnvironment } from './sessionWriteScopeRestart';

describe.skipIf(process.platform !== 'darwin' && !(process.platform === 'linux' && process.env.HAPPY_SCOPE_NATIVE_LINUX === '1'))('session write scope actual OS enforcement', () => {
  it('enforces pre-grant, inherited child, sibling/symlink/credential denies and revoked new profile', async () => {
    // /tmp has runtime allowances; test the actual denied boundary in a private checkout fixture.
    const fixture = await realpath(await mkdtemp(join(process.cwd(), '.session-write-scope-')));
    const home = join(fixture, 'home'), project = join(fixture, 'project');
    const root = join(home, '.local', 'tools'), sibling = join(home, '.local', 'other'), protectedRoot = join(home, '.ssh');
    try {
      await Promise.all([root, sibling, protectedRoot, project].map(path => mkdir(path, { recursive: true })));
      await writeFile(join(protectedRoot, 'key'), 'fixture credential');
      await symlink(sibling, join(root, 'escape'));
      const config = SandboxConfigSchema.parse({ sessionIsolation: 'strict', extraWritePaths: [],
        denyReadPaths: [protectedRoot], denyWritePaths: [protectedRoot] });
      const approved = await canonicalizeSessionWriteRoot(root, { home, protectedRoots: [protectedRoot] });
      const environment = scopeSandboxEnvironment(config, [approved], project);
      const applied = SandboxConfigSchema.parse(JSON.parse(environment.HAPPY_PROJECT_SANDBOX_CONFIG));
      async function execute(policy: typeof config, code: string) {
        await SandboxManager.initialize(buildSandboxRuntimeConfig(policy, project, 'mandatory'));
        try {
          const command = await wrapCommand(shellquote.quote([process.execPath, '-e', code]));
          const result = spawnSync('/bin/sh', ['-c', command], { cwd: project, encoding: 'utf8', timeout: 10000,
            maxBuffer: 1024 * 1024, env: { PATH: process.env.PATH, HOME: home } });
          if (result.error || result.status !== 0) throw result.error ?? new Error(`sandbox fixture failed: ${result.stderr}`);
          return JSON.parse(result.stdout.trim());
        } finally { await SandboxManager.reset(); }
      }
      const attemptedWrite = (path: string) => `try {require('fs').writeFileSync(${JSON.stringify(path)},'fixture'); console.log(JSON.stringify({allowed:true}));} catch(e){console.log(JSON.stringify({code:e.code,path:e.path,syscall:e.syscall}));}`;
      const before = await execute(config, attemptedWrite(join(root, 'before')));
      expect(['EPERM', 'EACCES', 'EROFS']).toContain(before.code); expect(before.path).toBe(join(root, 'before'));
      expect(await execute(applied, attemptedWrite(join(root, 'approved')))).toEqual({ allowed: true });
      const child = await execute(applied, `const cp=require('child_process');const result=cp.spawnSync(${JSON.stringify(process.execPath)},['-e',${JSON.stringify(attemptedWrite(join(root, 'child')))}],{encoding:'utf8'});if(result.status===0)process.stdout.write(result.stdout);else throw new Error(result.stderr);`);
      expect(child).toEqual({ allowed: true });
      for (const path of [join(sibling, 'denied'), join(root, 'escape', 'denied')]) {
        const denied = await execute(applied, attemptedWrite(path));
        expect(['EPERM', 'EACCES', 'EROFS']).toContain(denied.code); expect(denied.path).toBe(path); expect(denied.syscall).toBe('open');
      }
      const credentialWrite = await execute(applied, attemptedWrite(join(protectedRoot, 'key')));
      if (process.platform !== 'linux') expect(['EPERM', 'EACCES']).toContain(credentialWrite.code);
      // Linux denyRead uses a private tmpfs: a successful shadow write must never touch the host credential.
      expect(await readFile(join(protectedRoot, 'key'), 'utf8')).toBe('fixture credential');
      const readDenied = await execute(applied, `try{require('fs').readFileSync(${JSON.stringify(join(protectedRoot, 'key'))});console.log('{}')}catch(e){console.log(JSON.stringify({code:e.code}))}`);
      expect(['EPERM', 'EACCES', ...(process.platform === 'linux' ? ['ENOENT'] : [])]).toContain(readDenied.code);
      expect(await readFile(join(protectedRoot, 'key'), 'utf8')).toBe('fixture credential');
      const revoked = await execute(config, attemptedWrite(join(root, 'after-revoke')));
      expect(['EPERM', 'EACCES', 'EROFS']).toContain(revoked.code);
      expect(await readFile(join(root, 'approved'), 'utf8')).toBe('fixture');
      expect(await readFile(join(root, 'child'), 'utf8')).toBe('fixture');
    } finally { await SandboxManager.reset(); await rm(fixture, { recursive: true, force: true }); }
  }, 30000);
});
