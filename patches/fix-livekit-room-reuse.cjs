/**
 * Patches @livekit/components-react and @elevenlabs/react-native for two bugs:
 *
 * 1. Stale Room reuse: useLiveKitRoom's Room creation effect omits `token`
 *    from deps, so the same Room instance is reused across sessions. After
 *    disconnect(), reconnecting silently fails. Fix: add `token` to deps.
 *
 * 2. v1 RTC 404: ElevenLabs' LiveKit server doesn't support the /rtc/v1 path.
 *    LiveKit tries v1 first (when singlePeerConnection is true, the default),
 *    gets 404, then retries on v0 — slow and unreliable. Fix: add
 *    singlePeerConnection: false to LiveKitRoom options so v0 is used directly.
 */
const fs = require('fs');
const path = require('path');

let patched = 0;

const nodeModulesRoots = [
    path.resolve(__dirname, '..', 'node_modules'),
    path.resolve(__dirname, '..', 'packages/happy-app/node_modules'),
];

// --- Fix 1: Stale Room reuse in @livekit/components-react ---

for (const nodeModulesRoot of nodeModulesRoots) {
    // ESM bundle: room-Bb6uLxS5.mjs
    // Variables: e=token, r=passedRoom, t=options, T=roomOptionsStringifyReplacer
    const esmFile = path.join(
        nodeModulesRoot,
        '@livekit/components-react/dist/room-Bb6uLxS5.mjs'
    );
    if (fs.existsSync(esmFile)) {
        let content = fs.readFileSync(esmFile, 'utf8');
        const original = content;
        content = content.replace(
            /O\(r \?\? new U\(t\)\);\s*\}, \[r, JSON\.stringify\(t, T\)\]\)/,
            'O(r ?? new U(t));\n  }, [r, JSON.stringify(t, T), e])'
        );
        if (content !== original) {
            fs.writeFileSync(esmFile, content, 'utf8');
            patched++;
        }
    }

    // CJS bundle: shared-BGiZtWPs.js
    // Variables: t=token, f=passedRoom, s=options, M.roomOptionsStringifyReplacer
    const cjsFile = path.join(
        nodeModulesRoot,
        '@livekit/components-react/dist/shared-BGiZtWPs.js'
    );
    if (fs.existsSync(cjsFile)) {
        let content = fs.readFileSync(cjsFile, 'utf8');
        const original = content;
        content = content.replace(
            /I\(f\?\?new d\.Room\(s\)\)\}\,\[f,JSON\.stringify\(s,M\.roomOptionsStringifyReplacer\)\]\)/,
            'I(f??new d.Room(s))},[f,JSON.stringify(s,M.roomOptionsStringifyReplacer),t])'
        );
        if (content !== original) {
            fs.writeFileSync(cjsFile, content, 'utf8');
            patched++;
        }
    }

    // Source file (Metro may resolve from src/)
    const srcFile = path.join(
        nodeModulesRoot,
        '@livekit/components-react/src/hooks/useLiveKitRoom.ts'
    );
    if (fs.existsSync(srcFile)) {
        let content = fs.readFileSync(srcFile, 'utf8');
        const original = content;
        content = content.replace(
            '}, [passedRoom, JSON.stringify(options, roomOptionsStringifyReplacer)]);',
            '}, [passedRoom, JSON.stringify(options, roomOptionsStringifyReplacer), token]);'
        );
        if (content !== original) {
            fs.writeFileSync(srcFile, content, 'utf8');
            patched++;
        }
    }

    // --- Fix 2: Force v0 RTC path in @elevenlabs/react-native LiveKitRoomWrapper ---
    // Add singlePeerConnection: false to options so LiveKit skips the /rtc/v1 path
    // that returns 404 on ElevenLabs' server.

    const elNativeFiles = [
        '@elevenlabs/react-native/dist/lib.js',
        '@elevenlabs/react-native/dist/lib.module.js',
    ];

    for (const file of elNativeFiles) {
        const filePath = path.join(nodeModulesRoot, file);
        if (!fs.existsSync(filePath)) continue;

        let content = fs.readFileSync(filePath, 'utf8');
        const original = content;
        content = content.replace(
            /options:\{adaptiveStream:\{pixelDensity:"screen"\}\}/g,
            'options:{adaptiveStream:{pixelDensity:"screen"},singlePeerConnection:false}'
        );
        if (content !== original) {
            fs.writeFileSync(filePath, content, 'utf8');
            patched++;
        }
    }

    // Also patch the source file
    const elNativeSrc = path.join(
        nodeModulesRoot,
        '@elevenlabs/react-native/src/components/LiveKitRoomWrapper.tsx'
    );
    if (fs.existsSync(elNativeSrc)) {
        let content = fs.readFileSync(elNativeSrc, 'utf8');
        const original = content;
        content = content.replace(
            "adaptiveStream: { pixelDensity: 'screen' },",
            "adaptiveStream: { pixelDensity: 'screen' },\n        singlePeerConnection: false,"
        );
        if (content !== original) {
            fs.writeFileSync(elNativeSrc, content, 'utf8');
            patched++;
        }
    }
}

if (patched > 0) {
    console.log(`[patch] Fixed LiveKit stale Room + v1 RTC 404 (${patched} file(s))`);
}
