/**
 * Tests for the QR code utility
 * 
 * These tests verify the QR code generation functionality works correctly
 * and handles edge cases gracefully.
 */

import { expect } from 'chai'

import { displayQRCode } from './qrcode.js'

describe('QR Code Utility', () => {
  it('should render a small QR code without throwing', () => {
    const testUrl = 'handy://test'
    expect(() => displayQRCode(testUrl)).to.not.throw()
  })
}) 