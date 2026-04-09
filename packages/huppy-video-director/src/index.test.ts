import { describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import { buildProgram } from './index'
import packageJson from '../package.json'

const currentDir = dirname(fileURLToPath(import.meta.url))
const packageRoot = resolve(currentDir, '..')

describe('buildProgram', () => {
  it('exposes the run command with the expected options and description', () => {
    const program = buildProgram()
    const runCommand = program.commands.find((command) => command.name() === 'run')

    expect(runCommand).toBeTruthy()
    expect(runCommand?.description()).toContain('brief')

    const options = runCommand?.options ?? []

    const briefOption = options.find((option) => option.long === '--brief')
    const profileOption = options.find((option) => option.long === '--profile')
    const assetsOption = options.find((option) => option.long === '--assets')
    const styleOption = options.find((option) => option.long === '--style')

    expect(briefOption?.mandatory).toBe(true)
    expect(profileOption?.mandatory).toBe(true)
    expect(assetsOption?.mandatory).toBe(false)
    expect(styleOption?.mandatory).toBe(false)
  })

  it('smokes the packaged bin entrypoint', () => {
    const binEntry = packageJson.bin['huppy-video-director']
    const binPath = resolve(packageRoot, binEntry)

    expect(existsSync(binPath)).toBe(true)

    const output = execFileSync(process.execPath, [binPath, 'run', '--brief', 'trim a trailer', '--profile', 'default'], {
      cwd: packageRoot,
      encoding: 'utf8',
      timeout: 10000,
    })

    expect(output).toContain('trim a trailer')
    expect(output).toContain('default')
  })
})
