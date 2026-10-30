/**
 * Local text-to-speech for the app's read-aloud button: runs the Piper binary
 * that `happy voice setup` downloaded into ~/.happy/voice/. No server, no port;
 * the daemon calls this from its `read-aloud` RPC handler.
 */

import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { configuration } from '@/configuration';

// Resolved per call, not at import: `configuration.happyHomeDir` is not set in
// every context that imports this module (unit tests, for one), and a crash at
// import time takes the whole daemon down instead of one RPC call.
export function voiceDir(): string {
    return join(configuration.happyHomeDir, 'voice');
}
export function configFile(): string {
    return join(voiceDir(), 'config.json');
}
/** The Piper archives all unpack into a `piper/` folder. */
export function piperBinary(): string {
    return join(voiceDir(), 'piper', process.platform === 'win32' ? 'piper.exe' : 'piper');
}
// The app sends short chunks; this is only the upper bound at the trust boundary.
const MAX_TEXT = 2000;
// The server gives the whole RPC call 30s.
const SYNTH_TIMEOUT_MS = 25_000;

export interface VoiceConfig {
    voice: string;
}

export function modelPath(voice: string): string {
    return join(voiceDir(), `${voice}.onnx`);
}

/** The configured voice, or null if setup never ran (or its files are gone). */
export function readVoiceConfig(): VoiceConfig | null {
    try {
        const config = JSON.parse(readFileSync(configFile(), 'utf8')) as VoiceConfig;
        if (typeof config.voice !== 'string' || !existsSync(piperBinary()) || !existsSync(modelPath(config.voice))) {
            return null;
        }
        return config;
    } catch {
        return null;
    }
}

/** Speaks `text` with the given voice and returns the WAV bytes. */
export function synthesize(text: string, voice: string): Promise<Buffer> {
    if (!text.trim()) return Promise.reject(new Error('text is empty'));
    if (text.length > MAX_TEXT) return Promise.reject(new Error(`text longer than ${MAX_TEXT} characters`));

    return new Promise((resolve, reject) => {
        const piper = spawn(piperBinary(), ['--model', modelPath(voice), '--output_file', '-']);
        const chunks: Buffer[] = [];
        let stderr = '';
        const timer = setTimeout(() => piper.kill(), SYNTH_TIMEOUT_MS);

        piper.stdout.on('data', (c: Buffer) => chunks.push(c));
        piper.stderr.on('data', (c: Buffer) => { stderr = (stderr + c.toString()).slice(-500); }); // Piper logs to stderr
        // Missing binary / no exec permission; without this the daemon would crash.
        piper.on('error', (err) => {
            clearTimeout(timer);
            reject(new Error(`could not start piper: ${err.message}`));
        });
        piper.stdin.on('error', () => { }); // EPIPE if piper already died before we wrote
        piper.on('close', (code) => {
            clearTimeout(timer);
            if (code !== 0 || chunks.length === 0) {
                reject(new Error(`piper failed (exit ${code}): ${stderr.trim().split('\n').pop() ?? ''}`));
                return;
            }
            resolve(Buffer.concat(chunks));
        });
        piper.stdin.end(text);
    });
}
