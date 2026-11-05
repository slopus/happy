/**
 * Voices and binaries offered by `happy voice setup` for the read-aloud button.
 *
 * Piper has no multilingual model: one model per language/voice, so the
 * setup surfaces this list as a pick-list. All voices come from
 * https://huggingface.co/rhasspy/piper-voices (URLs verified 2026-10-26).
 * Italian uses `paola-medium` because `riccardo` only exists as `x_low`.
 */

export interface PiperVoice {
    id: string;
    label: string;
    /** Path below piper-voices/resolve/main/, without the .onnx/.onnx.json suffix */
    path: string;
}

export const PIPER_VOICES: PiperVoice[] = [
    { id: 'de_DE-thorsten-high', label: 'German - Thorsten', path: 'de/de_DE/thorsten/high/de_DE-thorsten-high' },
    { id: 'en_US-hfc_female-medium', label: 'English (US) - HFC Female', path: 'en/en_US/hfc_female/medium/en_US-hfc_female-medium' },
    { id: 'es_ES-davefx-medium', label: 'Spanish - Davefx', path: 'es/es_ES/davefx/medium/es_ES-davefx-medium' },
    { id: 'fr_FR-siwis-medium', label: 'French - Siwis', path: 'fr/fr_FR/siwis/medium/fr_FR-siwis-medium' },
    { id: 'it_IT-paola-medium', label: 'Italian - Paola', path: 'it/it_IT/paola/medium/it_IT-paola-medium' },
    { id: 'pt_BR-faber-medium', label: 'Portuguese (BR) - Faber', path: 'pt/pt_BR/faber/medium/pt_BR-faber-medium' },
];

export function piperVoiceUrl(voice: PiperVoice, suffix: '.onnx' | '.onnx.json'): string {
    return `https://huggingface.co/rhasspy/piper-voices/resolve/main/${voice.path}${suffix}`;
}

// rhasspy/piper is archived; 2023.11.14-2 is its last binary release.
// ponytail: only linux x64 has been run for real, the other archives are untested - verify on first macOS/Windows/ARM user report. URLs checked 2026-10-26.
const PIPER_RELEASE = 'https://github.com/rhasspy/piper/releases/download/2023.11.14-2';
const PIPER_ARCHIVES: Record<string, string> = {
    'linux-x64': 'piper_linux_x86_64.tar.gz',
    'linux-arm64': 'piper_linux_aarch64.tar.gz',
    'linux-arm': 'piper_linux_armv7l.tar.gz',
    'darwin-x64': 'piper_macos_x64.tar.gz',
    'darwin-arm64': 'piper_macos_aarch64.tar.gz',
    'win32-x64': 'piper_windows_amd64.zip',
};

/** Download URL of the Piper binary archive for this platform, or null if Piper ships none. */
export function piperArchiveUrl(platform: string = process.platform, arch: string = process.arch): string | null {
    const file = PIPER_ARCHIVES[`${platform}-${arch}`];
    return file ? `${PIPER_RELEASE}/${file}` : null;
}
