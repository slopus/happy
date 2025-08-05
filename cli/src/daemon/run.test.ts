import { describe, it, expect, beforeEach, afterEach, beforeAll } from 'vitest'
import { execSync } from 'child_process'
import { existsSync, readFileSync, rmdirSync, unlinkSync } from 'fs'
import path from 'path'
import os from 'os'
import { configuration, initializeConfiguration } from '@/configuration'

function killAllDaemons() {
  try {
    // Kill by PID file
    if (existsSync(configuration.daemonPidFile)) {
      const pid = readFileSync(configuration.daemonPidFile, 'utf-8').trim()
      console.log(`Killing daemon from PID file: ${pid}`)
      try {
        process.kill(parseInt(pid), 'SIGKILL')
      } catch {}
      unlinkSync(configuration.daemonPidFile)
    }
    
    // Kill any stragglers
    execSync("pkill -f 'daemon start' || true", { stdio: 'ignore' })
  } catch {}
}

describe('daemon tests', () => {
  const happyBinPath = path.join(process.cwd(), 'bin/happy')
  
  beforeAll(() => {
    console.log('Building happy distribution...')
    execSync('yarn build', { stdio: 'inherit' })
    console.log('Build complete!')
  })
  
  beforeEach(() => {
    console.log('\n--- BEFORE TEST ---')
    killAllDaemons()
    initializeConfiguration('global')
  })

  afterEach(() => {
    console.log('\n--- AFTER TEST ---')
    killAllDaemons()
  })

  it('daemon writes PID file', async () => {
    console.log('Starting daemon...')
    console.log('Test expects PID file at:', configuration.daemonPidFile)
    
    // Start daemon using the built binary
    const { spawn } = await import('child_process')
    
    const daemonProcess = spawn(happyBinPath, ['daemon', 'start'], {
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe']
    })
    
    // Capture output for debugging
    let stdout = ''
    let stderr = ''
    daemonProcess.stdout.on('data', (data) => {
      stdout += data.toString()
      console.log('DAEMON STDOUT:', data.toString())
    })
    daemonProcess.stderr.on('data', (data) => {
      stderr += data.toString()
      console.log('DAEMON STDERR:', data.toString())
    })
    
    daemonProcess.unref()
    
    // Wait for PID file
    console.log('Waiting for PID file...')
    let attempts = 0
    while (!existsSync(configuration.daemonPidFile) && attempts < 50) {
      await new Promise(resolve => setTimeout(resolve, 100))
      attempts++
    }
    
    console.log(`PID file exists after ${attempts} attempts: ${existsSync(configuration.daemonPidFile)}`)
    
    if (!existsSync(configuration.daemonPidFile)) {
      console.log('STDOUT:', stdout)
      console.log('STDERR:', stderr)
    }
    
    expect(existsSync(configuration.daemonPidFile)).toBe(true)
    
    const pid = readFileSync(configuration.daemonPidFile, 'utf-8').trim()
    console.log(`PID from file: ${pid}`)
    expect(parseInt(pid)).toBeGreaterThan(0)
  }, 10000)

  it('second daemon should not start', async () => {
    console.log('Starting first daemon...')
    
    // Start first daemon using the built binary
    const { spawn } = await import('child_process')
    
    const firstDaemon = spawn(happyBinPath, ['daemon', 'start'], {
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe']
    })
    firstDaemon.unref()
    
    // Wait for PID file
    let attempts = 0
    while (!existsSync(configuration.daemonPidFile) && attempts < 50) {
      await new Promise(resolve => setTimeout(resolve, 100))
      attempts++
    }
    
    const firstPid = readFileSync(configuration.daemonPidFile, 'utf-8').trim()
    console.log(`First daemon PID: ${firstPid}`)
    
    // Try to start second daemon
    console.log('Starting second daemon...')
    const result = execSync(`${happyBinPath} daemon start 2>&1 || true`, {
      encoding: 'utf-8'
    })
    
    console.log(`Second daemon output: ${result}`)
    expect(result).toContain('already running')
    
    // PID should still be the first one
    const currentPid = readFileSync(configuration.daemonPidFile, 'utf-8').trim()
    expect(currentPid).toBe(firstPid)
  }, 10000)

  it('daemon spawn-happy-session RPC test', () => {
    /*
     * Test the happy path of spawning a new session via daemon RPC:
     * 
     * What happens under the hood:
     * 
     * 1. Daemon starts up on macOS:
     *    - Creates HTTP callback server on random port (e.g., 9527)
     *    - Connects to server via socket.io
     *    - Registers 'rpc-request' handler
     * 
     * 2. Mobile client sends RPC call:
     *    - Calls 'spawn-happy-session' with directory parameter
     *    - Server forwards RPC to daemon's socket
     * 
     * 3. Daemon receives RPC and:
     *    - Generates unique nonce (e.g., 'abc123')
     *    - Creates promise that waits for callback
     *    - Uses AppleScript to open Terminal with:
     *      happy --happy-starting-mode remote --happy-daemon-port 9527 --happy-daemon-new-session-nonce abc123
     * 
     * 4. Happy CLI process starts:
     *    - Parses daemon callback parameters
     *    - Creates session normally via API
     *    - Gets session ID (e.g., 'sess_xyz')
     *    - Immediately after session creation, POSTs to daemon:
     *      http://127.0.0.1:9527/on-new-session
     *      { nonce: 'abc123', happySessionId: 'sess_xyz', happyProcessId: 12345 }
     * 
     * 5. Daemon HTTP server receives callback:
     *    - Validates nonce matches
     *    - Resolves the promise with session ID
     *    - Deletes nonce from map
     * 
     * 6. RPC response sent back:
     *    - Daemon returns { ok: true, result: { sessionId: 'sess_xyz' } }
     *    - Mobile client receives session ID
     *    - Mobile can now connect to this session
     * 
     * Edge cases handled:
     * - 30 second timeout if happy process doesn't callback
     * - Invalid nonce returns 401 error
     * - Missing directory parameter returns error
     * - Non-macOS platforms fail immediately
     */
    
    // Test implementation would mock the socket.io connection,
    // spawn command, and HTTP callback to verify the flow
    console.log('This test would require mocking socket.io and spawn commands')
  })
})