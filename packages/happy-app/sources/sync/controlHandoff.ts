export type ControlMode = 'desktop' | 'mobile';
export type ControlHandoffDirection = 'desktop-to-mobile' | 'mobile-to-desktop';

export function resolveControlMode(controlledByUser: boolean | null | undefined): ControlMode {
    return controlledByUser === true ? 'mobile' : 'desktop';
}

export function resolveControlHandoffDirection(
    previousControlledByUser: boolean | null | undefined,
    nextControlledByUser: boolean | null | undefined,
): ControlHandoffDirection | null {
    if (nextControlledByUser === true && previousControlledByUser !== true) {
        return 'desktop-to-mobile';
    }
    if (previousControlledByUser === true && nextControlledByUser === false) {
        return 'mobile-to-desktop';
    }
    return null;
}
