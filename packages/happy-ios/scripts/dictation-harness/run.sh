#!/bin/bash
# Runs the app's own dictation (DictationRecognition.swift and
# DictationTranscript.swift, compiled as they are) on a macOS 26+ Mac over
# a `say` recording with long pauses, as the microphone would give it.
#
#   scripts/dictation-harness/run.sh [analyzer|dictation|recognizer] [locale] [text file]
#
# analyzer: SpeechTranscriber where it has the language, else
# DictationTranscriber; dictation: DictationTranscriber; recognizer:
# SFSpeechRecognizer, the fallback. Pauses are `[[slnc 3000]]` in the text.
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
sources="$here/../../Sources"
engine="${1:-analyzer}"
locale="${2:-en-US}"
text="${3:-$here/speech.txt}"
out="$(mktemp -d)"
swiftc -O -swift-version 6 -D DICTATION_HARNESS -o "$out/harness" \
  "$sources/HappyCore/Composer/DictationTranscript.swift" \
  "$sources/HappyUI/Record/DictationRecognition.swift" \
  "$here/main.swift"
say -o "$out/speech.aiff" -f "$text"
afconvert -f WAVE -d LEI16@16000 "$out/speech.aiff" "$out/speech.wav"
"$out/harness" "$out/speech.wav" "$engine" "$locale"
