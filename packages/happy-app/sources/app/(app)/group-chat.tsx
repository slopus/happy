import * as React from 'react';
import { View, Text, Pressable, ActivityIndicator } from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useUnistyles } from 'react-native-unistyles';
import { useAuth } from '@/auth/AuthContext';
import { accountRuntimeCurrent, canonicalAccountServer } from '@/auth/accountRuntime';
import { getServerUrl } from '@/sync/serverConfig';
import { PartySurface } from '@/components/agentParty/PartySurface';
import { AGENT_PARTY_ORIGIN, AGENT_PARTY_RELAY, AGENT_PARTY_URL, parsePartySessionMessage, partyFrameUrl } from '@/components/agentParty/bridge';

export default function GroupChatScreen() {
    const auth = useAuth();
    const router = useRouter();
    const { view } = useLocalSearchParams<{ view?: string }>();
    const { theme } = useUnistyles();
    const [url, setUrl] = React.useState('');
    const [error, setError] = React.useState('');
    const [attempt, setAttempt] = React.useState(0);
    const identity = React.useRef<{ accountId: string; serverUrl: string } | null>(null);
    React.useEffect(() => {
        setUrl(''); setError(''); identity.current = null;
        const credentials = auth.credentials;
        if (!credentials) return;
        const serverUrl = getServerUrl();
        if (canonicalAccountServer(serverUrl) !== canonicalAccountServer(AGENT_PARTY_RELAY)) {
            setError('当前群聊服务仅连接 Paws 正式服务器，请先切换到该服务器的账号。'); return;
        }
        const controller = new AbortController();
        void fetch(`${AGENT_PARTY_URL}api/access/ticket`, {
            method: 'POST', signal: controller.signal,
            headers: { authorization: `Bearer ${credentials.token}`, 'content-type': 'application/json', Origin: AGENT_PARTY_ORIGIN },
            body: JSON.stringify({ secret: credentials.secret }),
        }).then(async response => {
            const result = await response.json();
            if (!response.ok) throw new Error(result.error || '暂时无法连接群聊');
            if (controller.signal.aborted || !accountRuntimeCurrent()) return;
            identity.current = { accountId: result.account.id, serverUrl };
            setUrl(partyFrameUrl(result.ticket, view === 'agents'));
        }).catch(error => { if (!controller.signal.aborted) setError(error.message); });
        return () => { controller.abort(); identity.current = null; };
    }, [auth.credentials, attempt, view]);
    const receive = React.useCallback((message: unknown) => {
        if (!accountRuntimeCurrent() || !identity.current) return;
        if (message && typeof message === 'object' && (message as { type?: unknown }).type === 'agent-party-ready') { setAttempt(value => value + 1); return; }
        const sessionId = parsePartySessionMessage(message, identity.current.accountId, identity.current.serverUrl);
        if (sessionId) router.push(`/session/${sessionId}` as never);
    }, [router]);
    const onError = React.useCallback(() => setError('群聊页面加载失败，请重试。'), []);
    const textStyle = { color: theme.colors.text, fontSize: 16 };
    if (!auth.credentials) return <View style={{ flex: 1, padding: 24, justifyContent: 'center', gap: 20 }}><Text style={textStyle}>登录 Paws，开始你的 Agent 群聊。新用户可以直接创建账号。</Text><Pressable onPress={() => router.replace('/')}><Text style={{ ...textStyle, color: theme.colors.textLink }}>登录或创建账号 →</Text></Pressable></View>;
    return <View style={{ flex: 1, backgroundColor: theme.colors.surface }}>
        {error ? <View style={{ padding: 24, gap: 20 }}><Text style={textStyle}>{error}</Text><Pressable onPress={() => setAttempt(value => value + 1)}><Text style={{ ...textStyle, color: theme.colors.textLink }}>重新连接</Text></Pressable></View>
            : url ? <PartySurface url={url} onMessage={receive} onError={onError}/>
                : <View style={{ flex: 1, justifyContent: 'center', alignItems: 'center', gap: 16 }}><ActivityIndicator color={theme.colors.text}/><Text style={textStyle}>正在连接当前 Paws 账号的群聊空间…</Text></View>}
    </View>;
}
