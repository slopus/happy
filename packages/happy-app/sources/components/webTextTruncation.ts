const WEB_TEXT_TRUNCATION_TOLERANCE = 1;

export function isWebTextTruncated({
    clientHeight,
    scrollHeight,
    clientWidth,
    scrollWidth,
    tolerance = WEB_TEXT_TRUNCATION_TOLERANCE,
}: {
    clientHeight?: number;
    scrollHeight?: number;
    clientWidth?: number;
    scrollWidth?: number;
    tolerance?: number;
}): boolean {
    const hasHeightMeasurement = typeof clientHeight === 'number' && typeof scrollHeight === 'number';
    const hasWidthMeasurement = typeof clientWidth === 'number' && typeof scrollWidth === 'number';

    const heightTruncated = hasHeightMeasurement
        ? scrollHeight > clientHeight + tolerance
        : false;
    const widthTruncated = hasWidthMeasurement
        ? scrollWidth > clientWidth + tolerance
        : false;

    return heightTruncated || widthTruncated;
}
