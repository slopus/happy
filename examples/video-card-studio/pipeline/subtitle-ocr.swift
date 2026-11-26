// Local, read-only OCR of the bottom subtitle region. No network or model download.
import Foundation
import Vision
import ImageIO

struct Frame: Codable { let file: String; let time: Double; let segmentId: String }
struct Line: Codable { let text: String; let confidence: Float }
struct Observation: Codable { let file: String; let time: Double; let segmentId: String; let lines: [Line] }
let frames = try JSONDecoder().decode([Frame].self, from: Data(contentsOf: URL(fileURLWithPath: CommandLine.arguments[1])))
var observations = [Observation]()
for frame in frames {
    let lines: [Line] = try autoreleasepool {
        let request = VNRecognizeTextRequest()
        request.recognitionLevel = .accurate
        request.recognitionLanguages = ["zh-Hans", "en-US"]
        request.usesLanguageCorrection = false
        request.regionOfInterest = CGRect(x: 0, y: 0, width: 1, height: 0.3)
        try VNImageRequestHandler(url: URL(fileURLWithPath: frame.file)).perform([request])
        return (request.results ?? []).compactMap { result in
            // Vision boxes are relative to this bottom-30% region.
            guard result.boundingBox.width >= 0.2, result.boundingBox.height <= 0.6,
                  let text = result.topCandidates(1).first else { return nil }
            return Line(text: text.string, confidence: text.confidence)
        }
    }
    observations.append(Observation(file: frame.file, time: frame.time, segmentId: frame.segmentId, lines: lines))
}
let output = try JSONEncoder().encode(observations)
try output.write(to: URL(fileURLWithPath: CommandLine.arguments[2]), options: .atomic)
