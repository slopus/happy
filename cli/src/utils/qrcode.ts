/**
 * QR Code utility for handy-cli
 * 
 * This module handles QR code generation and terminal display for the handy:// URL.
 * 
 * Key responsibilities:
 * - Generate QR codes for terminal display
 * - Format QR codes with proper spacing and borders
 * - Handle errors gracefully
 * 
 * Design decisions:
 * - Uses qrcode-terminal for ASCII art QR codes
 * - Displays QR codes with clear instructions
 * - Provides fallback text if QR generation fails
 */

import qrcode from 'qrcode-terminal'

import { logger } from './logger.js'

/**
 * Display a QR code in the terminal for the given URL
 */
export function displayQRCode(url: string): void {
  try {
    logger.info('\n' + '='.repeat(50))
    logger.info('📱 Scan this QR code with your mobile device:')
    logger.info('='.repeat(50))
    
    qrcode.generate(url, { small: true }, (qr) => {
      console.log(qr)
    })
    
    logger.info('='.repeat(50))
    logger.info(`📋 Or copy this URL manually: ${url}`)
    logger.info('='.repeat(50) + '\n')
  } catch (error) {
    logger.error('Failed to generate QR code:', error)
    logger.info(`📋 Use this URL to connect: ${url}`)
  }
} 