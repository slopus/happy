import * as React from "react";
import { View } from "react-native";

const ELEMENTS = 64;
const GRID_SIZE = 8; // 8x8 grid

function hashCode(str: string): number {
    let hash = 0;
    for (let i = 0; i < str.length; i++) {
        const char = str.charCodeAt(i);
        hash = ((hash << 5) - hash) + char;
        hash = hash & hash;
    }
    return Math.abs(hash);
}

function getRandomColor(number: number, colors?: string[], range?: number): string {
    if (colors && range) {
        return colors[number % range];
    }

    const hue = (number * 137.508) % 360;
    return `hsl(${hue}, 45%, 65%)`;
}

function hslToGrayscale(hslColor: string): string {
    const match = hslColor.match(/hsl\((\d+),\s*(\d+)%,\s*(\d+)%\)/);
    if (!match) return hslColor;

    const [, , , lightness] = match;
    return `hsl(0, 0%, ${lightness}%)`;
}

function generateColors(name: string, colors?: string[], monochrome?: boolean): string[] {
    const numFromName = hashCode(name);
    const range = colors?.length;

    const colorList = Array.from({ length: ELEMENTS }, (_, i) => {
        const color = getRandomColor(numFromName % (i + 1), colors, range);
        return monochrome ? hslToGrayscale(color) : color;
    });

    return colorList;
}

interface AvatarProps {
    id: string;
    title?: boolean;
    square?: boolean;
    size?: number;
    monochrome?: boolean;
}

const colors = ['#0a0310', '#49007e', '#ff005b', '#ff7d10', '#ffb238'];
const grayscaleColors = ['#070707', '#242424', '#575757', '#979797', '#bbbbbb'];

export const Avatar = React.memo((props: AvatarProps) => {
    const { id, square, size = 48, monochrome } = props;
    const defaultColors = monochrome ? grayscaleColors : colors;
    const pixelColors = React.useMemo(() => generateColors(id, defaultColors, monochrome), [id, defaultColors]);
    
    // Calculate cell size based on the avatar size
    const cellSize = size / GRID_SIZE;
    
    // Generate rect positions
    const rects = React.useMemo(() => {
        const positions: Array<{ x: number; y: number; colorIndex: number }> = [];
        let colorIndex = 0;
        
        for (let row = 0; row < GRID_SIZE; row++) {
            for (let col = 0; col < GRID_SIZE; col++) {
                positions.push({ 
                    x: col * cellSize, 
                    y: row * cellSize, 
                    colorIndex: colorIndex++ 
                });
            }
        }
        
        return positions;
    }, [cellSize]);

    return (
        <View
            style={{
                width: size,
                height: size,
                overflow: 'hidden',
                borderRadius: square ? 0 : size / 2,
            }}
        >
            <svg
                width={size}
                height={size}
                viewBox={`0 0 ${size} ${size}`}
                style={{ display: 'block' }}
            >
                <g clipPath={square ? undefined : `url(#avatar-clip-${id})`}>
                    {rects.map((rect, index) => (
                        <rect
                            key={index}
                            x={rect.x}
                            y={rect.y}
                            width={cellSize}
                            height={cellSize}
                            fill={pixelColors[rect.colorIndex]}
                        />
                    ))}
                </g>
            </svg>
        </View>
    );
});