/**
 * Tests for the QR code utility
 * 
 * These tests verify the QR code generation functionality works correctly
 * and handles edge cases gracefully.
 */

import { expect } from 'chai'

import { displayQRCode } from './qrcode.js'

describe('QR Code Utility', () => {
  describe('displayQRCode', () => {
    it('should not throw an error for valid handy:// URLs', () => {
      const testUrl = 'handy://dGVzdC1zZWNyZXQtaXMtMzItYnl0ZXMtbG9uZw'
      
      expect(() => displayQRCode(testUrl)).to.not.throw()
    })
    
    it('should not throw an error for other valid URLs', () => {
      const testUrls = [
        'https://example.com',
        'http://localhost:3000',
        'handy://abc123',
        'custom://protocol'
      ]
      
      for (const url of testUrls) {
        expect(() => displayQRCode(url)).to.not.throw()
      }
    })
    
    it('should handle empty strings gracefully', () => {
      expect(() => displayQRCode('')).to.not.throw()
    })
    
    it('should handle very long URLs gracefully', () => {
      const longUrl = 'handy://' + 'a'.repeat(1000)
      expect(() => displayQRCode(longUrl)).to.not.throw()
    })
  })
}) 