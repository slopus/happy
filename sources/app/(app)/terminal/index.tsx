import React from 'react';
import { View } from 'react-native';
import { Text } from '@/components/StyledText';
import { useRouter, useLocalSearchParams } from 'expo-router';
import { Typography } from '@/constants/Typography';
import { RoundButton } from '@/components/RoundButton';
import { useConnectTerminal } from '@/hooks/useConnectTerminal';
import { Ionicons } from '@expo/vector-icons';
import { ItemList } from '@/components/ItemList';
import { ItemGroup } from '@/components/ItemGroup';
import { Item } from '@/components/Item';
import { useUnistyles } from 'react-native-unistyles';

export default function TerminalScreen() {
    const router = useRouter();
    const searchParams = useLocalSearchParams();
    const { theme } = useUnistyles();

    // const [urlProcessed, setUrlProcessed] = useState(false);
    const publicKey = React.useMemo(() => {
        const keys = Object.keys(searchParams);
        if (keys.length > 0) {
            // If we have any search params, the first one should be our key
            const key = keys[0];
            return key;
        } else {
            return null;
        }
    }, [searchParams])
    const { processAuthUrl, isLoading } = useConnectTerminal({
        onSuccess: () => {
            router.back();
        }
    });

    const handleConnect = async () => {
        if (publicKey) {
            // Use the full happy:// URL format expected by the hook
            const authUrl = `happy://terminal?${publicKey}`;
            await processAuthUrl(authUrl);
        }
    };

    const handleReject = () => {
        router.back();
    };

    // Show error if no key found
    if (!publicKey) {
        return (
            <>
                <ItemList>
                    <ItemGroup>
                        <View style={{
                            alignItems: 'center',
                            paddingVertical: 32,
                            paddingHorizontal: 16
                        }}>
                            <Ionicons
                                name="warning-outline"
                                size={48}
                                color={theme.colors.textDestructive}
                                style={{ marginBottom: 16 }}
                            />
                            <Text style={{
                                ...Typography.default('semiBold'),
                                fontSize: 16,
                                color: theme.colors.textDestructive,
                                textAlign: 'center',
                                marginBottom: 8
                            }}>
                                Invalid Connection Link
                            </Text>
                            <Text style={{
                                ...Typography.default(),
                                fontSize: 14,
                                color: theme.colors.textSecondary,
                                textAlign: 'center',
                                lineHeight: 20
                            }}>
                                The connection link is missing or invalid. Please check the URL and try again.
                            </Text>
                        </View>
                    </ItemGroup>
                </ItemList>
            </>
        );
    }

    // Show confirmation screen for valid connection
    return (
        <>
            <ItemList>
                {/* Connection Request Header */}
                <ItemGroup>
                    <View style={{
                        alignItems: 'center',
                        paddingVertical: 24,
                        paddingHorizontal: 16
                    }}>
                        <Ionicons
                            name="terminal-outline"
                            size={48}
                            color={theme.colors.radio.active}
                            style={{ marginBottom: 16 }}
                        />
                        <Text style={{
                            ...Typography.default('semiBold'),
                            fontSize: 20,
                            textAlign: 'center',
                            marginBottom: 12,
                            color: theme.colors.text
                        }}>
                            Connect Terminal
                        </Text>
                        <Text style={{
                            ...Typography.default(),
                            fontSize: 14,
                            color: theme.colors.textSecondary,
                            textAlign: 'center',
                            lineHeight: 20
                        }}>
                            A terminal is requesting to connect to your Happy Coder account. This will allow the terminal to send and receive messages securely.
                        </Text>
                    </View>
                </ItemGroup>

                {/* Connection Details */}
                <ItemGroup title="Connection Details">
                    <Item
                        title="Public Key"
                        detail={`${publicKey.substring(0, 12)}...`}
                        icon={<Ionicons name="key-outline" size={29} color={theme.colors.radio.active} />}
                        showChevron={false}
                    />
                    <Item
                        title="Encryption"
                        detail="End-to-end encrypted"
                        icon={<Ionicons name="lock-closed-outline" size={29} color={theme.colors.success} />}
                        showChevron={false}
                    />
                </ItemGroup>

                {/* Action Buttons */}
                <ItemGroup>
                    <View style={{
                        paddingHorizontal: 16,
                        paddingVertical: 16,
                        gap: 12
                    }}>
                        <RoundButton
                            title={isLoading ? "Connecting..." : "Accept Connection"}
                            onPress={handleConnect}
                            size="large"
                            disabled={isLoading}
                            loading={isLoading}
                        />
                        <RoundButton
                            title="Reject"
                            onPress={handleReject}
                            size="large"
                            display="inverted"
                            disabled={isLoading}
                        />
                    </View>
                </ItemGroup>

                {/* Security Notice */}
                <ItemGroup
                    title="Security"
                    footer="This connection was processed securely on your device and was never sent to any server. Your private data will remain secure and only you can decrypt the messages."
                >
                    <Item
                        title="Client-Side Processing"
                        subtitle="Link processed locally on device"
                        icon={<Ionicons name="shield-checkmark-outline" size={29} color={theme.colors.success} />}
                        showChevron={false}
                    />
                </ItemGroup>
            </ItemList>
        </>
    );
}