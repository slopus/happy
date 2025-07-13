import qrcode from 'qrcode-terminal';
import { logger } from './logger';

/**
 * Display a QR code in the terminal for the given URL
 */
export function displayQRCode(url: string): void {
  try {
    logger.info('='.repeat(50));
    logger.info('📱 Scan this QR code with your mobile device:');
    logger.info('='.repeat(50));
    qrcode.generate(url, { small: true }, (qr) => {
      for (let l of qr.split('\n')) {
        logger.info('         ' + l);
      }
    });
    logger.info('='.repeat(50));
  } catch (error) {
    logger.error('Failed to generate QR code:', error);
    logger.info(`📋 Use this URL to connect: ${url}`);
  }
} 