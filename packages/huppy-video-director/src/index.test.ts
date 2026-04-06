import { describe, expect, it } from 'vitest'
import { buildProgram } from './index'

describe('buildProgram', () => {
  it('exposes the run command and mentions brief in the description', () => {
    const program = buildProgram()
    const runCommand = program.commands.find((command) => command.name() === 'run')

    expect(runCommand).toBeTruthy()
    expect(runCommand?.description()).toContain('brief')
  })
})
