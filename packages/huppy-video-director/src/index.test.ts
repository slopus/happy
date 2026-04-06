import { describe, expect, it } from 'vitest'
import { buildProgram } from './index'

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
})
