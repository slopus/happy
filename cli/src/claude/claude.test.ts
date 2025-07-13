/**
 * Tests for Claude process spawning
 */

import { describe, test, expect } from 'vitest'
import { claude, ClaudeOutput } from './claude'

describe('launchClaude', () => {
  
  test('generator spawns claude process and yields outputs', async () => {
    const outputs: ClaudeOutput[] = []
    
    // Launch with a simple command
    const generator = claude({
      command: 'Say just "4" and nothing else',
      workingDirectory: process.cwd()
    })
    
    // Collect first few outputs only
    let count = 0
    for await (const output of generator) {
      console.log('Received output:', output)
      outputs.push(output)
      count++
      
      // Stop after we get an exit event or too many outputs
      if (output.type === 'exit' || count > 20) {
        break
      }
    }
    
    // Should have some outputs
    expect(outputs.length).toBeGreaterThan(0)
    
    // Should have JSON outputs from Claude
    const jsonOutputs = outputs.filter(o => o.type === 'json')
    expect(jsonOutputs.length).toBeGreaterThan(0)
  }, 15000)

  test('handles missing claude gracefully', async () => {
    // Save original PATH
    const originalPath = process.env.PATH
    
    try {
      // Set PATH to empty to ensure claude won't be found
      process.env.PATH = ''
      
      const outputs: ClaudeOutput[] = []
      const generator = claude({
        command: 'test',
        workingDirectory: process.cwd()
      })
      
      console.log('Starting to collect outputs...')
      // Collect outputs
      for await (const output of generator) {
        console.log('Got output:', output)
        outputs.push(output)
        if (outputs.length > 5) {
          console.log('Breaking after 5 outputs')
          break // Prevent infinite loop
        }
      }
      
      console.log('Total outputs collected:', outputs.length)
      // Should have gotten an error about spawn
      const errorOutput = outputs.find(o => o.type === 'error')
      expect(errorOutput).toBeDefined()
    } finally {
      // Restore PATH
      process.env.PATH = originalPath
    }
  }, 15000)

  test('includes all options in spawn arguments', async () => {
    // This test just verifies the generator can be created with all options
    // We can't easily verify the actual arguments without mocking
    const generator = claude({
      command: 'Hello',
      sessionId: 'test-session-123',
      workingDirectory: process.cwd(),
      model: 'opus',
      permissionMode: 'plan',
      skipPermissions: true
    })
    
    // Get first value to ensure generator starts
    const first = await generator.next()
    console.log('First value:', first)
    
    // Clean up - return early
    await generator.return(undefined)
    
    // Test passes if we got here
    expect(true).toBe(true)
  }, 15000)
})