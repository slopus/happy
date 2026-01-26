import type { PopoverPlacement, ResolvedPopoverPlacement } from './_types';

export function resolvePlacement(params: {
    placement: PopoverPlacement;
    available: Record<ResolvedPopoverPlacement, number>;
}): ResolvedPopoverPlacement {
    if (params.placement !== 'auto') return params.placement;
    const entries = Object.entries(params.available) as Array<[ResolvedPopoverPlacement, number]>;
    entries.sort((a, b) => b[1] - a[1]);
    return entries[0]?.[0] ?? 'top';
}

