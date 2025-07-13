/**
 * Tests for the QR code utility
 * 
 * These tests verify the QR code generation functionality works correctly
 * and handles edge cases gracefully.
 */

import { describe, it, expect } from 'vitest'

import { displayQRCode } from './qrcode.js'

describe('QR Code Utility', () => {
  it('should render a small QR code without throwing', () => {
    const testUrl = 'handy://test'
    expect(() => displayQRCode(testUrl)).not.toThrow()
  })
}) 