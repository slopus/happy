import React from 'react';
import { Canvas, Rect, Path, RoundedRect, DiffRect, rrect, rect, Group } from '@shopify/react-native-skia';
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

// Generate path string for rectangle with selective rounded corners
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

                    // Calculate rounded corners based on neighbors
                    if (!neighbors.top && !neighbors.left) tlr = cornerRadius;    // top-left
                    if (!neighbors.top && !neighbors.right) blr = cornerRadius;   // bottom-left (when no top and no right)
                    if (!neighbors.bottom && !neighbors.left) trr = cornerRadius; // top-right (when no bottom and no left)
                    if (!neighbors.bottom && !neighbors.right) brr = cornerRadius; // bottom-right

                    // Use Path if any corner is rounded
                    if (tlr || trr || brr || blr) {
                        const path = getRectPath(
                            x * moduleSize - 0.5,
                            y * moduleSize - 0.5,
                            moduleSize + 1,  // Slight overlap to avoid gaps
                            moduleSize + 1,
                            tlr, trr, brr, blr
                        );

                        elements.push(
                            <Path
                                key={`${x}-${y}`}
                                path={path}
                                color={foregroundColor}
                            />
                        );
                    } else {
                        // Use simple Rect for modules with no rounded corners
                        elements.push(
                            <Rect
                                key={`${x}-${y}`}
                                x={x * moduleSize - 0.5}
                                y={y * moduleSize - 0.5}
                                width={moduleSize + 1}
                                height={moduleSize + 1}
                                color={foregroundColor}
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
        <Canvas style={{ width: size, height: size }}>
            {/* Background */}
            <RoundedRect
                x={0}
                y={0}
                width={size}
                height={size}
                color={backgroundColor}
                r={moduleSize * baseRadius * 3}
            />

            <Group transform={[{ translateX: moduleSize * 2 }, { translateY: moduleSize * 2 }]}>
                {/* QR modules with rounded corners */}
                {modules}

                {/* Top-left locator pattern */}
                <DiffRect
                    inner={rrect(rect(moduleSize, moduleSize, 5 * moduleSize, 5 * moduleSize), moduleSize * baseRadius, moduleSize * baseRadius)}
                    outer={rrect(rect(0, 0, 7 * moduleSize, 7 * moduleSize), moduleSize * (baseRadius + 1), moduleSize * (baseRadius + 1))}
                    color={foregroundColor}
                />
                <RoundedRect
                    x={2 * moduleSize}
                    y={2 * moduleSize}
                    width={3 * moduleSize}
                    height={3 * moduleSize}
                    r={moduleSize}
                    color={foregroundColor}
                />

                {/* Top-right locator pattern */}
                <DiffRect
                    inner={rrect(rect((qrMatrix.size - 7 + 1) * moduleSize, moduleSize, 5 * moduleSize, 5 * moduleSize), moduleSize * baseRadius, moduleSize * baseRadius)}
                    outer={rrect(rect((qrMatrix.size - 7) * moduleSize, 0, 7 * moduleSize, 7 * moduleSize), moduleSize * (baseRadius + 1), moduleSize * (baseRadius + 1))}
                    color={foregroundColor}
                />
                <RoundedRect
                    x={(qrMatrix.size - 7 + 2) * moduleSize}
                    y={2 * moduleSize}
                    width={3 * moduleSize}
                    height={3 * moduleSize}
                    r={moduleSize}
                    color={foregroundColor}
                />

                {/* Bottom-left locator pattern */}
                <DiffRect
                    inner={rrect(rect(moduleSize, (qrMatrix.size - 7 + 1) * moduleSize, 5 * moduleSize, 5 * moduleSize), moduleSize * baseRadius, moduleSize * baseRadius)}
                    outer={rrect(rect(0, (qrMatrix.size - 7) * moduleSize, 7 * moduleSize, 7 * moduleSize), moduleSize * (baseRadius + 1), moduleSize * (baseRadius + 1))}
                    color={foregroundColor}
                />
                <RoundedRect
                    x={2 * moduleSize}
                    y={(qrMatrix.size - 7 + 2) * moduleSize}
                    width={3 * moduleSize}
                    height={3 * moduleSize}
                    r={moduleSize}
                    color={foregroundColor}
                />
            </Group>
        </Canvas>
    );
});