import { describe, expect, it, vi } from 'vitest'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const command = vi.hoisted(() => ({ root: '' }))
vi.mock('node:child_process', () => ({
  execFile: Object.assign(() => {}, { [Symbol.for('nodejs.util.promisify.custom')]: async () => ({ stdout: command.root, stderr: '' }) }),
}))
import {
  getCodexMultiAuthProxyStatus,
  prepareCodexMultiAuthProxy,
} from './codexMultiAuthProxy'

describe('Codex multi-auth proxy adapter', () => {
  it('starts a loopback proxy at the 5% cutoff and returns official Codex config arguments', async () => {
    const close = vi.fn(async () => undefined)
    const startProxy = vi.fn(async () => ({ baseUrl: 'http://127.0.0.1:4567', close }))
    const prepared = await prepareCodexMultiAuthProxy({
      CODEX_HOME: '/fixed/codex',
      PATH: '/usr/bin',
    }, {
      readFile: vi.fn(async () => JSON.stringify({
        version: 1,
        pluginConfig: {
          codexRuntimeRotationProxy: true,
          schedulingStrategy: 'sequential',
          preemptiveQuotaEnabled: true,
          preemptiveQuotaRemainingPercent5h: 5,
          preemptiveQuotaRemainingPercent7d: 5,
          routingMutex: 'enabled',
          sessionAffinity: false,
          pidOffsetEnabled: false,
        },
      })),
      startProxy,
      createClientKey: () => 'local-client-key',
    })

    expect(startProxy).toHaveBeenCalledWith({
      clientApiKey: 'local-client-key',
      quotaRemainingPercentThreshold: 5,
    })
    expect(prepared).toMatchObject({
      env: {
        CODEX_HOME: '/fixed/codex',
        CODEX_MULTI_AUTH_DIR: '/fixed/codex/multi-auth',
        OPENAI_API_KEY: 'local-client-key',
      },
      args: expect.arrayContaining([
        '-c', 'model_provider="codex-multi-auth-runtime-proxy"',
      ]),
    })
    expect(getCodexMultiAuthProxyStatus()).toEqual({ activeRoutes: 1 })

    await prepared?.cleanup()

    expect(close).toHaveBeenCalledOnce()
    expect(getCodexMultiAuthProxyStatus()).toEqual({ activeRoutes: 0 })
  })

  it('does not route machines without an enabled managed configuration', async () => {
    const startProxy = vi.fn()
    const prepared = await prepareCodexMultiAuthProxy({}, {
      readFile: vi.fn(async () => JSON.stringify({ version: 1, pluginConfig: {} })),
      startProxy,
      createClientKey: () => 'unused',
    })

    expect(prepared).toBeNull()
    expect(startProxy).not.toHaveBeenCalled()
  })

  it('fails closed when a managed proxy configuration drifts from the 5% policy', async () => {
    const startProxy = vi.fn()

    await expect(prepareCodexMultiAuthProxy({}, {
      readFile: vi.fn(async () => JSON.stringify({
        version: 1,
        pluginConfig: {
          codexRuntimeRotationProxy: true,
          schedulingStrategy: 'sequential',
          preemptiveQuotaEnabled: false,
          preemptiveQuotaRemainingPercent5h: 5,
          preemptiveQuotaRemainingPercent7d: 5,
          routingMutex: 'enabled',
          sessionAffinity: false,
          pidOffsetEnabled: false,
        },
      })),
      startProxy,
      createClientKey: () => 'unused',
    })).rejects.toThrow(/settings/i)
    expect(startProxy).not.toHaveBeenCalled()
  })

  it('fails closed when the managed settings file is malformed', async () => {
    await expect(prepareCodexMultiAuthProxy({}, {
      readFile: vi.fn(async () => '{not-json'),
      startProxy: vi.fn(),
      createClientKey: () => 'unused',
    })).rejects.toThrow(/settings/i)
  })
})

// Exercise package discovery and dynamic loading, not the injected startProxy shortcut.
it.each(['2.16.0', '2.17.0', '2.18.0'])('loads only a supported global proxy package: %s', async (version) => {
  const root = await mkdtemp(join(tmpdir(), 'happy-proxy-version-'))
  command.root = root
  const packageRoot = join(root, 'codex-multi-auth')
  await mkdir(join(packageRoot, 'dist/lib'), { recursive: true })
  await writeFile(join(packageRoot, 'package.json'), JSON.stringify({ version, type: 'module' }))
  await writeFile(join(packageRoot, 'dist/lib/runtime-rotation-proxy.js'),
    'export async function startRuntimeRotationProxy() { return { baseUrl: "http://127.0.0.1:4567", async close() {} } }')
  const settings = { version: 1, pluginConfig: {
    codexRuntimeRotationProxy: true, schedulingStrategy: 'sequential', preemptiveQuotaEnabled: true,
    preemptiveQuotaRemainingPercent5h: 5, preemptiveQuotaRemainingPercent7d: 5,
    routingMutex: 'enabled', sessionAffinity: false, pidOffsetEnabled: false,
  } }
  // Vitest's VM cannot evaluate Function-created dynamic imports. Preserve real file loading.
  const importer = vi.spyOn(globalThis, 'Function').mockReturnValue(async (url: string) => {
    importer.mockRestore()
    return import(/* @vite-ignore */ url)
  })
  try {
    const result = prepareCodexMultiAuthProxy({}, { readFile: async () => JSON.stringify(settings) })
    if (version === '2.18.0') {
      await expect(result).rejects.toThrow(/2.18.0/)
    } else {
      const prepared = await result
      expect(prepared).not.toBeNull()
      await prepared!.cleanup()
    }
  } finally {
    importer.mockRestore()
    await rm(root, { recursive: true, force: true })
  }
})
