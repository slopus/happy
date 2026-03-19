export function resolveCopyMenuLayoutMeasurement({
    animationStarted,
    measuredWidth,
}: {
    animationStarted: boolean;
    measuredWidth: number;
}): {
    nextWidth: number;
    shouldStartAnimation: boolean;
} {
    return {
        nextWidth: measuredWidth,
        shouldStartAnimation: !animationStarted,
    };
}
