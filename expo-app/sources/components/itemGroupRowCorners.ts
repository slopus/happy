import type { ItemGroupRowPosition } from './ItemGroupRowPosition';

export function getItemGroupRowCornerRadii(params: Readonly<{
    hasBackground: boolean;
    position: ItemGroupRowPosition | null;
    radius: number;
}>) {
    if (!params.hasBackground) return {};
    if (!params.position) return {};

    return {
        ...(params.position.isFirst
            ? { borderTopLeftRadius: params.radius, borderTopRightRadius: params.radius }
            : null),
        ...(params.position.isLast
            ? { borderBottomLeftRadius: params.radius, borderBottomRightRadius: params.radius }
            : null),
    };
}

