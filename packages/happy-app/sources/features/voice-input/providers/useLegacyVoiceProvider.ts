import { useMemo } from 'react';

interface UseLegacyVoiceProviderProps {
    hasText: boolean;
    isSending?: boolean;
    isSendDisabled?: boolean;
    hasMicAction: boolean;
    isMicActive?: boolean;
    onSend: () => void;
    onMicPress?: () => void;
}

export function useLegacyVoiceProvider(props: UseLegacyVoiceProviderProps) {
    const disabled = useMemo(() => {
        return !!props.isSendDisabled || !!props.isSending || (!props.hasText && !props.hasMicAction);
    }, [props.hasMicAction, props.hasText, props.isSendDisabled, props.isSending]);

    const onPress = useMemo(() => {
        return () => {
            if (props.hasText) {
                props.onSend();
                return;
            }
            if (props.onMicPress) {
                props.onMicPress();
            }
        };
    }, [props.hasText, props.onMicPress, props.onSend]);

    const iconType = useMemo<'sending' | 'send' | 'mic'>(() => {
        if (props.isSending) {
            return 'sending';
        }
        if (props.hasText || props.isMicActive) {
            return 'send';
        }
        return 'mic';
    }, [props.hasText, props.isMicActive, props.isSending]);

    return {
        disabled,
        onPress,
        iconType
    };
}
