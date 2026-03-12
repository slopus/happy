export type EmptyMainScreenMode = 'connect-device' | 'start-session';

export function getEmptyMainScreenMode(hasOnlineMachines: boolean): EmptyMainScreenMode {
    return hasOnlineMachines ? 'start-session' : 'connect-device';
}
