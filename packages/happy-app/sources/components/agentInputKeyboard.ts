import type { SupportedKey } from './MultiTextInput';

interface ShouldSendOnEnterParams {
    key: SupportedKey;
    shiftKey: boolean;
    enterToSendEnabled: boolean;
    textSnapshot: string;
    isSending?: boolean;
    isSendDisabled?: boolean;
}

export function shouldSendOnEnter(params: ShouldSendOnEnterParams): boolean {
    if (!params.enterToSendEnabled) return false;
    if (params.key !== 'Enter' || params.shiftKey) return false;
    if (params.isSending || params.isSendDisabled) return false;
    return params.textSnapshot.trim().length > 0;
}
