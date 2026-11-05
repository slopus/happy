/**
 * `happy voice setup`: downloads Piper + one voice into ~/.happy/voice/ so the
 * app's read-aloud button can synthesize speech on this machine over RPC.
 */

import chalk from 'chalk';
import { spawnSync } from 'node:child_process';
import { createWriteStream, existsSync, mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { PIPER_VOICES, piperArchiveUrl, piperVoiceUrl } from './piperVoices';
import { configFile, piperBinary, readVoiceConfig, synthesize, voiceDir, type VoiceConfig } from './synthesize';

export async function handleVoiceCommand(args: string[]): Promise<void> {
    if (args[0] === 'setup') {
        await runVoiceSetup();
        return;
    }
    const config = readVoiceConfig();
    console.log(config
        ? `Read-aloud voice: ${chalk.bold(config.voice)} (${voiceDir()})`
        : 'Read-aloud is not set up on this machine.');
    console.log(`\n${chalk.bold('Usage:')}\n  happy voice setup       Download Piper and pick or change the read-aloud voice`);
}

async function runVoiceSetup(): Promise<void> {
    const archiveUrl = piperArchiveUrl();
    if (!archiveUrl) {
        throw new Error(`Piper has no prebuilt binary for ${process.platform}-${process.arch}`);
    }

    const current = readVoiceConfig()?.voice;
    console.log(chalk.bold('Local text-to-speech for the read-aloud button (Piper, runs on this machine)\n'));
    PIPER_VOICES.forEach((v, i) => {
        console.log(`  ${i + 1}) ${v.label} ${chalk.gray(v.id)}${v.id === current ? chalk.green(' (current)') : ''}`);
    });

    const rl = createInterface({ input: process.stdin, output: process.stdout });
    let answer: string;
    try {
        answer = await rl.question(`\nVoice [1-${PIPER_VOICES.length}, empty = cancel]: `);
    } finally {
        rl.close();
    }
    const voice = PIPER_VOICES[Number(answer.trim()) - 1];
    if (!voice) {
        console.log(chalk.gray('Cancelled.'));
        return;
    }

    mkdirSync(voiceDir(), { recursive: true });

    if (!existsSync(piperBinary())) {
        const archive = join(voiceDir(), archiveUrl.endsWith('.zip') ? 'piper.zip' : 'piper.tar.gz');
        await download(archiveUrl, archive);
        // System tar: GNU/bsd tar on Linux/macOS, bsdtar on Windows 10+ (also unpacks the .zip).
        const tar = spawnSync('tar', ['-xf', archive, '-C', voiceDir()], { stdio: 'inherit' });
        if (tar.status !== 0) throw new Error(`tar failed: ${tar.error?.message ?? `exit ${tar.status}`}`);
        rmSync(archive);
    }
    for (const suffix of ['.onnx', '.onnx.json'] as const) {
        const target = join(voiceDir(), voice.id + suffix);
        if (!existsSync(target)) await download(piperVoiceUrl(voice, suffix), target);
    }

    console.log('Testing synthesis...');
    await synthesize('Test', voice.id);

    writeFileSync(configFile(), JSON.stringify({ voice: voice.id } satisfies VoiceConfig, null, 2));
    console.log(chalk.green(`Done. Read-aloud now uses ${voice.label}.`) + ' The running daemon picks this up without a restart.');
}

/** Streams `url` to `target` via a temp file, so an aborted download never looks complete. */
async function download(url: string, target: string): Promise<void> {
    console.log(`Downloading ${chalk.gray(url)}`);
    const res = await fetch(url);
    if (!res.ok || !res.body) throw new Error(`Download failed (${res.status}): ${url}`);
    const tmp = `${target}.part`;
    await pipeline(Readable.fromWeb(res.body as any), createWriteStream(tmp));
    renameSync(tmp, target);
}
