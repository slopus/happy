import { describe, it, expect, vi, afterEach } from 'vitest'

describe('unpack-tools platform mapping', () => {
  afterEach(() => {
    vi.restoreAllMocks()
    vi.resetModules()
  })

  it('maps win32 arm64 to x64-win32 (Windows x64 emulation)', () => {
    const os = require('os')
    vi.spyOn(os, 'platform').mockReturnValue('win32')
    vi.spyOn(os, 'arch').mockReturnValue('arm64')

    const { getPlatformDir } = require('../unpack-tools.cjs')
    expect(getPlatformDir()).toBe('x64-win32')
  })
})
