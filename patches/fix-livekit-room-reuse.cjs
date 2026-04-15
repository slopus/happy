/**
 * Patches @livekit/components-react useLiveKitRoom to fix stale Room reuse.
 *
 * The Room creation effect's dependency array omits `token`, so the same Room
 * instance is reused across sessions. After disconnect(), reconnecting the
 * same Room silently fails. Adding `token` to deps forces a fresh Room per
 * session; the existing cleanup effect automatically disconnects the old one.
 *
 * Upstream: @livekit/components-react useLiveKitRoom.ts line 62-64
 */
const fs = require('fs');
const path = require('path');

let patched = 0;

// ESM bundle: room-Bb6uLxS5.mjs
// Variables: e=token, r=passedRoom, t=options, T=roomOptionsStringifyReplacer
const esmFile = path.resolve(
    __dirname,
    '..',
    'node_modules/@livekit/components-react/dist/room-Bb6uLxS5.mjs'
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
const cjsFile = path.resolve(
    __dirname,
    '..',
    'node_modules/@livekit/components-react/dist/shared-BGiZtWPs.js'
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
const srcFile = path.resolve(
    __dirname,
    '..',
    'node_modules/@livekit/components-react/src/hooks/useLiveKitRoom.ts'
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

if (patched > 0) {
    console.log(`[patch] Fixed @livekit/components-react stale Room reuse (${patched} file(s))`);
}
