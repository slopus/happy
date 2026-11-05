#if canImport(UIKit)
import Foundation
import UIKit

/// ThumbHash's encoder (github.com/evanw/thumbhash, `rgbaToThumbHash`), so
/// the fake feed computer hashes its covers as the daemon does: the first
/// frame fitted in 100×100, standard base64.
enum ThumbHashEncoder {
    static func base64(_ image: CGImage) -> String? {
        let scale = min(1, 100 / CGFloat(max(image.width, image.height)))
        let w = max(1, Int((CGFloat(image.width) * scale).rounded()))
        let h = max(1, Int((CGFloat(image.height) * scale).rounded()))
        var rgba = [UInt8](repeating: 0, count: w * h * 4)
        let drawn = rgba.withUnsafeMutableBytes { pixels -> Bool in
            guard let context = CGContext(data: pixels.baseAddress, width: w, height: h, bitsPerComponent: 8, bytesPerRow: w * 4,
                                          space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue) else { return false }
            context.draw(image, in: CGRect(x: 0, y: 0, width: w, height: h))
            return true
        }
        guard drawn else { return nil }
        // Back from premultiplied, as the reference reads straight RGBA.
        for i in stride(from: 0, to: rgba.count, by: 4) where rgba[i + 3] > 0 && rgba[i + 3] < 255 {
            let alpha = Double(rgba[i + 3]) / 255
            for c in 0..<3 { rgba[i + c] = UInt8(min(255, (Double(rgba[i + c]) / alpha).rounded())) }
        }
        return Data(hash(w, h, rgba)).base64EncodedString()
    }

    private static func round(_ value: Double) -> Int { Int((value + 0.5).rounded(.down)) }

    static func hash(_ w: Int, _ h: Int, _ rgba: [UInt8]) -> [UInt8] {
        var avgR = 0.0, avgG = 0.0, avgB = 0.0, avgA = 0.0
        for i in 0..<(w * h) {
            let j = i * 4
            let alpha = Double(rgba[j + 3]) / 255
            avgR += alpha / 255 * Double(rgba[j])
            avgG += alpha / 255 * Double(rgba[j + 1])
            avgB += alpha / 255 * Double(rgba[j + 2])
            avgA += alpha
        }
        if avgA > 0 { avgR /= avgA; avgG /= avgA; avgB /= avgA }
        let hasAlpha = avgA < Double(w * h)
        let lLimit = hasAlpha ? 5.0 : 7.0
        let lx = max(1, round(lLimit * Double(w) / Double(max(w, h))))
        let ly = max(1, round(lLimit * Double(h) / Double(max(w, h))))
        var l = [Double](repeating: 0, count: w * h), p = l, q = l, a = l
        for i in 0..<(w * h) {
            let j = i * 4
            let alpha = Double(rgba[j + 3]) / 255
            let r = avgR * (1 - alpha) + alpha / 255 * Double(rgba[j])
            let g = avgG * (1 - alpha) + alpha / 255 * Double(rgba[j + 1])
            let b = avgB * (1 - alpha) + alpha / 255 * Double(rgba[j + 2])
            l[i] = (r + g + b) / 3
            p[i] = (r + g) / 2 - b
            q[i] = r - g
            a[i] = alpha
        }
        func channel(_ values: [Double], _ nx: Int, _ ny: Int) -> (dc: Double, ac: [Double], scale: Double) {
            var dc = 0.0, ac: [Double] = [], scale = 0.0
            var fx = [Double](repeating: 0, count: w)
            for cy in 0..<ny {
                var cx = 0
                while cx * ny < nx * (ny - cy) {
                    var f = 0.0
                    for x in 0..<w { fx[x] = cos(Double.pi / Double(w) * Double(cx) * (Double(x) + 0.5)) }
                    for y in 0..<h {
                        let fy = cos(Double.pi / Double(h) * Double(cy) * (Double(y) + 0.5))
                        for x in 0..<w { f += values[x + y * w] * fx[x] * fy }
                    }
                    f /= Double(w * h)
                    if cx > 0 || cy > 0 {
                        ac.append(f)
                        scale = max(scale, abs(f))
                    } else {
                        dc = f
                    }
                    cx += 1
                }
            }
            if scale > 0 { ac = ac.map { 0.5 + 0.5 / scale * $0 } }
            return (dc, ac, scale)
        }
        let lc = channel(l, max(3, lx), max(3, ly))
        let pc = channel(p, 3, 3)
        let qc = channel(q, 3, 3)
        let ac = hasAlpha ? channel(a, 5, 5) : (dc: 0.0, ac: [Double](), scale: 0.0)
        let landscape = w > h
        let header24 = round(63 * lc.dc) | (round(31.5 + 31.5 * pc.dc) << 6) | (round(31.5 + 31.5 * qc.dc) << 12) | (round(31 * lc.scale) << 18) | ((hasAlpha ? 1 : 0) << 23)
        let header16 = (landscape ? ly : lx) | (round(63 * pc.scale) << 3) | (round(63 * qc.scale) << 9) | ((landscape ? 1 : 0) << 15)
        var hash: [UInt8] = [UInt8(header24 & 255), UInt8((header24 >> 8) & 255), UInt8(header24 >> 16), UInt8(header16 & 255), UInt8(header16 >> 8)]
        let start = hasAlpha ? 6 : 5
        if hasAlpha { hash.append(UInt8(round(15 * ac.dc) | (round(15 * ac.scale) << 4))) }
        var index = 0
        for values in hasAlpha ? [lc.ac, pc.ac, qc.ac, ac.ac] : [lc.ac, pc.ac, qc.ac] {
            for f in values {
                let at = start + (index >> 1)
                while hash.count <= at { hash.append(0) }
                hash[at] |= UInt8(round(15 * f) << ((index & 1) << 2))
                index += 1
            }
        }
        return hash
    }
}
#endif
