#if DEBUG && canImport(UIKit)
import AVFAudio
import Foundation
@testable import HappyUI
import LiveKit
import UIKit

/// A real call with the build's hosted agent, spoken to from files
/// (`-callLive <directory>` with `HAPPY_CALL_TAP=1`): desktop's live voice
/// check, on the simulator. The audio engine renders by hand, so no
/// microphone is ever opened and nothing is played: the agent's voice goes
/// only to `output.wav`. `prompt-1.wav`, `prompt-2.wav`, … in the
/// directory go to the agent as the person's voice, each once the agent
/// has answered the one before; a `prompt-N.txt` goes as the person's
/// words typed (a user message the call hears as theirs). `talkover.txt`,
/// if there is one, is typed the moment the first `conversation_update`
/// cue goes, as the person talking over it. The provider, its transport and the
/// client tools are real; the computer they act on is the harness's
/// fixture one (`DemoComputer`), so nothing reaches a real task.
///
/// Writes `live.json` (the transcript and every tool call, as `CallProbe`
/// kept them), `input.wav` (everything the call sent) and `output.wav`
/// (the agent's voice) to the app's Documents, then hangs up.
@MainActor
final class CallLiveCheck {
    private let prompts: [URL]
    private let talkOver: String?
    private let output: URL
    private let sent = AudioFileRenderer()
    private let heard = AudioFileRenderer()
    private var events: [[String: Any]] = []
    private let began = Date()

    init(directory: URL) throws {
        prompts = try FileManager.default.contentsOfDirectory(at: directory, includingPropertiesForKeys: nil)
            .filter { $0.lastPathComponent.hasPrefix("prompt-") && ["wav", "txt"].contains($0.pathExtension) }
            .sorted { $0.lastPathComponent.localizedStandardCompare($1.lastPathComponent) == .orderedAscending }
        output = try FileManager.default.url(for: .documentDirectory, in: .userDomainMask, appropriateFor: nil, create: true)
        talkOver = (try? String(contentsOf: directory.appendingPathComponent("talkover.txt"), encoding: .utf8))?
            .trimmingCharacters(in: .whitespacesAndNewlines)
        // Before the call: no device, so no microphone and no speaker, only what is played in.
        try AudioManager.shared.setManualRenderingMode(true)
        guard AudioManager.shared.isManualRenderingMode else { throw CocoaError(.featureUnsupported) }
        CallDropSound.muted = true
        sent.open(output.appendingPathComponent("input.wav"))
        heard.open(output.appendingPathComponent("output.wav"))
        AudioManager.shared.add(localAudioRenderer: sent)
        AudioManager.shared.add(remoteAudioRenderer: heard)
        log("prompts \(prompts.map(\.lastPathComponent)) silent: manual rendering \(AudioManager.shared.isManualRenderingMode)")
        Task { await run() }
        if talkOver != nil { Task { await watchForUpdate() } }
    }

    private func run() async {
        defer { finish() }
        guard await until(60, { !CallProbe.transcript.isEmpty || CallProbe.agentSpeaking }) else { return log("never connected") }
        log("connected")
        // The agent's greeting, if it has one, first.
        _ = await quiet(after: 0, timeout: 20)
        for prompt in prompts {
            let agentLines = CallProbe.transcript.filter { $0.role == "agent" }.count
            if prompt.pathExtension == "txt" {
                let text = ((try? String(contentsOf: prompt, encoding: .utf8)) ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
                log("type \(prompt.lastPathComponent): \(text)")
                CallProbe.type?(text)
                if await !quiet(after: agentLines, timeout: 60) { log("no answer to \(prompt.lastPathComponent)") }
                if !CallController.shared.state.isShown { break }
                continue
            }
            do {
                let file = try AVAudioFile(forReading: prompt)
                guard let buffer = AVAudioPCMBuffer(pcmFormat: file.processingFormat, frameCapacity: AVAudioFrameCount(file.length)) else { continue }
                try file.read(into: buffer)
                log("say \(prompt.lastPathComponent) \(String(format: "%.1f", Double(file.length) / file.processingFormat.sampleRate))s")
                // In 100 ms pieces: the mixer converts each into a buffer of its own size.
                let piece = AVAudioFrameCount(file.processingFormat.sampleRate / 10)
                var offset: AVAudioFrameCount = 0
                while offset < buffer.frameLength {
                    let count = min(piece, buffer.frameLength - offset)
                    guard let part = AVAudioPCMBuffer(pcmFormat: buffer.format, frameCapacity: count) else { break }
                    part.frameLength = count
                    for channel in 0..<Int(buffer.format.channelCount) {
                        part.floatChannelData![channel].update(from: buffer.floatChannelData![channel] + Int(offset), count: Int(count))
                    }
                    AudioManager.shared.mixer.capture(appAudio: part)
                    offset += count
                }
            } catch {
                log("can't play \(prompt.lastPathComponent): \(error)")
                continue
            }
            if await !quiet(after: agentLines, timeout: 60) { log("no answer to \(prompt.lastPathComponent)") }
            if !CallController.shared.state.isShown { break }
        }
        // An update still to come, or to be told again, after the last prompt.
        let updates = { CallProbe.sent.filter { $0.kind == "cue" && $0.text.contains("conversation_update") }.count }
        if CallController.shared.state.isShown {
            let lines = CallProbe.transcript.filter { $0.role == "agent" }.count
            _ = await until(talkOver == nil ? 20 : 60, { updates() > (talkOver == nil ? 0 : 1) })
            _ = await quiet(after: lines, timeout: 30)
            log("updates sent \(updates())")
        }
        // What the bar shows once the talking is done: gone if the agent hung up.
        log("call state \(CallController.shared.state)")
        try? await Task.sleep(for: .seconds(4))
    }

    /// Types `talkover.txt` as the first `conversation_update` cue goes,
    /// then waits for the update to be told: up to 90 s more of the call.
    private func watchForUpdate() async {
        guard await until(240, { CallProbe.sent.contains { $0.kind == "cue" && $0.text.contains("conversation_update") } }), let talkOver else { return }
        log("talk over: \(talkOver)")
        CallProbe.type?(talkOver)
        talkedOver = true
    }
    private var talkedOver = false

    /// Until the agent has said more than `after` lines and been quiet
    /// for 2.5 s since.
    private func quiet(after lines: Int, timeout: Double) async -> Bool {
        var quietSince: Date?
        return await until(timeout) {
            let answered = CallProbe.transcript.filter { $0.role == "agent" }.count > lines
            // Not just after a cue went: the agent is about to answer it.
            let cued = CallProbe.sent.last { $0.kind == "cue" }.map { Date().timeIntervalSince($0.at) < 6 } ?? false
            guard answered, !CallProbe.agentSpeaking, !cued else { quietSince = nil; return false }
            let since = quietSince ?? Date()
            quietSince = since
            return Date().timeIntervalSince(since) > 2.5
        }
    }

    private func until(_ seconds: Double, _ condition: () -> Bool) async -> Bool {
        let deadline = Date().addingTimeInterval(seconds)
        while Date() < deadline {
            if condition() { return true }
            try? await Task.sleep(for: .milliseconds(250))
        }
        return condition()
    }

    private func finish() {
        CallController.shared.close()
        AudioManager.shared.remove(localAudioRenderer: sent)
        AudioManager.shared.remove(remoteAudioRenderer: heard)
        sent.close()
        heard.close()
        let report: [String: Any] = [
            "transcript": CallProbe.transcript.map { ["role": $0.role, "text": $0.text] },
            "tools": CallProbe.tools.map { ["name": $0.name, "parameters": $0.parameters, "result": $0.result, "isError": $0.isError, "at": (($0.at.timeIntervalSince(began)) * 10).rounded() / 10] },
            "events": events,
            "context": CallProbe.context,
            "contextBytes": CallProbe.context.utf8.count,
            "sent": CallProbe.sent.map { ["kind": $0.kind, "bytes": $0.text.utf8.count, "text": $0.text, "at": (($0.at.timeIntervalSince(began)) * 10).rounded() / 10] },
            "toolResultBytes": CallProbe.tools.map { $0.result.utf8.count },
            "conversationId": CallProbe.conversationId ?? NSNull(),
            "seconds": (Date().timeIntervalSince(began) * 10).rounded() / 10,
        ]
        if let data = try? JSONSerialization.data(withJSONObject: report, options: [.prettyPrinted, .sortedKeys]) {
            try? data.write(to: output.appendingPathComponent("live.json"))
        }
        log("done")
    }

    private func log(_ text: String) {
        let at = Date().timeIntervalSince(began)
        events.append(["at": (at * 10).rounded() / 10, "event": text])
        print("[call-live] \(String(format: "%.1f", at)) \(text)")
    }
}

/// Writes what the engine hands it to a file, as it comes.
private final class AudioFileRenderer: NSObject, AudioRenderer, @unchecked Sendable {
    private let lock = NSLock()
    private var url: URL?
    private var file: AVAudioFile?

    func open(_ url: URL) {
        lock.lock(); defer { lock.unlock() }
        try? FileManager.default.removeItem(at: url)
        self.url = url
    }

    func render(pcmBuffer: AVAudioPCMBuffer) {
        lock.lock(); defer { lock.unlock() }
        if file == nil, let url {
            print("[call-live] \(url.lastPathComponent) \(pcmBuffer.format) \(pcmBuffer.frameLength) frames")
            file = try? AVAudioFile(forWriting: url, settings: pcmBuffer.format.settings, commonFormat: pcmBuffer.format.commonFormat, interleaved: pcmBuffer.format.isInterleaved)
        }
        try? file?.write(from: pcmBuffer)
    }

    func close() {
        lock.lock(); defer { lock.unlock() }
        file = nil
        url = nil
    }
}
#endif
