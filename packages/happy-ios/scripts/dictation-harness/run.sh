#!/bin/bash
# Runs the app's own dictation (DictationRecognition.swift and
# DictationTranscript.swift, compiled as they are) on a macOS 26+ Mac over
# a `say` recording with long pauses, as the microphone would give it.
#
#   scripts/dictation-harness/run.sh [analyzer|dictation|recognizer|probe] [locale] [text file] [voice]
#
# analyzer: SpeechTranscriber where it has the language, else
# DictationTranscriber; dictation: DictationTranscriber; recognizer:
# SFSpeechRecognizer, the fallback; probe: every language in `locale`
# (comma-separated, best ranked first) at once, choosing one. Pauses are
# `[[slnc 3000]]` in the text; `voice` is a `say -v` voice.
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
sources="$here/../../Sources"
engine="${1:-analyzer}"
locale="${2:-en-US}"
text="${3:-$here/speech.txt}"
voice="${4:-}"
out="$(mktemp -d)"
swiftc -O -swift-version 6 -D DICTATION_HARNESS -o "$out/harness" \
  "$sources/HappyCore/Composer/DictationTranscript.swift" \
  "$sources/HappyCore/Record/DictationLanguage.swift" \
  "$sources/HappyUI/Record/DictationRecognition.swift" \
  "$here/main.swift"
say ${voice:+-v "$voice"} -o "$out/speech.aiff" -f "$text"
afconvert -f WAVE -d LEI16@16000 "$out/speech.aiff" "$out/speech.wav"
"$out/harness" "$out/speech.wav" "$engine" "$locale"
