/**
 * Tests for Claude SDK integration
 */

import { describe, test, expect } from 'vitest'
import { claude, ClaudeOutput } from './claudeSdk'

describe('claudeSdk', () => {
  test('should yield SDK messages', async () => {
    const outputs: ClaudeOutput[] = []
    
    // Test with a simple command
    const generator = claude({
      command: 'Say "Hello SDK" and nothing else',
      workingDirectory: process.cwd()
    })
    
    // Collect outputs with timeout
    const timeout = setTimeout(() => {
      generator.return(undefined)
    }, 5000)
    
    try {
      for await (const output of generator) {
        console.log('SDK output:', output)
        outputs.push(output)
        
        // Stop after exit
        if (output.type === 'exit') {
          break
        }
        
        // Safety limit
        if (outputs.length > 50) {
          break
        }
      }
    } finally {
      clearTimeout(timeout)
    }
    
    // Should have some outputs
    expect(outputs.length).toBeGreaterThan(0)
    
    // Should have system init message
    const systemInit = outputs.find(o => 
      o.type === 'json' && 
      o.data?.type === 'system' && 
      o.data?.subtype === 'init'
    )
    expect(systemInit).toBeDefined()
    
    // Should have exit
    const exitOutput = outputs.find(o => o.type === 'exit')
    expect(exitOutput).toBeDefined()
  }, 10000)
})