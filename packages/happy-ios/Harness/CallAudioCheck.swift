#if DEBUG && canImport(UIKit)
import AVFAudio
import Foundation
@testable import HappyUI
import LiveKit
import MediaPlayer
import UIKit

/// A real call's audio session beside other apps' audio, on a device
/// (`-callAudio <seconds>` with `-screen split -agent` and
/// `HAPPY_CALL_TAP=1`): the real microphone and speaker, no prompts. Every
/// second it writes the call's state, the session's category, mode,
/// options, rate and route, whether other audio plays, the engine, and
/// the Music app's player to `Documents/call-audio.log`, with every
/// interruption and route change as it comes. After `<seconds>` it ends
/// the call as End would, and keeps writing for 15 s more, to see the
/// music come back.
@MainActor
final class CallAudioCheck {
    private let log = HarnessLog(name: "call-audio")
    private var observers: [NSObjectProtocol] = []

    init(seconds: Double) {
        observe(log: log)
        CallAudioSession.trace = { [log] text in log.write(text) }
        Task { [log] in
            let began = Date()
            var ended = false
            while Date().timeIntervalSince(began) < seconds + 15 {
                if !ended, Date().timeIntervalSince(began) >= seconds {
                    ended = true
                    log.write("ending the call")
                    CallController.shared.close()
                }
                log.write(Self.snapshot())
                try? await Task.sleep(for: .seconds(1))
            }
            log.write("done")
        }
    }

    private func observe(log: HarnessLog) {
        let center = NotificationCenter.default
        observers.append(center.addObserver(forName: AVAudioSession.interruptionNotification, object: nil, queue: nil) { note in
            log.write("interruption \(Self.describe(interruption: note.userInfo ?? [:]))")
        })
        observers.append(center.addObserver(forName: AVAudioSession.routeChangeNotification, object: nil, queue: nil) { note in
            let reason = (note.userInfo?[AVAudioSessionRouteChangeReasonKey] as? UInt).flatMap(AVAudioSession.RouteChangeReason.init(rawValue:))
            log.write("route change \(reason.map(Self.describe(reason:)) ?? "?") -> \(Self.session())")
        })
        observers.append(center.addObserver(forName: AVAudioSession.silenceSecondaryAudioHintNotification, object: nil, queue: nil) { note in
            let type = note.userInfo?[AVAudioSessionSilenceSecondaryAudioHintTypeKey] as? UInt
            log.write("secondary audio hint \(type == AVAudioSession.SilenceSecondaryAudioHintType.begin.rawValue ? "begin" : "end")")
        })
        for name in [UIApplication.didEnterBackgroundNotification, UIApplication.willEnterForegroundNotification] {
            observers.append(center.addObserver(forName: name, object: nil, queue: nil) { note in log.write(note.name.rawValue) })
        }
    }

    static func snapshot() -> String {
        let state = MainActor.assumeIsolated { "\(CallController.shared.state) app \(UIApplication.shared.applicationState.rawValue)" }
        return "call \(state) | \(session()) | engine \(AudioManager.shared.isEngineRunning ? "running" : "stopped") prepared \(AudioManager.shared.isRecordingAlwaysPreparedMode) | music \(music())"
    }

    nonisolated static func session() -> String {
        let session = AVAudioSession.sharedInstance()
        var options: [String] = []
        let all: [(AVAudioSession.CategoryOptions, String)] = [(.mixWithOthers, "mix"), (.duckOthers, "duck"), (.interruptSpokenAudioAndMixWithOthers, "interruptSpoken"),
                                                              (.allowBluetoothHFP, "hfp"), (.allowBluetoothA2DP, "a2dp"), (.allowAirPlay, "airplay"), (.defaultToSpeaker, "speaker")]
        for (option, name) in all where session.categoryOptions.contains(option) { options.append(name) }
        let outputs = session.currentRoute.outputs.map { "\($0.portType.rawValue)" }.joined(separator: ",")
        let inputs = session.currentRoute.inputs.map { "\($0.portType.rawValue)" }.joined(separator: ",")
        return "\(session.category.rawValue.replacingOccurrences(of: "AVAudioSessionCategory", with: "")) \(session.mode.rawValue.replacingOccurrences(of: "AVAudioSessionMode", with: "")) [\(options.joined(separator: ","))] \(Int(session.sampleRate)) Hz io \(Int(session.ioBufferDuration * 1000)) ms in \(inputs) out \(outputs) other \(session.isOtherAudioPlaying) silenceHint \(session.secondaryAudioShouldBeSilencedHint)"
    }

    nonisolated static func music() -> String {
        let player = MPMusicPlayerController.systemMusicPlayer
        let state: String = switch player.playbackState {
        case .playing: "playing"
        case .paused: "paused"
        case .stopped: "stopped"
        case .interrupted: "interrupted"
        case .seekingForward, .seekingBackward: "seeking"
        @unknown default: "?"
        }
        return state
    }

    nonisolated static func describe(interruption info: [AnyHashable: Any]) -> String {
        let type = (info[AVAudioSessionInterruptionTypeKey] as? UInt).flatMap(AVAudioSession.InterruptionType.init(rawValue:))
        var parts = [type == .began ? "began" : type == .ended ? "ended" : "?"]
        if let options = info[AVAudioSessionInterruptionOptionKey] as? UInt {
            parts.append(AVAudioSession.InterruptionOptions(rawValue: options).contains(.shouldResume) ? "shouldResume" : "noResume")
        }
        if let reason = (info[AVAudioSessionInterruptionReasonKey] as? UInt).flatMap(AVAudioSession.InterruptionReason.init(rawValue:)) {
            parts.append("reason \(reason.rawValue)")
        }
        return parts.joined(separator: " ")
    }

    nonisolated static func describe(reason: AVAudioSession.RouteChangeReason) -> String {
        switch reason {
        case .newDeviceAvailable: "newDevice"
        case .oldDeviceUnavailable: "oldDeviceGone"
        case .categoryChange: "categoryChange"
        case .override: "override"
        case .wakeFromSleep: "wake"
        case .noSuitableRouteForCategory: "noRoute"
        case .routeConfigurationChange: "configuration"
        case .unknown: "unknown"
        @unknown default: "\(reason.rawValue)"
        }
    }
}

/// Another app's music, for `CallAudioCheck` (`-fakeMusic`, installed under
/// a bundle ID of its own): a looping chord under `.playback`, not mixable,
/// that the system pauses for an interruption and that plays again when
/// it ends with `.shouldResume`, as a music app does. `-stopAfter <s>`
/// stops it then and lets the session go with
/// `.notifyOthersOnDeactivation`; `-systemMusic` plays the Music app's
/// queue instead. Writes `Documents/music.log`.
@MainActor
final class FakeMusic {
    private let log = HarnessLog(name: "music")
    private var player: AVAudioPlayer?
    private var observers: [NSObjectProtocol] = []

    init(arguments: [String]) {
        let stopAfter = arguments.firstIndex(of: "-stopAfter").flatMap { arguments.indices.contains($0 + 1) ? Double(arguments[$0 + 1]) : nil }
        if arguments.contains("-systemMusic") {
            let music = MPMusicPlayerController.systemMusicPlayer
            music.play()
            log.write("system music play: \(music.nowPlayingItem?.title ?? "nothing queued")")
            Task { [log] in
                while true {
                    log.write("music \(CallAudioCheck.music()) | \(CallAudioCheck.session())")
                    try? await Task.sleep(for: .seconds(1))
                }
            }
            return
        }
        let session = AVAudioSession.sharedInstance()
        do {
            try session.setCategory(.playback, mode: .default, options: [])
            try session.setActive(true)
            let url = FileManager.default.temporaryDirectory.appendingPathComponent("fake-music.wav")
            try Self.chords().write(to: url)
            let player = try AVAudioPlayer(contentsOf: url)
            player.numberOfLoops = -1
            player.play()
            self.player = player
            // As a music app is: the system's Now Playing, with play and pause.
            if !arguments.contains("-noNowPlaying") {
                MPNowPlayingInfoCenter.default().nowPlayingInfo = [MPMediaItemPropertyTitle: "Fake Music", MPMediaItemPropertyPlaybackDuration: 4.0,
                                                                   MPNowPlayingInfoPropertyPlaybackRate: 1.0]
                let commands = MPRemoteCommandCenter.shared()
                commands.playCommand.addTarget { [weak self] _ in MainActor.assumeIsolated { self?.player?.play() }; return .success }
                commands.pauseCommand.addTarget { [weak self] _ in MainActor.assumeIsolated { self?.player?.pause() }; return .success }
                UIApplication.shared.beginReceivingRemoteControlEvents()
            }
            log.write("playing")
        } catch {
            log.write("can't play: \(error)")
        }
        observers.append(NotificationCenter.default.addObserver(forName: AVAudioSession.interruptionNotification, object: nil, queue: .main) { [weak self] note in
            let info = note.userInfo ?? [:]
            let described = CallAudioCheck.describe(interruption: info)
            let ended = (info[AVAudioSessionInterruptionTypeKey] as? UInt) == AVAudioSession.InterruptionType.ended.rawValue
            let resume = ((info[AVAudioSessionInterruptionOptionKey] as? UInt).map { AVAudioSession.InterruptionOptions(rawValue: $0).contains(.shouldResume) }) ?? false
            MainActor.assumeIsolated {
                guard let self else { return }
                self.log.write("interruption \(described)")
                guard ended, resume else { return }
                self.resume(attempt: 0)
            }
        })
        Task { [weak self] in
            let began = Date()
            while let self {
                if let stopAfter, Date().timeIntervalSince(began) >= stopAfter, self.player != nil {
                    self.player?.stop()
                    self.player = nil
                    do { try AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation); self.log.write("stopped, session let go") }
                    catch { self.log.write("stopped, can't let the session go: \(error)") }
                }
                self.log.write("player \(self.player?.isPlaying == true ? "playing" : "silent") app \(UIApplication.shared.applicationState.rawValue) | \(CallAudioCheck.session())")
                try? await Task.sleep(for: .seconds(1))
            }
        }
    }

    /// As a music app does after an interruption, tried again for a few
    /// seconds, to see when the call's session really let go.
    private func resume(attempt: Int) {
        do {
            try AVAudioSession.sharedInstance().setActive(true)
            player?.play()
            log.write("resumed (attempt \(attempt))")
        } catch {
            log.write("can't resume (attempt \(attempt)): \(error)")
            guard attempt < 20 else { return }
            Task { [weak self] in
                try? await Task.sleep(for: .milliseconds(250))
                self?.resume(attempt: attempt + 1)
            }
        }
    }

    /// Four seconds of C, A minor, F and G, a second each, as 16-bit mono WAV.
    private static func chords() -> Data {
        let rate = 44_100
        let chords: [[Double]] = [[261.63, 329.63, 392.0], [220.0, 261.63, 329.63], [174.61, 220.0, 261.63], [196.0, 246.94, 293.66]]
        var samples: [Int16] = []
        for chord in chords {
            for index in 0..<rate {
                let time = Double(index) / Double(rate)
                let envelope = min(1, time * 20) * min(1, (1 - time) * 20)
                let value = chord.reduce(0) { $0 + sin(2 * .pi * $1 * time) } / Double(chord.count)
                samples.append(Int16(value * envelope * 0.5 * Double(Int16.max)))
            }
        }
        return CallDropSound.wav(samples)
    }
}

/// Lines with the wall clock to the millisecond, to stdout and to
/// `Documents/<name>.log`, so two apps' logs merge by time.
final class HarnessLog: @unchecked Sendable {
    private let url: URL
    private let lock = NSLock()
    private let format: DateFormatter = {
        let format = DateFormatter()
        format.dateFormat = "HH:mm:ss.SSS"
        return format
    }()

    init(name: String) {
        let documents = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0]
        url = documents.appendingPathComponent("\(name).log")
        try? Data().write(to: url)
    }

    func write(_ text: String) {
        lock.lock(); defer { lock.unlock() }
        let line = "\(format.string(from: Date())) \(text)\n"
        print(line, terminator: "")
        guard let handle = try? FileHandle(forWritingTo: url) else { return }
        handle.seekToEndOfFile()
        handle.write(Data(line.utf8))
        try? handle.close()
    }
}
#endif
