import * as React from "react";
import Svg, { Rect, Mask, G } from "react-native-svg";

const ELEMENTS = 64;
const SIZE = 80;

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

export function Avatar(props: AvatarProps) {
    const { id, title, square, size = 48, monochrome } = props;
    const defaultColors = monochrome ? ['#070707', '#242424', '#575757', '#979797', '#bbbbbb'] : ['#0a0310', '#49007e', '#ff005b', '#ff7d10', '#ffb238'];
    const pixelColors = React.useMemo(() => generateColors(id, defaultColors), [id, defaultColors]);
    const maskId = React.useId();

    return (
        <Svg
            viewBox={`0 0 ${SIZE} ${SIZE}`}
            fill="none"
            width={size}
            height={size}
        >
            {title && <title>{id}</title>}
            <Mask
                id={maskId}
                maskType="alpha"
                maskUnits="userSpaceOnUse"
                x={0}
                y={0}
                width={SIZE}
                height={SIZE}
            >
                <Rect width={SIZE} height={SIZE} rx={square ? undefined : SIZE * 2} fill="#FFFFFF" />
            </Mask>
            <G mask={`url(#${maskId})`}>
                <Rect width={10} height={10} fill={pixelColors[0]} />
                <Rect x={20} width={10} height={10} fill={pixelColors[1]} />
                <Rect x={40} width={10} height={10} fill={pixelColors[2]} />
                <Rect x={60} width={10} height={10} fill={pixelColors[3]} />
                <Rect x={10} width={10} height={10} fill={pixelColors[4]} />
                <Rect x={30} width={10} height={10} fill={pixelColors[5]} />
                <Rect x={50} width={10} height={10} fill={pixelColors[6]} />
                <Rect x={70} width={10} height={10} fill={pixelColors[7]} />
                <Rect y={10} width={10} height={10} fill={pixelColors[8]} />
                <Rect y={20} width={10} height={10} fill={pixelColors[9]} />
                <Rect y={30} width={10} height={10} fill={pixelColors[10]} />
                <Rect y={40} width={10} height={10} fill={pixelColors[11]} />
                <Rect y={50} width={10} height={10} fill={pixelColors[12]} />
                <Rect y={60} width={10} height={10} fill={pixelColors[13]} />
                <Rect y={70} width={10} height={10} fill={pixelColors[14]} />
                <Rect x={20} y={10} width={10} height={10} fill={pixelColors[15]} />
                <Rect x={20} y={20} width={10} height={10} fill={pixelColors[16]} />
                <Rect x={20} y={30} width={10} height={10} fill={pixelColors[17]} />
                <Rect x={20} y={40} width={10} height={10} fill={pixelColors[18]} />
                <Rect x={20} y={50} width={10} height={10} fill={pixelColors[19]} />
                <Rect x={20} y={60} width={10} height={10} fill={pixelColors[20]} />
                <Rect x={20} y={70} width={10} height={10} fill={pixelColors[21]} />
                <Rect x={40} y={10} width={10} height={10} fill={pixelColors[22]} />
                <Rect x={40} y={20} width={10} height={10} fill={pixelColors[23]} />
                <Rect x={40} y={30} width={10} height={10} fill={pixelColors[24]} />
                <Rect x={40} y={40} width={10} height={10} fill={pixelColors[25]} />
                <Rect x={40} y={50} width={10} height={10} fill={pixelColors[26]} />
                <Rect x={40} y={60} width={10} height={10} fill={pixelColors[27]} />
                <Rect x={40} y={70} width={10} height={10} fill={pixelColors[28]} />
                <Rect x={60} y={10} width={10} height={10} fill={pixelColors[29]} />
                <Rect x={60} y={20} width={10} height={10} fill={pixelColors[30]} />
                <Rect x={60} y={30} width={10} height={10} fill={pixelColors[31]} />
                <Rect x={60} y={40} width={10} height={10} fill={pixelColors[32]} />
                <Rect x={60} y={50} width={10} height={10} fill={pixelColors[33]} />
                <Rect x={60} y={60} width={10} height={10} fill={pixelColors[34]} />
                <Rect x={60} y={70} width={10} height={10} fill={pixelColors[35]} />
                <Rect x={10} y={10} width={10} height={10} fill={pixelColors[36]} />
                <Rect x={10} y={20} width={10} height={10} fill={pixelColors[37]} />
                <Rect x={10} y={30} width={10} height={10} fill={pixelColors[38]} />
                <Rect x={10} y={40} width={10} height={10} fill={pixelColors[39]} />
                <Rect x={10} y={50} width={10} height={10} fill={pixelColors[40]} />
                <Rect x={10} y={60} width={10} height={10} fill={pixelColors[41]} />
                <Rect x={10} y={70} width={10} height={10} fill={pixelColors[42]} />
                <Rect x={30} y={10} width={10} height={10} fill={pixelColors[43]} />
                <Rect x={30} y={20} width={10} height={10} fill={pixelColors[44]} />
                <Rect x={30} y={30} width={10} height={10} fill={pixelColors[45]} />
                <Rect x={30} y={40} width={10} height={10} fill={pixelColors[46]} />
                <Rect x={30} y={50} width={10} height={10} fill={pixelColors[47]} />
                <Rect x={30} y={60} width={10} height={10} fill={pixelColors[48]} />
                <Rect x={30} y={70} width={10} height={10} fill={pixelColors[49]} />
                <Rect x={50} y={10} width={10} height={10} fill={pixelColors[50]} />
                <Rect x={50} y={20} width={10} height={10} fill={pixelColors[51]} />
                <Rect x={50} y={30} width={10} height={10} fill={pixelColors[52]} />
                <Rect x={50} y={40} width={10} height={10} fill={pixelColors[53]} />
                <Rect x={50} y={50} width={10} height={10} fill={pixelColors[54]} />
                <Rect x={50} y={60} width={10} height={10} fill={pixelColors[55]} />
                <Rect x={50} y={70} width={10} height={10} fill={pixelColors[56]} />
                <Rect x={70} y={10} width={10} height={10} fill={pixelColors[57]} />
                <Rect x={70} y={20} width={10} height={10} fill={pixelColors[58]} />
                <Rect x={70} y={30} width={10} height={10} fill={pixelColors[59]} />
                <Rect x={70} y={40} width={10} height={10} fill={pixelColors[60]} />
                <Rect x={70} y={50} width={10} height={10} fill={pixelColors[61]} />
                <Rect x={70} y={60} width={10} height={10} fill={pixelColors[62]} />
                <Rect x={70} y={70} width={10} height={10} fill={pixelColors[63]} />
            </G>
        </Svg>
    );
}