import qrcode from 'qrcode-terminal';

/**
 * Display a QR code in the terminal for the given URL
 */
export function displayQRCode(url: string): void {
  console.log('📱 To authenticate, scan this QR code with your mobile device:');
  qrcode.generate(url, { small: true }, (qr) => {
    for (let l of qr.split('\n')) {
      console.log(' '.repeat(10) + l);
    }
  });
} 