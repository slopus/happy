import { spawn } from 'node:child_process'
import { logger } from '@/ui/logger'
import { claudePath } from './claudePath'

export interface ClaudeProcessOptions {
  command: string  // Natural language prompt for Claude
  sessionId?: string
  workingDirectory: string
  model?: string
  permissionMode?: 'auto' | 'default' | 'plan'
  skipPermissions?: boolean
}

export interface ClaudeOutput {
  type: 'json' | 'text' | 'error' | 'exit'
  data?: any
  error?: string
  code?: number | null
  signal?: string | null
}

/**
 * Launch Claude process and yield output lines
 */
export async function* claude(options: ClaudeProcessOptions): AsyncGenerator<ClaudeOutput> {
  const args = buildArgs(options)
  const path = claudePath()
    
  const process = spawn(path, args, {
    cwd: options.workingDirectory,
    stdio: ['pipe', 'pipe', 'pipe'],
    shell: false
  })
  
  // Close stdin immediately (we don't send input)
  process.stdin?.end()
  
  // Set up output processing
  let outputBuffer = ''
  let stderrBuffer = ''
  let processExited = false
  
  // Create a queue for outputs
  const outputQueue: ClaudeOutput[] = []
  let outputResolve: (() => void) | null = null
  
  // Handle stdout
  process.stdout?.on('data', (data: Buffer) => {
    outputBuffer += data.toString()
    
    // Process complete lines
    const lines = outputBuffer.split('\n')
    outputBuffer = lines.pop() || ''
    
    for (const line of lines) {
      if (line.trim()) {
        try {
          const json = JSON.parse(line)
          outputQueue.push({ type: 'json', data: json })
        } catch {
          outputQueue.push({ type: 'text', data: line })
        }
        
        if (outputResolve) {
          outputResolve()
          outputResolve = null
        }
      }
    }
  })
  
  // Handle stderr  
  process.stderr?.on('data', (data: Buffer) => {
    stderrBuffer += data.toString()
    const lines = stderrBuffer.split('\n')
    stderrBuffer = lines.pop() || ''
    
    for (const line of lines) {
      if (line.trim()) {
        outputQueue.push({ type: 'error', error: line })
        if (outputResolve) {
          outputResolve()
          outputResolve = null
        }
      }
    }
  })
  
  // Handle process exit
  process.on('exit', (code, signal) => {
    processExited = true
    outputQueue.push({ type: 'exit', code, signal })
    if (outputResolve) {
      outputResolve()
      outputResolve = null
    }
  })
  
  // Handle process error
  process.on('error', (error) => {
    outputQueue.push({ type: 'error', error: error.message })
    // Mark as exited since process won't emit exit after error
    processExited = true
    if (outputResolve) {
      outputResolve()
      outputResolve = null
    }
  })
  
  // Yield outputs as they come
  while (!processExited || outputQueue.length > 0) {
    if (outputQueue.length === 0) {
      // Wait for more output
      await new Promise<void>((resolve) => {
        outputResolve = resolve
        // Check again in case output arrived
        if (outputQueue.length > 0 || processExited) {
          resolve()
          outputResolve = null
        }
      })
    }
    
    // Yield all queued outputs
    while (outputQueue.length > 0) {
      const output = outputQueue.shift()!
      yield output
    }
  }
  
  // Process any remaining output in buffers
  if (outputBuffer.trim()) {
    try {
      const json = JSON.parse(outputBuffer)
      yield { type: 'json', data: json }
    } catch {
      yield { type: 'text', data: outputBuffer }
    }
  }
  
  if (stderrBuffer.trim()) {
    yield { type: 'error', error: stderrBuffer }
  }
}

/**
 * Build command line arguments for Claude
 */
function buildArgs(options: ClaudeProcessOptions): string[] {
  const args = [
    '--print', options.command,
    '--output-format', 'stream-json',
    '--verbose'
  ]
  
  // Add model
  if (options.model) {
    args.push('--model', options.model)
  }
  
  // Add permission mode
  if (options.permissionMode) {
    const modeMap = {
      'auto': 'acceptEdits',
      'default': 'default',
      'plan': 'bypassPermissions'
    }
    args.push('--permission-mode', modeMap[options.permissionMode])
  }
  
  // Add skip permissions flag
  if (options.skipPermissions) {
    args.push('--dangerously-skip-permissions')
  }
  
  // Add session resume if we have a session ID
  if (options.sessionId) {
    args.push('--resume', options.sessionId)
  }
  
  return args
}