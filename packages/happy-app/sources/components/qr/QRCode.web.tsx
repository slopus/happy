import React from 'react';
import { View } from 'react-native';
import { createQRMatrix } from './qrMatrix';

// Check if point is in a locator pattern area
function isInLocatorPattern(x: number, y: number, matrixSize: number): boolean {
    // Top-left pattern
    if (x < 7 && y < 7) return true;
    // Top-right pattern  
    if (x >= matrixSize - 7 && y < 7) return true;
    // Bottom-left pattern
    if (x < 7 && y >= matrixSize - 7) return true;
    return false;
}

// Generate SVG path string for rectangle with selective rounded corners
function getRectPath(x: number, y: number, w: number, h: number,
    tlr: number, trr: number, brr: number, blr: number): string {
    return `M ${x} ${y + tlr}
            A ${tlr} ${tlr} 0 0 1 ${x + tlr} ${y}
            L ${x + w - trr} ${y}
            A ${trr} ${trr} 0 0 1 ${x + w} ${y + trr}
            L ${x + w} ${y + h - brr}
            A ${brr} ${brr} 0 0 1 ${x + w - brr} ${y + h}
            L ${x + blr} ${y + h}
            A ${blr} ${blr} 0 0 1 ${x} ${y + h - blr}
            Z`;
}

interface QRCodeProps {
    data: string;
    size?: number;
    errorCorrectionLevel?: 'low' | 'medium' | 'quartile' | 'high';
    foregroundColor?: string;
    backgroundColor?: string;
}

export const QRCode = React.memo((props: QRCodeProps) => {
    const {
        data,
        size = 200,
        errorCorrectionLevel = 'medium',
        foregroundColor = '#000000',
        backgroundColor = '#FFFFFF'
    } = props;

    // Generate QR matrix
    const qrMatrix = React.useMemo(() => {
        return createQRMatrix(data, errorCorrectionLevel);
    }, [data, errorCorrectionLevel]);

    // Calculate module size
    const moduleSize = size / (qrMatrix.size + 4/* space around */);

    // Generate modules with rounded corners
    const modules = React.useMemo(() => {
        const elements: React.ReactElement[] = [];

        for (let y = 0; y < qrMatrix.size; y++) {
            for (let x = 0; x < qrMatrix.size; x++) {
                // Skip locator pattern areas
                if (isInLocatorPattern(x, y, qrMatrix.size)) continue;

                const neighbors = qrMatrix.getNeighbors(x, y);

                if (neighbors.current) {
                    let tlr = 0, trr = 0, brr = 0, blr = 0;
                    const cornerRadius = Math.min(moduleSize / 3, size * 0.01);

                    // Calculate rounded corners (using corrected logic from mobile)
                    if (!neighbors.top && !neighbors.left) tlr = cornerRadius;    // top-left
                    if (!neighbors.top && !neighbors.right) blr = cornerRadius;   // bottom-left
                    if (!neighbors.bottom && !neighbors.left) trr = cornerRadius; // top-right
                    if (!neighbors.bottom && !neighbors.right) brr = cornerRadius; // bottom-right

                    // Use path if any corner is rounded
                    if (tlr || trr || brr || blr) {
                        const pathData = getRectPath(
                            x * moduleSize - 0.5 + 2 * moduleSize,
                            y * moduleSize - 0.5 + 2 * moduleSize,
                            moduleSize + 1,
                            moduleSize + 1,
                            tlr, trr, brr, blr
                        );

                        elements.push(
                            <path
                                key={`${x}-${y}`}
                                d={pathData}
                                fill={foregroundColor}
                            />
                        );
                    } else {
                        // Use simple rect for modules with no rounded corners
                        elements.push(
                            <rect
                                key={`${x}-${y}`}
                                x={x * moduleSize - 0.5 + 2 * moduleSize}
                                y={y * moduleSize - 0.5 + 2 * moduleSize}
                                width={moduleSize + 1}
                                height={moduleSize + 1}
                                fill={foregroundColor}
                            />
                        );
                    }
                }
            }
        }

        return elements;
    }, [qrMatrix, moduleSize, foregroundColor]);

    const baseRadius = 0.5;

    return (
        <View
            style={{
                width: size,
                height: size,
            }}
        >
            <svg
                width={size}
                height={size}
                viewBox={`0 0 ${size} ${size}`}
                style={{ display: 'block', borderRadius: moduleSize }}
            >
                {/* Background */}
                <rect
                    x={0}
                    y={0}
                    width={size}
                    height={size}
                    fill={backgroundColor}
                />

                {/* QR modules with rounded corners */}
                {modules}

                {/* Top-left locator pattern */}
                <rect
                    x={2 * moduleSize}
                    y={2 * moduleSize}
                    width={7 * moduleSize}
                    height={7 * moduleSize}
                    rx={moduleSize * (baseRadius + 1)}
                    ry={moduleSize * (baseRadius + 1)}
                    fill={foregroundColor}
                />
                <rect
                    x={3 * moduleSize}
                    y={3 * moduleSize}
                    width={5 * moduleSize}
                    height={5 * moduleSize}
                    rx={moduleSize * baseRadius}
                    ry={moduleSize * baseRadius}
                    fill={backgroundColor}
                />
                <rect
                    x={4 * moduleSize}
                    y={4 * moduleSize}
                    width={3 * moduleSize}
                    height={3 * moduleSize}
                    rx={moduleSize}
                    ry={moduleSize}
                    fill={foregroundColor}
                />

                {/* Top-right locator pattern */}
                <rect
                    x={(qrMatrix.size - 7 + 2) * moduleSize}
                    y={2 * moduleSize}
                    width={7 * moduleSize}
                    height={7 * moduleSize}
                    rx={moduleSize * (baseRadius + 1)}
                    ry={moduleSize * (baseRadius + 1)}
                    fill={foregroundColor}
                />
                <rect
                    x={(qrMatrix.size - 7 + 1 + 2) * moduleSize}
                    y={3 * moduleSize}
                    width={5 * moduleSize}
                    height={5 * moduleSize}
                    rx={moduleSize * baseRadius}
                    ry={moduleSize * baseRadius}
                    fill={backgroundColor}
                />
                <rect
                    x={(qrMatrix.size - 7 + 2 + 2) * moduleSize}
                    y={4 * moduleSize}
                    width={3 * moduleSize}
                    height={3 * moduleSize}
                    rx={moduleSize}
                    ry={moduleSize}
                    fill={foregroundColor}
                />

                {/* Bottom-left locator pattern */}
                <rect
                    x={2 * moduleSize}
                    y={(qrMatrix.size - 7 + 2) * moduleSize}
                    width={7 * moduleSize}
                    height={7 * moduleSize}
                    rx={moduleSize * (baseRadius + 1)}
                    ry={moduleSize * (baseRadius + 1)}
                    fill={foregroundColor}
                />
                <rect
                    x={3 * moduleSize}
                    y={(qrMatrix.size - 7 + 1 + 2) * moduleSize}
                    width={5 * moduleSize}
                    height={5 * moduleSize}
                    rx={moduleSize * baseRadius}
                    ry={moduleSize * baseRadius}
                    fill={backgroundColor}
                />
                <rect
                    x={4 * moduleSize}
                    y={(qrMatrix.size - 7 + 2 + 2) * moduleSize}
                    width={3 * moduleSize}
                    height={3 * moduleSize}
                    rx={moduleSize}
                    ry={moduleSize}
                    fill={foregroundColor}
                />
            </svg>
        </View>
    );
});