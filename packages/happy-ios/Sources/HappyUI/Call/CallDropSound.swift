#if canImport(UIKit)
import AudioToolbox
import Foundation

/// The sound of a call that ended without the person asking
/// (`CallEnding.isUnexpected`): the completion chime's two notes falling,
/// A5 then E5 0.11 s later, each 0.28 s under the same envelope, no
/// speech. iOS has no public call-ended sound, so it is made here once,
/// as a WAV in Caches, and played as a system sound: the silent switch
/// keeps it quiet, and it needs none of the call's audio session, which is
/// gone by the time it plays.
@MainActor
enum CallDropSound {
    private static var sound: SystemSoundID?

    static func play() {
        guard let id = sound ?? made() else { return }
        sound = id
        AudioServicesPlaySystemSound(id)
    }

    private static func made() -> SystemSoundID? {
        guard let caches = FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask).first else { return nil }
        let url = caches.appendingPathComponent("call-dropped.wav")
        guard (try? wav(samples(rate: rate)).write(to: url, options: .atomic)) != nil else { return nil }
        var id: SystemSoundID = 0
        guard AudioServicesCreateSystemSoundID(url as CFURL, &id) == kAudioServicesNoError else { return nil }
        return id
    }

    private static let rate = 44_100
    static let seconds = 0.42
    private static let attack = 0.015
    private static let peak = 0.12
    private static let floor = 0.0001
    private static let note = 0.28
    private static let notes: [(frequency: Double, delay: Double)] = [(880, 0), (659.25, 0.11)]

    /// The sound at `rate` samples a second.
    static func samples(rate: Int) -> [Int16] {
        (0..<Int((Double(rate) * seconds).rounded(.up))).map { index in
            let time = Double(index) / Double(rate)
            let envelope = time < attack
                ? floor * pow(peak / floor, time / attack)
                : peak * pow(floor / peak, (time - attack) / (seconds - attack))
            var value = 0.0
            for (frequency, delay) in notes where time >= delay && time < delay + note {
                value += sin(2 * .pi * frequency * (time - delay))
            }
            return Int16((value * envelope * Double(Int16.max)).rounded())
        }
    }

    /// 16-bit mono PCM in a WAV file.
    static func wav(_ samples: [Int16]) -> Data {
        var data = Data()
        func append<T: FixedWidthInteger>(_ value: T) { withUnsafeBytes(of: value.littleEndian) { data.append(contentsOf: $0) } }
        let bytes = UInt32(samples.count * 2)
        data.append(contentsOf: Array("RIFF".utf8)); append(36 + bytes)
        data.append(contentsOf: Array("WAVEfmt ".utf8)); append(UInt32(16)); append(UInt16(1)); append(UInt16(1))
        append(UInt32(rate)); append(UInt32(rate * 2)); append(UInt16(2)); append(UInt16(16))
        data.append(contentsOf: Array("data".utf8)); append(bytes)
        for sample in samples { append(sample) }
        return data
    }
}
#endif
