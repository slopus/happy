import { describe, it, expect, beforeEach, afterEach } from 'vitest'
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
  beforeEach(() => {
    console.log('\n--- BEFORE TEST ---')
    killAllDaemons()
    initializeConfiguration('global')
  })

  afterEach(() => {
    console.log('\n--- AFTER TEST ---')
    killAllDaemons()
  })

  it('daemon writes PID file', () => {
    console.log('Starting daemon...')
    console.log('Test expects PID file at:', configuration.daemonPidFile)
    
    // Start daemon in background
    execSync('npx tsx src/index.ts daemon start > daemon.log 2>&1 &', { 
      cwd: process.cwd()
    })
    
    // Wait for PID file
    console.log('Waiting for PID file...')
    let attempts = 0
    while (!existsSync(configuration.daemonPidFile) && attempts < 30) {
      execSync('sleep 0.1')
      attempts++
    }
    
    console.log(`PID file exists after ${attempts} attempts: ${existsSync(configuration.daemonPidFile)}`)
    expect(existsSync(configuration.daemonPidFile)).toBe(true)
    
    const pid = readFileSync(configuration.daemonPidFile, 'utf-8').trim()
    console.log(`PID from file: ${pid}`)
    expect(parseInt(pid)).toBeGreaterThan(0)
  })

  it('second daemon should not start', () => {
    console.log('Starting first daemon...')
    
    // Start first daemon
    execSync('npx tsx src/index.ts daemon start > daemon1.log 2>&1 &', { 
      cwd: process.cwd()
    })
    
    // Wait for PID file
    let attempts = 0
    while (!existsSync(configuration.daemonPidFile) && attempts < 30) {
      execSync('sleep 0.1')
      attempts++
    }
    
    const firstPid = readFileSync(configuration.daemonPidFile, 'utf-8').trim()
    console.log(`First daemon PID: ${firstPid}`)
    
    // Try to start second daemon
    console.log('Starting second daemon...')
    const result = execSync('npx tsx src/index.ts daemon start 2>&1 || true', {
      encoding: 'utf-8'
    })
    
    console.log(`Second daemon output: ${result}`)
    expect(result).toContain('already running')
    
    // PID should still be the first one
    const currentPid = readFileSync(configuration.daemonPidFile, 'utf-8').trim()
    expect(currentPid).toBe(firstPid)
  })
})