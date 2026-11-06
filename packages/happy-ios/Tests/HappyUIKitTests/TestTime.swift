import Foundation

/// How much slower than a Mac's simulator this one runs, from
/// `HAPPY_TEST_TIME_SCALE`: CI sets it for its virtual Macs, and it is 1
/// anywhere else. Budgets of time multiply by it and counts of frames sampled
/// divide by it; what any one frame shows is checked the same at every scale.
enum TestTime {
    static let scale: Double = {
        guard let value = ProcessInfo.processInfo.environment["HAPPY_TEST_TIME_SCALE"].flatMap(Double.init), value > 1 else { return 1 }
        return value
    }()

    /// `budget`, at this simulator's speed.
    static func budget(_ budget: Double) -> Double { budget * scale }

    /// A floor of `frames` frames sampled, in what this simulator draws in
    /// their time.
    static func sampled(_ frames: Int) -> Int { Int((Double(frames) / scale).rounded(.down)) }
}
