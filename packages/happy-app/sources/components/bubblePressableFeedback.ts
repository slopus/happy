export type BubblePressablePlatform = 'native' | 'web';

export function resolveBubblePressableFeedback({
    platform,
    scaleFeedback = true,
}: {
    platform: BubblePressablePlatform;
    scaleFeedback?: boolean;
}): { animateScale: boolean } {
    return { animateScale: platform !== 'web' && scaleFeedback };
}
