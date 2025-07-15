import qrcode from 'qrcode-terminal';
import { logger } from './logger';

/**
 * Display a QR code in the terminal for the given URL
 */
export function displayQRCode(url: string): void {
  logger.info('='.repeat(50));
    logger.info('📱 To authenticate, scan this QR code with your mobile device:');
    logger.info('='.repeat(50));
    qrcode.generate(url, { small: true }, (qr) => {
      for (let l of qr.split('\n')) {
        logger.info('         ' + l);
      }
    });

    logger.info(`📋 Or use this URL: ${url}`);
} 