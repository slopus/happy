/**
 * Phase 1: Inspect the conversation token JWT
 * Phase 3: After a voice session, check what the ElevenLabs conversation API returns
 *
 * Run Phase 1: ELEVENLABS_API_KEY=sk_... npx tsx packages/happy-server/sources/recipes/testConvTokenMatch.ts
 * Run Phase 3: ELEVENLABS_API_KEY=sk_... npx tsx packages/happy-server/sources/recipes/testConvTokenMatch.ts check <conv_id>
 */

const API_KEY = process.env.ELEVENLABS_API_KEY;
if (!API_KEY) {
    console.error('Set ELEVENLABS_API_KEY env var');
    process.exit(1);
}

const AGENT_ID = 'agent_7801k2c0r5hjfraa1kdbytpvs6yt'; // dev agent
const API_BASE = 'https://api.elevenlabs.io/v1/convai';

function decodeJwtPayload(jwt: string): any {
    const payload = jwt.split('.')[1];
    const base64 = payload.replace(/-/g, '+').replace(/_/g, '/');
    return JSON.parse(Buffer.from(base64, 'base64').toString('utf8'));
}

function extractConvId(jwtPayload: any): string | null {
    const room = jwtPayload.video?.room || '';
    return room.match(/(conv_[a-zA-Z0-9]+)/)?.[0] || null;
}

async function phase1() {
    console.log('\n========== PHASE 1: JWT TOKEN INSPECTION ==========\n');

    console.log('--- Without participant_name ---');
    const res1 = await fetch(`${API_BASE}/conversation/token?agent_id=${AGENT_ID}`, {
        headers: { 'xi-api-key': API_KEY! },
    });
    if (!res1.ok) {
        console.error('Token fetch failed:', res1.status, await res1.text());
        return;
    }
    const { token: jwt1 } = await res1.json() as { token: string };
    const payload1 = decodeJwtPayload(jwt1);
    console.log('JWT payload:', JSON.stringify(payload1, null, 2));
    const convId1 = extractConvId(payload1);
    console.log('Extracted conv_id:', convId1);

    console.log('\n--- With participant_name=test_user_123 ---');
    const res2 = await fetch(`${API_BASE}/conversation/token?agent_id=${AGENT_ID}&participant_name=test_user_123`, {
        headers: { 'xi-api-key': API_KEY! },
    });
    if (!res2.ok) {
        console.error('Token fetch (with participant_name) failed:', res2.status, await res2.text());
        return;
    }
    const { token: jwt2 } = await res2.json() as { token: string };
    const payload2 = decodeJwtPayload(jwt2);
    console.log('JWT payload:', JSON.stringify(payload2, null, 2));
    const convId2 = extractConvId(payload2);
    console.log('Extracted conv_id:', convId2);

    if (JSON.stringify(payload2).includes('test_user_123')) {
        console.log('✅ participant_name FOUND in JWT payload');
    } else {
        console.log('❌ participant_name NOT found in JWT payload');
    }
}

async function checkConversation(convId: string) {
    console.log(`\n========== CHECK CONVERSATION: ${convId} ==========\n`);

    const res = await fetch(`${API_BASE}/conversations/${convId}`, {
        headers: { 'xi-api-key': API_KEY! },
    });

    if (!res.ok) {
        console.error('Conversation fetch failed:', res.status, await res.text());
        return;
    }

    const data = await res.json();
    console.log('Full response:', JSON.stringify(data, null, 2));

    // Highlight key fields
    const d = data as any;
    console.log('\n--- Key fields ---');
    console.log('conversation_id:', d.conversation_id);
    console.log('status:', d.status);
    console.log('agent_id:', d.agent_id);
    console.log('call_duration_secs:', d.metadata?.call_duration_secs);
    console.log('participant_name:', d.metadata?.participant_name ?? d.participant_name ?? 'NOT FOUND');
    console.log('user_id:', d.metadata?.user_id ?? d.user_id ?? 'NOT FOUND');

    // Search entire response for participant_name or test_user
    const fullStr = JSON.stringify(data);
    if (fullStr.includes('test_user_123')) {
        console.log('✅ participant_name "test_user_123" found in conversation data');
    }
    if (fullStr.includes('participant')) {
        console.log('Fields containing "participant":',
            Object.keys(flattenObj(data)).filter(k => k.includes('participant')));
    }
}

function flattenObj(obj: any, prefix = ''): Record<string, any> {
    const result: Record<string, any> = {};
    for (const [k, v] of Object.entries(obj || {})) {
        const key = prefix ? `${prefix}.${k}` : k;
        if (v && typeof v === 'object' && !Array.isArray(v)) {
            Object.assign(result, flattenObj(v, key));
        } else {
            result[key] = v;
        }
    }
    return result;
}

async function main() {
    const args = process.argv.slice(2);

    if (args[0] === 'check' && args[1]) {
        await checkConversation(args[1]);
    } else {
        await phase1();
        console.log('\n========== NEXT STEPS ==========');
        console.log('1. Start a voice session in the app — check logs for conv_id');
        console.log('2. After the session, run:');
        console.log('   ELEVENLABS_API_KEY=... npx tsx packages/happy-server/sources/recipes/testConvTokenMatch.ts check <conv_id>');
    }
}

main().catch(console.error);
