import { Platform } from 'react-native';

export function resolveComposerSubmitBehavior(
    agentInputEnterToSend: boolean,
    platformOS: typeof Platform.OS = Platform.OS,
): 'submit' | 'newline' {
    return agentInputEnterToSend && platformOS !== 'web' ? 'submit' : 'newline';
}

export function resolveComposerReturnKeyType(
    agentInputEnterToSend: boolean,
    platformOS: typeof Platform.OS = Platform.OS,
): 'send' | 'default' {
    return resolveComposerSubmitBehavior(agentInputEnterToSend, platformOS) === 'submit' ? 'send' : 'default';
}
