import qrlib from 'qrcode';

const QR_BORDER = 7;

export class QRMatrix {
    readonly bits: number[];
    readonly size: number;

    constructor(bits: number[]) {
        this.bits = bits;
        this.size = Math.sqrt(bits.length);
    }

    getPixel(x: number, y: number) {
        if (x < QR_BORDER && y < QR_BORDER) {
            return false;
        }
        if (x >= this.size - QR_BORDER && y < QR_BORDER) {
            return false;
        }
        if (x < QR_BORDER && y >= this.size - QR_BORDER) {
            return false;
        }

        // Out of bounds
        if (x >= this.size || y >= this.size || x < 0 || y < 0) {
            return false;
        }

        // Read pixel
        return !!this.bits[y * this.size + x];
    }

    getNeighbors(x: number, y: number) {
        return {
            top: this.getPixel(x - 1, y),
            right: this.getPixel(x, y + 1),
            bottom: this.getPixel(x + 1, y),
            left: this.getPixel(x, y - 1),
            current: this.getPixel(x, y)
        };
    }
}

export function createQRMatrix(data: string, errorCorrectionLevel: 'low' | 'medium' | 'quartile' | 'high') {
    let bits = qrlib.create(data, { errorCorrectionLevel }).modules.data;
    return new QRMatrix(Array.from(bits));
}