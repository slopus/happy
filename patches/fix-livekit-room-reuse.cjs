/**
 * Patches @elevenlabs/react-native to force /rtc (v0) RTC path because
 * ElevenLabs' LiveKit server returns 404 on /rtc/v1, and the v1→v0 retry
 * delay breaks every session. Adds singlePeerConnection: false to the
 * LiveKitRoom options.
 *
 * NOTE: an earlier version of this patch also added `token` to the Room
 * creation effect deps in @livekit/components-react. That's now reverted —
 * it raced with provider re-keying (two Rooms overlapping, fingerprint
 * mismatch errors). Provider re-key in app code handles stale Room reuse
 * cleanly. We actively un-patch here to restore originals on existing installs.
 */
const fs = require('fs');
const path = require('path');

let patched = 0;

const nodeModulesRoots = [
    path.resolve(__dirname, '..', 'node_modules'),
    path.resolve(__dirname, '..', 'packages/happy-app/node_modules'),
];

// --- Revert prior token-in-deps patch on @livekit/components-react ---

for (const nodeModulesRoot of nodeModulesRoots) {
    // ESM bundle: revert `[r, JSON.stringify(t, T), e]` back to `[r, JSON.stringify(t, T)]`
    const esmFile = path.join(
        nodeModulesRoot,
        '@livekit/components-react/dist/room-Bb6uLxS5.mjs'
    );
    if (fs.existsSync(esmFile)) {
        let content = fs.readFileSync(esmFile, 'utf8');
        const original = content;
        content = content.replace(
            /O\(r \?\? new U\(t\)\);\s*\}, \[r, JSON\.stringify\(t, T\), e\]\)/,
            'O(r ?? new U(t));\n  }, [r, JSON.stringify(t, T)])'
        );
        if (content !== original) {
            fs.writeFileSync(esmFile, content, 'utf8');
            patched++;
        }
    }

    // CJS bundle: revert the same
    const cjsFile = path.join(
        nodeModulesRoot,
        '@livekit/components-react/dist/shared-BGiZtWPs.js'
    );
    if (fs.existsSync(cjsFile)) {
        let content = fs.readFileSync(cjsFile, 'utf8');
        const original = content;
        content = content.replace(
            /I\(f\?\?new d\.Room\(s\)\)\}\,\[f,JSON\.stringify\(s,M\.roomOptionsStringifyReplacer\),t\]\)/,
            'I(f??new d.Room(s))},[f,JSON.stringify(s,M.roomOptionsStringifyReplacer)])'
        );
        if (content !== original) {
            fs.writeFileSync(cjsFile, content, 'utf8');
            patched++;
        }
    }

    // Source file: revert
    const srcFile = path.join(
        nodeModulesRoot,
        '@livekit/components-react/src/hooks/useLiveKitRoom.ts'
    );
    if (fs.existsSync(srcFile)) {
        let content = fs.readFileSync(srcFile, 'utf8');
        const original = content;
        content = content.replace(
            '}, [passedRoom, JSON.stringify(options, roomOptionsStringifyReplacer), token]);',
            '}, [passedRoom, JSON.stringify(options, roomOptionsStringifyReplacer)]);'
        );
        if (content !== original) {
            fs.writeFileSync(srcFile, content, 'utf8');
            patched++;
        }
    }

    // --- Fix 2: Force v0 RTC path in @elevenlabs/react-native LiveKitRoomWrapper ---
    // Add singlePeerConnection: false to options so LiveKit skips the /rtc/v1 path
    // that returns 404 on ElevenLabs' server.

    // Metro picks one of lib.{js,module,umd,modern}.js depending on resolution
    // mode — patch all of them, otherwise the v1 RTC 404 retry will still fire
    // through whichever bundle wasn't covered.
    const elNativeFiles = [
        '@elevenlabs/react-native/dist/lib.js',
        '@elevenlabs/react-native/dist/lib.module.js',
        '@elevenlabs/react-native/dist/lib.umd.js',
        '@elevenlabs/react-native/dist/lib.modern.js',
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

    // Also patch the source file (idempotent: collapse any duplicates from prior
    // non-idempotent runs, then ensure exactly one singlePeerConnection: false).
    const elNativeSrc = path.join(
        nodeModulesRoot,
        '@elevenlabs/react-native/src/components/LiveKitRoomWrapper.tsx'
    );
    if (fs.existsSync(elNativeSrc)) {
        let content = fs.readFileSync(elNativeSrc, 'utf8');
        const original = content;
        content = content.replace(
            /adaptiveStream: \{ pixelDensity: 'screen' \},(\n\s*singlePeerConnection: false,)*/,
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
