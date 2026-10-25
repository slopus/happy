#if canImport(UIKit)
import HappyCore
import UIKit

/// The editor's glyphs, drawn here in the shapes Telegram's media editor
/// uses (white strokes on a 30pt square): back and next, add text, add a
/// sticker, the text styles, alignment, the font's chevrons, the colour
/// wheel, the link and the bin; and the viewer's sound, on and off.
enum StoryEditorIcons {
    private static let line: CGFloat = 1.66

    private static func draw(_ size: CGSize = CGSize(width: 30, height: 30), _ body: (CGContext) -> Void) -> UIImage {
        UIGraphicsImageRenderer(size: size).image { context in
            let cg = context.cgContext
            cg.setStrokeColor(UIColor.white.cgColor)
            cg.setFillColor(UIColor.white.cgColor)
            cg.setLineWidth(line)
            cg.setLineCap(.round)
            cg.setLineJoin(.round)
            body(cg)
        }
    }

    static let back = draw(CGSize(width: 24, height: 24)) { cg in
        cg.setLineWidth(2.2)
        cg.move(to: CGPoint(x: 15, y: 4.5))
        cg.addLine(to: CGPoint(x: 7.5, y: 12))
        cg.addLine(to: CGPoint(x: 15, y: 19.5))
        cg.strokePath()
    }

    static let next = draw(CGSize(width: 10, height: 16)) { cg in
        cg.setLineWidth(2.2)
        cg.move(to: CGPoint(x: 2.5, y: 2))
        cg.addLine(to: CGPoint(x: 8, y: 8))
        cg.addLine(to: CGPoint(x: 2.5, y: 14))
        cg.strokePath()
    }

    /// A rounded square open at its bottom-left corner, where a "+" sits.
    private static func frameWithPlus(_ cg: CGContext) {
        let r: CGFloat = 6
        cg.move(to: CGPoint(x: 5.5, y: 17))
        cg.addLine(to: CGPoint(x: 5.5, y: 5.5 + r))
        cg.addArc(tangent1End: CGPoint(x: 5.5, y: 5.5), tangent2End: CGPoint(x: 5.5 + r, y: 5.5), radius: r)
        cg.addLine(to: CGPoint(x: 24.5 - r, y: 5.5))
        cg.addArc(tangent1End: CGPoint(x: 24.5, y: 5.5), tangent2End: CGPoint(x: 24.5, y: 5.5 + r), radius: r)
        cg.addLine(to: CGPoint(x: 24.5, y: 24.5 - r))
        cg.addArc(tangent1End: CGPoint(x: 24.5, y: 24.5), tangent2End: CGPoint(x: 24.5 - r, y: 24.5), radius: r)
        cg.addLine(to: CGPoint(x: 13, y: 24.5))
        cg.strokePath()
        cg.move(to: CGPoint(x: 5.5, y: 20.5)); cg.addLine(to: CGPoint(x: 5.5, y: 28.5))
        cg.move(to: CGPoint(x: 1.5, y: 24.5)); cg.addLine(to: CGPoint(x: 9.5, y: 24.5))
        cg.strokePath()
    }

    static let addText = draw { cg in
        frameWithPlus(cg)
        cg.move(to: CGPoint(x: 11, y: 11)); cg.addLine(to: CGPoint(x: 19, y: 11))
        cg.move(to: CGPoint(x: 15, y: 11)); cg.addLine(to: CGPoint(x: 15, y: 19.5))
        cg.strokePath()
    }

    /// A sticker: the square with its bottom-right corner peeled, and a smile.
    static let addSticker = draw { cg in
        let r: CGFloat = 6
        cg.move(to: CGPoint(x: 5.5, y: 17))
        cg.addLine(to: CGPoint(x: 5.5, y: 5.5 + r))
        cg.addArc(tangent1End: CGPoint(x: 5.5, y: 5.5), tangent2End: CGPoint(x: 5.5 + r, y: 5.5), radius: r)
        cg.addLine(to: CGPoint(x: 24.5 - r, y: 5.5))
        cg.addArc(tangent1End: CGPoint(x: 24.5, y: 5.5), tangent2End: CGPoint(x: 24.5, y: 5.5 + r), radius: r)
        cg.addLine(to: CGPoint(x: 24.5, y: 16.5))
        cg.addLine(to: CGPoint(x: 16.5, y: 24.5))
        cg.addLine(to: CGPoint(x: 13, y: 24.5))
        cg.strokePath()
        cg.move(to: CGPoint(x: 24.5, y: 16.5))
        cg.addQuadCurve(to: CGPoint(x: 16.5, y: 24.5), control: CGPoint(x: 16.5, y: 16.5))
        cg.strokePath()
        cg.fillEllipse(in: CGRect(x: 10.6, y: 10.6, width: 2.4, height: 2.4))
        cg.fillEllipse(in: CGRect(x: 17, y: 10.6, width: 2.4, height: 2.4))
        cg.move(to: CGPoint(x: 10.5, y: 16.5))
        cg.addQuadCurve(to: CGPoint(x: 16, y: 19), control: CGPoint(x: 12.5, y: 19.2))
        cg.strokePath()
        cg.move(to: CGPoint(x: 5.5, y: 20.5)); cg.addLine(to: CGPoint(x: 5.5, y: 28.5))
        cg.move(to: CGPoint(x: 1.5, y: 24.5)); cg.addLine(to: CGPoint(x: 9.5, y: 24.5))
        cg.strokePath()
    }

    static let link = draw(CGSize(width: 20, height: 20)) { cg in
        cg.setLineWidth(1.8)
        cg.move(to: CGPoint(x: 8.6, y: 11.4)); cg.addLine(to: CGPoint(x: 11.4, y: 8.6))
        cg.strokePath()
        // Two links, each a rounded bar turned 45°.
        for center in [CGPoint(x: 6.6, y: 13.4), CGPoint(x: 13.4, y: 6.6)] {
            cg.saveGState()
            cg.translateBy(x: center.x, y: center.y)
            cg.rotate(by: -.pi / 4)
            cg.addPath(UIBezierPath(roundedRect: CGRect(x: -5.2, y: -2.9, width: 10.4, height: 5.8), cornerRadius: 2.9).cgPath)
            cg.strokePath()
            cg.restoreGState()
        }
    }

    // MARK: Text tool

    /// The style button's four looks: plain, on a white box, on a grey box, outlined.
    static func style(_ fill: StoryTextFill) -> UIImage {
        draw { cg in
            let box = CGRect(x: 1, y: 1, width: 28, height: 28)
            let letter = UIFont.systemFont(ofSize: 19, weight: .bold)
            var attributes: [NSAttributedString.Key: Any] = [.font: letter, .foregroundColor: UIColor.white]
            switch fill {
            case .filled:
                UIColor.white.setFill()
                UIBezierPath(roundedRect: box, cornerRadius: 7).fill()
                attributes[.foregroundColor] = UIColor.black
            case .semi:
                UIColor(white: 1, alpha: 0.3).setFill()
                UIBezierPath(roundedRect: box, cornerRadius: 7).fill()
            case .stroke, .blur:
                attributes[.foregroundColor] = UIColor.black
                attributes[.strokeColor] = UIColor.white
                attributes[.strokeWidth] = -6
            case .regular:
                break
            }
            let text = NSAttributedString(string: "A", attributes: attributes)
            let size = text.size()
            text.draw(at: CGPoint(x: (30 - size.width) / 2, y: (30 - size.height) / 2))
        }
    }

    /// Three lines, set left, centred or right.
    static func align(_ align: StoryTextAlign) -> UIImage {
        draw { cg in
            cg.setLineWidth(2)
            for (index, w) in ([18, 11, 18] as [CGFloat]).enumerated() {
                let x: CGFloat = switch align {
                case .left: 6
                case .center: 15 - w / 2
                case .right: 24 - w
                }
                let y = 9 + CGFloat(index) * 6
                cg.move(to: CGPoint(x: x, y: y)); cg.addLine(to: CGPoint(x: x + w, y: y))
            }
            cg.strokePath()
        }
    }

    /// The font pill's chevrons, up and down.
    static let fontArrow = draw(CGSize(width: 16, height: 16)) { cg in
        cg.setStrokeColor(UIColor(white: 1, alpha: 0.5).cgColor)
        cg.setLineWidth(1.5)
        cg.move(to: CGPoint(x: 4.5, y: 6)); cg.addLine(to: CGPoint(x: 8, y: 2.5)); cg.addLine(to: CGPoint(x: 11.5, y: 6))
        cg.move(to: CGPoint(x: 4.5, y: 10)); cg.addLine(to: CGPoint(x: 8, y: 13.5)); cg.addLine(to: CGPoint(x: 11.5, y: 10))
        cg.strokePath()
    }

    /// The colour swatch: a hue wheel washing to white at its middle, as a
    /// 24pt ring around the chosen colour.
    static func swatch(_ color: UIColor) -> UIImage {
        UIGraphicsImageRenderer(size: CGSize(width: 24, height: 24)).image { context in
            let cg = context.cgContext
            let center = CGPoint(x: 12, y: 12)
            let steps = 72
            for step in 0..<steps {
                let start = CGFloat(step) / CGFloat(steps) * 2 * .pi - .pi / 2
                let end = CGFloat(step + 1) / CGFloat(steps) * 2 * .pi - .pi / 2 + 0.02
                cg.move(to: center)
                cg.addArc(center: center, radius: 12, startAngle: start, endAngle: end, clockwise: false)
                cg.closePath()
                cg.setFillColor(UIColor(hue: CGFloat(step) / CGFloat(steps), saturation: 0.9, brightness: 1, alpha: 1).cgColor)
                cg.fillPath()
            }
            cg.setFillColor(UIColor.black.cgColor)
            cg.fillEllipse(in: CGRect(x: 3, y: 3, width: 18, height: 18))
            cg.setFillColor(color.cgColor)
            cg.fillEllipse(in: CGRect(x: 4.5, y: 4.5, width: 15, height: 15))
        }
    }

    // MARK: Bin

    /// The bin's can and its lid, apart, so the lid can open.
    static let binCan = draw(CGSize(width: 30, height: 30)) { cg in
        cg.setLineWidth(2)
        cg.move(to: CGPoint(x: 8, y: 10))
        cg.addLine(to: CGPoint(x: 9.4, y: 24.2))
        cg.addQuadCurve(to: CGPoint(x: 11.4, y: 26), control: CGPoint(x: 9.6, y: 26))
        cg.addLine(to: CGPoint(x: 18.6, y: 26))
        cg.addQuadCurve(to: CGPoint(x: 20.6, y: 24.2), control: CGPoint(x: 20.4, y: 26))
        cg.addLine(to: CGPoint(x: 22, y: 10))
        cg.move(to: CGPoint(x: 12.8, y: 14)); cg.addLine(to: CGPoint(x: 13.2, y: 22))
        cg.move(to: CGPoint(x: 17.2, y: 14)); cg.addLine(to: CGPoint(x: 16.8, y: 22))
        cg.strokePath()
    }

    static let binLid = draw(CGSize(width: 30, height: 30)) { cg in
        cg.setLineWidth(2)
        cg.move(to: CGPoint(x: 6, y: 7.5)); cg.addLine(to: CGPoint(x: 24, y: 7.5))
        cg.move(to: CGPoint(x: 12, y: 7.5))
        cg.addLine(to: CGPoint(x: 12.6, y: 5))
        cg.addLine(to: CGPoint(x: 17.4, y: 5))
        cg.addLine(to: CGPoint(x: 18, y: 7.5))
        cg.strokePath()
    }

    static let plus = draw(CGSize(width: 28, height: 28)) { cg in
        cg.setLineWidth(2.2)
        cg.move(to: CGPoint(x: 14, y: 6)); cg.addLine(to: CGPoint(x: 14, y: 22))
        cg.move(to: CGPoint(x: 6, y: 14)); cg.addLine(to: CGPoint(x: 22, y: 14))
        cg.strokePath()
    }

    /// A speaker with its waves, or struck through.
    static func sound(on: Bool) -> UIImage {
        draw { cg in
            cg.move(to: CGPoint(x: 5.5, y: 12))
            cg.addLine(to: CGPoint(x: 9.5, y: 12))
            cg.addLine(to: CGPoint(x: 15, y: 7))
            cg.addLine(to: CGPoint(x: 15, y: 23))
            cg.addLine(to: CGPoint(x: 9.5, y: 18))
            cg.addLine(to: CGPoint(x: 5.5, y: 18))
            cg.closePath()
            cg.fillPath()
            if on {
                cg.addArc(center: CGPoint(x: 15, y: 15), radius: 4.5, startAngle: -.pi / 3.6, endAngle: .pi / 3.6, clockwise: false)
                cg.strokePath()
                cg.addArc(center: CGPoint(x: 15, y: 15), radius: 8.5, startAngle: -.pi / 3.4, endAngle: .pi / 3.4, clockwise: false)
                cg.strokePath()
            } else {
                cg.setLineWidth(2)
                cg.move(to: CGPoint(x: 18.5, y: 11.5)); cg.addLine(to: CGPoint(x: 25.5, y: 18.5))
                cg.move(to: CGPoint(x: 25.5, y: 11.5)); cg.addLine(to: CGPoint(x: 18.5, y: 18.5))
                cg.strokePath()
            }
        }
    }

    /// The reaction sticker in the sheet: a white round speech bubble.
    static let reactionBubble = UIGraphicsImageRenderer(size: CGSize(width: 52, height: 52)).image { context in
        let cg = context.cgContext
        cg.setFillColor(UIColor.white.cgColor)
        cg.fillEllipse(in: CGRect(x: 4, y: 3, width: 44, height: 44))
        // The tail at the bottom left.
        cg.move(to: CGPoint(x: 9, y: 36))
        cg.addQuadCurve(to: CGPoint(x: 4, y: 49), control: CGPoint(x: 8, y: 45))
        cg.addQuadCurve(to: CGPoint(x: 19, y: 44), control: CGPoint(x: 13, y: 48))
        cg.closePath()
        cg.fillPath()
    }
}
#endif
