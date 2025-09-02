import React from 'react';
import { useRouter } from 'expo-router';
import { OAuthView } from '@/components/OAuthView';
import { buildAuthorizationUrl, ClaudeAuthTokens, exchangeCodeForTokens } from '@/utils/oauth';
import { Modal } from '@/modal';
import { t } from '@/text';
import { StatusBar } from 'expo-status-bar';

export default function ClaudeOAuth() {
    const router = useRouter();

    const handleSuccess = (_tokens: ClaudeAuthTokens) => {
        // TODO: Store tokens securely
        // For now, we'll just show success and navigate back
        Modal.alert(
            t('common.success'),
            t('settings.claudeAuthSuccess'),
            [
                {
                    text: t('common.ok'),
                    onPress: () => router.back(),
                }
            ]
        );
    };

    return (
        <>
            <StatusBar style="light" />
            <OAuthView
                name="Claude"
                command="happy connect claude"
                backgroundColor={'#1F1E1C'}
                foregroundColor={'#FFFFFF'}
                config={{
                    authUrl: (pkce, state, _redirectUri) =>
                        buildAuthorizationUrl(pkce.challenge, state),
                    tokenExchange: exchangeCodeForTokens,
                    onSuccess: handleSuccess,
                }}
            />
        </>
    );
}