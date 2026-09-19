import { rememberPartyReturn } from '@/components/agentParty/loginReturn';
import * as React from 'react';
import { View, Text, Pressable, Platform, Linking } from 'react-native';
import { useRouter } from 'expo-router';
import { useUnistyles } from 'react-native-unistyles';
import { useAuth } from '@/auth/AuthContext';
import { issuePartyTicket, PARTY_URL } from '@/components/agentParty/api';

export default function AgentPartyAccess() {
    const { credentials } = useAuth();
    const router = useRouter();
    const { theme } = useUnistyles();
    const [busy, setBusy] = React.useState(false);
    const [error, setError] = React.useState('');
    const controller = React.useRef<AbortController | null>(null);
    React.useEffect(() => () => controller.current?.abort(), [credentials]);
    const open = async () => {
        if (!credentials || busy) return;
        const request = new AbortController(); controller.current = request;
        setBusy(true); setError('');
        try {
            const ticket = await issuePartyTicket(credentials, request.signal);
            const url = `${PARTY_URL}#ticket=${ticket}`;
            if (Platform.OS === 'web') window.location.replace(url);
            else await Linking.openURL(url);
        } catch (error) { if (!request.signal.aborted) setError((error as Error).message); }
        finally { if (!request.signal.aborted) setBusy(false); }
    };
    return <View style={{ flex: 1, backgroundColor: theme.colors.surface, padding: 24, gap: 24, justifyContent: 'center' }}>
        <Text style={{ color: theme.colors.text, fontSize: 24 }}>连接你的 Agent 群聊</Text>
        <Text style={{ color: theme.colors.text }}>使用当前 Paws 账号登录独立群聊网站，读取你在 Paws 配置的 Agent，并连接所选设备运行会话。</Text>
        {error ? <Text accessibilityRole="alert" style={{ color: theme.colors.text }}>{error}</Text> : null}
        <Pressable accessibilityRole="button" disabled={busy} onPress={credentials ? open : () => { rememberPartyReturn('/agent-party-access'); router.push('/'); }} style={({ pressed }) => ({ padding: 16, borderRadius: 12, backgroundColor: pressed ? theme.colors.surfacePressed : theme.colors.surfaceSelected })}><Text style={{ color: theme.colors.text }}>{busy ? '正在连接…' : credentials ? '使用当前账号继续' : '登录或创建 Paws 账号'}</Text></Pressable>
        <Pressable accessibilityRole="button" onPress={() => router.push('/agent-profiles')}><Text style={{ color: theme.colors.textLink }}>管理我的 Agent</Text></Pressable>
    </View>;
}
