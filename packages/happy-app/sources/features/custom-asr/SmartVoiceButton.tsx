import * as React from 'react';
import { Platform, Pressable, View, ActivityIndicator } from 'react-native';
import { Image } from 'expo-image';
import { Octicons } from '@expo/vector-icons';
import { useUnistyles } from 'react-native-unistyles';
import { hapticsLight } from '@/components/haptics';
import { CustomASRButton } from './CustomASRButton';
import { useVoiceInputController } from '@/features/voice-input';

interface SmartVoiceButtonProps {
    hasText: boolean;
    isSending?: boolean;
    isSendDisabled?: boolean;
    onSend: () => void;
    onMicPress?: () => void;
    isMicActive?: boolean;
    styles: any;
    sessionId?: string;
    onTextUpdate?: (text: string) => void;
    forceMode?: 'elevenlabs_call' | 'streaming_asr';
}

export const SmartVoiceButton = React.memo((props: SmartVoiceButtonProps) => {
    const { theme } = useUnistyles();
    const { buttonDecision, legacyVoice, customAsrProps } = useVoiceInputController({
        hasText: props.hasText,
        isSending: props.isSending,
        isSendDisabled: props.isSendDisabled,
        onSend: props.onSend,
        onMicPress: props.onMicPress,
        isMicActive: props.isMicActive,
        sessionId: props.sessionId,
        onTextUpdate: props.onTextUpdate,
        forceMode: props.forceMode
    });
    
    if (buttonDecision.showStreamingAsrButton) {
        return (
            <CustomASRButton 
                styles={props.styles} 
                onTextUpdate={customAsrProps.onTextUpdate}
                sessionId={customAsrProps.sessionId}
                hasText={customAsrProps.hasText}
                isSending={customAsrProps.isSending}
                isSendDisabled={customAsrProps.isSendDisabled}
                onSend={customAsrProps.onSend}
            />
        );
    }

    return (
        <View
            style={[
                props.styles.sendButton,
                (buttonDecision.showSendButton || buttonDecision.showLegacyMicButton)
                    ? props.styles.sendButtonActive
                    : props.styles.sendButtonInactive
            ]}
        >
            <Pressable
                style={(p) => ({
                    width: '100%',
                    height: '100%',
                    alignItems: 'center',
                    justifyContent: 'center',
                    opacity: p.pressed ? 0.7 : 1,
                })}
                hitSlop={{ top: 5, bottom: 10, left: 0, right: 0 }}
                onPress={() => {
                    hapticsLight();
                    legacyVoice.onPress();
                }}
                disabled={legacyVoice.disabled}
            >
                {legacyVoice.iconType === 'sending' ? (
                    <ActivityIndicator
                        size="small"
                        color={theme.colors.button.primary.tint}
                    />
                ) : legacyVoice.iconType === 'send' ? (
                    <Octicons
                        name="arrow-up"
                        size={16}
                        color={theme.colors.button.primary.tint}
                        style={[
                            props.styles.sendButtonIcon,
                            { marginTop: Platform.OS === 'web' ? 2 : 0 }
                        ]}
                    />
                ) : (
                    <Image
                        source={require('@/assets/images/icon-voice-white.png')}
                        style={{
                            width: 24,
                            height: 24,
                        }}
                        tintColor={theme.colors.button.primary.tint}
                    />
                )}
            </Pressable>
        </View>
    );
});
