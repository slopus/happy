export function didControlReturnToMobile(
    wasControlledByUser: boolean | null | undefined,
    isNowControlledByUser: boolean | null | undefined
): boolean {
    return wasControlledByUser === true && isNowControlledByUser !== true;
}

