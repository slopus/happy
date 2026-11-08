import AVFAudio
import Foundation
import Speech

// Runs the app's DictationRecognition (compiled from the app's own source)
// over a recording played at its real pace, as the microphone would give it,
// and prints the transcript at every change, then what would be sent.
// Arguments: recording, analyzer|dictation|recognizer|probe, locale (for
// probe, several, comma-separated, best ranked first).
setvbuf(stdout, nil, _IONBF, 0)
let arguments = CommandLine.arguments
let url = URL(fileURLWithPath: arguments[1])
let locales = (arguments.count > 3 ? arguments[3] : "en-US").split(separator: ",").map { Locale(identifier: String($0)) }
let locale = locales[0]
switch arguments.count > 2 ? arguments[2] : "analyzer" {
case "recognizer": DictationRecognition.forcedEngine = .recognizer
case "dictation": DictationRecognition.forcesDictationTranscriber = true
default: break
}
let start = Date()
func stamp() -> String { String(format: "%6.2f", Date().timeIntervalSince(start)) }

guard let recognizer = SFSpeechRecognizer(locale: locale) else { fatalError("no recognizer for \(locale.identifier)") }
let recognition = DictationRecognition(recognizer: recognizer, candidates: arguments.count > 2 && arguments[2] == "probe" ? locales : [])
var last = ("", "")
recognition.onTranscript = { transcript in
    let now = (transcript.finalized, transcript.volatile)
    guard now != last else { return }
    last = now
    print(stamp(), "finalized[\(now.0)] volatile[\(now.1)]")
}
recognition.start()
let file = try AVAudioFile(forReading: url)
let chunk = AVAudioFrameCount(file.processingFormat.sampleRate / 20)
while let buffer = AVAudioPCMBuffer(pcmFormat: file.processingFormat, frameCapacity: chunk),
      (try? file.read(into: buffer, frameCount: chunk)) != nil, buffer.frameLength > 0 {
    recognition.audio.append(buffer)
    try await Task.sleep(for: .milliseconds(50))
}
print(stamp(), "stop; engine:", recognition.engine?.rawValue ?? "none")
print(stamp(), "SENT:", await recognition.finish())
print(stamp(), "language:", recognition.locale.identifier)
