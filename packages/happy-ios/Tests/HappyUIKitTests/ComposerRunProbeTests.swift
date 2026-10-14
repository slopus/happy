#if canImport(UIKit)
import CoreText
import HappyCore
import HappyLayout
@testable import HappyUI
import UIKit
import XCTest

/// A probe, not a contract, never merged: the data behind run 38518414723's
/// composer geometry failures. One `RUNPROBE` line of JSON per row, for the
/// card (377), the flat panel (800) and New session's prompt (369) at every
/// text size it is drawn at, for `ComposerEditorGeometryTests`' texts and
/// wrap points, and the growth test's five texts:
///
/// - `heights`: the real `ComposerTextMeasure.run()` off the main thread
///   (`real`), its own steps copied with the layout manager's
///   `usesFontLeading` as made (`yes`) and set to false (`no`), the
///   TextKit 1 twin the oracle uses (`twinEditor`, the editor's text) and
///   one of the measure's attributed string (`twinMeasure`), and the
///   TextKit 2 editor's own height (`tk2Own`); `frame`, `scrolls` and the
///   frame and scrolling `MultiTextInputLayout` would give the `no` height
///   (`noRule`).
/// - Each TextKit 1 path's line fragments: rect, used rect, characters,
///   first glyph, and the fonts of its characters as stored (`stored`), as
///   the layout manager generated glyphs in them (`generated`, from
///   `shouldGenerateGlyphs`, on the probe's own layout managers and twins
///   only) and as CoreText shapes the line (`coreText`). `fonts` has each
///   font's metrics.
/// - The TextKit 2 editor's layout fragments and lines in view
///   coordinates, from its text layout manager.
/// - Carets at the twin's line starts and the end, in both TextKits.
/// - Where the text scrolls: content, bounds and offset before and after
///   `scrollRangeToVisible` at each, both TextKits, in the hidden window
///   and again with it shown.
/// - Where `no` moves the frame or the scrolling: a TextKit 2 twin of the
///   editor in that frame.
///
/// Asserted only that the data is valid: the editor stays TextKit 2, the
/// copy with leading as made gives the real measure, and the font is
/// 16 × the text size's factor. Nothing else is asserted.
@MainActor
final class ComposerRunProbeTests: XCTestCase {
    override func setUp() {
        super.setUp()
        Fonts.registerBundledFonts()
    }

    private let categories: [UIContentSizeCategory] = [
        .extraSmall, .small, .medium, .large, .extraLarge, .extraExtraLarge, .extraExtraExtraLarge,
        .accessibilityMedium, .accessibilityLarge, .accessibilityExtraLarge,
        .accessibilityExtraExtraLarge, .accessibilityExtraExtraExtraLarge,
    ]

    private let growthTexts: [(name: String, text: String)] = [
        ("one", "one"),
        ("one, two", "one\ntwo"),
        ("one and a new line", "one\n"),
        ("wrap me", String(repeating: "wrap me ", count: 12)),
        ("combining mark", "😀 e\u{301} 漢字"),
    ]

    private let send = AgentInputDesktopSend(hasText: true, hasComposerContent: true, isSendBlocked: false)

    private func host(_ category: UIContentSizeCategory) -> (UIWindow, UIView) {
        let window = UIWindow(frame: CGRect(x: 0, y: 0, width: 393, height: 852))
        let host = UIView(frame: window.bounds)
        host.traitOverrides.preferredContentSizeCategory = category
        host.traitOverrides.followsTextSize = true
        window.addSubview(host)
        return (window, host)
    }

    /// As `ComposerEditorGeometryTests` lays a card out.
    private func card(in host: UIView, configuration: AgentInputCardConfiguration, width: CGFloat, text: String) async -> AgentInputCardView {
        let card = AgentInputCardView(configuration: configuration)
        host.addSubview(card)
        card.updateTraitsIfNeeded()
        card.text = text
        _ = card.height(fitting: width)
        await card.textMeasured()
        card.frame = CGRect(x: 0, y: 0, width: width, height: card.height(fitting: width))
        card.layoutIfNeeded()
        card.textView.layoutIfNeeded()
        return card
    }

    private func configuration(desktop: Bool) -> AgentInputCardConfiguration {
        AgentInputCardConfiguration(
            placeholder: "Type a message ...",
            showsAdd: true,
            desktop: desktop ? AgentInputDesktopConfiguration(send: send) : nil
        )
    }

    /// What a row's editor was laid out in.
    private struct Placement {
        var key: ComposerTextHeights.Key
        var measuredInLayout: CGFloat
        var frame: CGFloat
        var minimum: CGFloat
        var cap: CGFloat
        var scrolls: Bool
        /// The frame and scrolling a measured height gives.
        var rule: (CGFloat) -> (frame: CGFloat, scrolls: Bool)
    }

    private func placement(_ card: AgentInputCardView, width: CGFloat) throws -> Placement {
        let key = card.textKey(fitting: width)
        if card.configuration.desktop != nil {
            typealias M = AgentInputDesktopLayout.Metrics
            let input = try XCTUnwrap(card.desktopLayoutInput(width: width))
            let layout = try XCTUnwrap(card.desktopLayout(width: width))
            return Placement(
                key: key,
                measuredInLayout: input.textContentHeight,
                frame: layout.text.height,
                minimum: input.lineHeight + M.textPaddingTop + M.textPaddingBottom,
                cap: M.inputMaxHeight,
                scrolls: layout.textScrolls,
                rule: { height in
                    let text = MultiTextInputLayout(
                        contentHeight: height,
                        hasText: true,
                        maxHeight: M.inputMaxHeight,
                        lineHeight: input.lineHeight,
                        paddingTop: M.textPaddingTop,
                        paddingBottom: M.textPaddingBottom
                    )
                    return (text.height, text.scrollEnabled)
                }
            )
        }
        let input = card.layoutInput(width: width)
        let layout = card.layout(width: width)
        let metrics = card.metrics
        let lineHeight = input.lineHeight ?? metrics.inputLineHeight
        return Placement(
            key: key,
            measuredInLayout: input.textContentHeight,
            frame: layout.text.height,
            minimum: lineHeight + metrics.inputPaddingTop + metrics.inputPaddingBottom,
            cap: metrics.inputMaxHeight,
            scrolls: layout.textScrolls,
            rule: { height in
                let text = MultiTextInputLayout(
                    contentHeight: height,
                    hasText: true,
                    maxHeight: metrics.inputMaxHeight,
                    lineHeight: lineHeight,
                    paddingTop: metrics.inputPaddingTop,
                    paddingBottom: metrics.inputPaddingBottom
                )
                return (text.height, text.scrollEnabled)
            }
        )
    }

    private func emit(_ row: [String: Any]) {
        do {
            let data = try JSONSerialization.data(withJSONObject: row, options: [.sortedKeys])
            print("RUNPROBE \(String(decoding: data, as: UTF8.self))")
        } catch {
            XCTFail("RUNPROBE row not JSON: \(error)")
        }
    }

    private func cardRows(desktop: Bool) async throws {
        let surface = desktop ? "panel" : "card"
        let width: CGFloat = desktop ? 800 : 377
        var count = 0
        for category in categories {
            let (window, host) = host(category)
            let m = TextScale(TextSizeCategory(category)).multiplier
            let probe = await card(in: host, configuration: configuration(desktop: desktop), width: width, text: "hello")
            let wraps = ComposerEditorGeometryTests.onLine(
                attributes: probe.textView.typingAttributes,
                insets: probe.textView.textContainerInset,
                width: probe.textView.bounds.width
            )
            probe.removeFromSuperview()
            for (name, text) in ComposerEditorGeometryTests.texts + wraps {
                let card = await card(in: host, configuration: configuration(desktop: desktop), width: width, text: text)
                let placement = try placement(card, width: width)
                let row = try await record(
                    surface: surface, category: category.rawValue, m: m, name: name, text: text,
                    editor: card.textView, placement: placement, window: window, host: host
                )
                emit(row)
                card.removeFromSuperview()
                count += 1
            }
            withExtendedLifetime(window) {}
        }
        print("RUNPROBE-SUMMARY \(surface) rows=\(count)")
        XCTAssertEqual(count, categories.count * (ComposerEditorGeometryTests.texts.count + 2))
    }

    func testCardRows() async throws {
        try await cardRows(desktop: false)
    }

    func testFlatPanelRows() async throws {
        try await cardRows(desktop: true)
    }

    /// The growth test's card and texts: no text size trait, so drawn as
    /// designed.
    func testGrowthRows() async throws {
        let window = UIWindow(frame: CGRect(x: 0, y: 0, width: 393, height: 852))
        var count = 0
        for (name, text) in growthTexts {
            let card = await card(in: window, configuration: AgentInputCardConfiguration(placeholder: "Type a message ..."), width: 377, text: text)
            let placement = try placement(card, width: 377)
            let row = try await record(
                surface: "growth", category: "designed", m: 1, name: name, text: text,
                editor: card.textView, placement: placement, window: window, host: window
            )
            emit(row)
            card.removeFromSuperview()
            count += 1
        }
        print("RUNPROBE-SUMMARY growth rows=\(count)")
        XCTAssertEqual(count, growthTexts.count)
    }

    /// New session's prompt at its width, drawn as designed; its key as
    /// `NewSessionComposerView.textStamp(inputWidth:)` makes it, and its
    /// frame and scrolling as `NewSessionComposerLayout` takes a height
    /// (NewSessionLayout.swift 264-265).
    func testNewSessionRows() async throws {
        typealias M = NewSessionComposerLayout.Metrics
        let width: CGFloat = 369
        let window = UIWindow(frame: CGRect(x: 0, y: 0, width: 393, height: 852))
        func prompt(_ text: String) async -> NewSessionComposerView {
            let composer = NewSessionComposerView(frame: CGRect(x: 0, y: 0, width: width, height: 98))
            window.addSubview(composer)
            composer.setText(text)
            _ = composer.layout(width: width)
            await composer.textMeasured()
            composer.frame.size.height = composer.layout(width: width).size.height
            composer.layoutIfNeeded()
            return composer
        }
        let probe = await prompt("hello")
        let wraps = ComposerEditorGeometryTests.onLine(
            attributes: probe.textView.typingAttributes,
            insets: probe.textView.textContainerInset,
            width: probe.textView.bounds.width
        )
        probe.removeFromSuperview()
        var count = 0
        for (name, text) in ComposerEditorGeometryTests.texts + wraps {
            let composer = await prompt(text)
            let layout = composer.layout(width: width)
            let key = ComposerTextHeights.Key(
                width: layout.input.width,
                style: TextStyles.composerInput,
                lineHeight: M.lineHeight,
                paddingTop: 0,
                paddingBottom: 0,
                maxHeight: M.inputMaxHeight
            )
            let placement = Placement(
                key: key,
                measuredInLayout: layout.input.height,
                frame: layout.input.height,
                minimum: M.lineHeight,
                cap: M.inputMaxHeight,
                scrolls: layout.textScrolls,
                rule: { height in (min(M.inputMaxHeight, max(M.lineHeight, height)), height > M.inputMaxHeight) }
            )
            let row = try await record(
                surface: "newSession", category: "designed", m: 1, name: name, text: text,
                editor: composer.textView, placement: placement, window: window, host: window
            )
            emit(row)
            composer.removeFromSuperview()
            count += 1
        }
        print("RUNPROBE-SUMMARY newSession rows=\(count)")
        XCTAssertEqual(count, ComposerEditorGeometryTests.texts.count + 2)
    }

    // MARK: One row

    private func record(
        surface: String,
        category: String,
        m: CGFloat,
        name: String,
        text: String,
        editor: UITextView,
        placement: Placement,
        window: UIWindow,
        host: UIView
    ) async throws -> [String: Any] {
        let label = "\(surface) \(category) \(name)"
        XCTAssertNotNil(editor.textLayoutManager, "\(label): TextKit 2 as laid out")
        let fonts = ProbeFontTable()
        let key = placement.key
        let attributes = key.style.attributes(color: UIColor(Palette.inputText))
        let font = try XCTUnwrap(attributes[.font] as? UIFont, label)
        XCTAssertEqual(font.pointSize, 16 * m, accuracy: 0.001, "\(label): the measure's font")
        let editorFont = try XCTUnwrap(editor.typingAttributes[.font] as? UIFont, label)
        XCTAssertEqual(editorFont.pointSize, 16 * m, accuracy: 0.001, "\(label): the editor's font")

        // The real measure, off the main thread as the card runs it.
        let job = ComposerTextMeasure(stamp: .init(key: key, revision: 0, generation: 0), text: text, attributes: attributes)
        let real = await Task.detached(priority: .userInitiated) { job.run() }.value
        let yes = measureCopy(text, attributes, key: key, usesFontLeading: nil, fonts: fonts)
        let no = measureCopy(text, attributes, key: key, usesFontLeading: false, fonts: fonts)
        XCTAssertEqual(yes.height, real, "\(label): the copy with leading as made is the real measure")

        let width = editor.bounds.width
        // The oracle's twin, exactly as `ComposerEditorGeometry.assertFits`
        // makes it.
        let twin = ComposerEditorGeometry.layOut(ComposerEditorGeometry.textKit1Twin(of: editor), width: width)
        let twinHeight = ComposerEditorGeometry.ownHeight(twin, width: width)
        let twinLines = ComposerEditorGeometry.lines(twin)
        let editorText = editor.attributedText ?? NSAttributedString()
        let twinEditor = delegatedTwin(editorText, inset: editor.textContainerInset, width: width, fonts: fonts)
        let twinMeasure = delegatedTwin(NSAttributedString(string: text, attributes: attributes), inset: editor.textContainerInset, width: width, fonts: fonts)

        let tk2Own = ComposerEditorGeometry.ownHeight(editor, width: width)
        let tk2 = tk2Lines(editor)
        let tk2Count = ComposerEditorGeometry.lines(editor)
        let (noFrame, noScrolls) = placement.rule(no.height)
        let (yesFrame, yesScrolls) = placement.rule(real)

        let offsets = ComposerEditorGeometry.caretOffsets(twin)
        twin.frame = CGRect(x: 0, y: 0, width: width, height: placement.frame)
        twin.isScrollEnabled = placement.scrolls
        host.addSubview(twin)
        twin.layoutIfNeeded()
        var row: [String: Any] = [
            "surface": surface,
            "category": category,
            "m": d(m),
            "name": name,
            "utf16": text.utf16.count,
            "width": d(width),
            "key": [
                "width": d(key.width), "lineHeight": d(key.lineHeight), "paddingTop": d(key.paddingTop),
                "paddingBottom": d(key.paddingBottom), "maxHeight": d(key.maxHeight), "measureLimit": d(key.measureLimit),
            ],
            "font": fonts.key(font),
            "editorFont": fonts.key(editorFont),
            "editorTextIsMeasureString": editorText.isEqual(to: NSAttributedString(string: text, attributes: attributes)),
            "heights": [
                "real": d(real), "yes": d(yes.height), "no": d(no.height),
                "twinEditor": d(twinHeight), "twinEditorDelegated": twinEditor["height"] ?? NSNull(),
                "twinMeasure": twinMeasure["height"] ?? NSNull(), "tk2Own": d(tk2Own),
                "measuredInLayout": d(placement.measuredInLayout), "frame": d(placement.frame),
                "minimum": d(placement.minimum), "cap": d(placement.cap), "scrolls": placement.scrolls,
                "yesRule": [d(yesFrame), yesScrolls] as [Any], "noRule": [d(noFrame), noScrolls] as [Any],
            ] as [String: Any],
            "lines": [
                "yes": yes.lines, "no": no.lines, "twinEditor": twinLines,
                "twinMeasure": twinMeasure["lines"] ?? NSNull(), "tk2": tk2Count,
            ] as [String: Any],
            "yes": yes.data,
            "no": no.data,
            "twinEditor": twinEditor,
            "twinMeasure": twinMeasure,
            "tk2": tk2,
            "editor": [
                "bounds": d(editor.bounds.height), "content": d(editor.contentSize.height),
                "offset": d(editor.contentOffset.y), "scrolls": editor.isScrollEnabled,
            ] as [String: Any],
            "twin": [
                "bounds": d(twin.bounds.height), "content": d(twin.contentSize.height),
                "offset": d(twin.contentOffset.y), "scrolls": twin.isScrollEnabled,
                "usesFontLeading": twin.layoutManager.usesFontLeading,
            ] as [String: Any],
            "carets": ["offsets": offsets, "tk2": carets(editor, offsets), "tk1": carets(twin, offsets)] as [String: Any],
        ]

        if placement.scrolls {
            var phases: [String: Any] = [:]
            phases["hidden"] = scrollPhase(window: window, editor: editor, twin: twin, offsets: offsets)
            window.isHidden = false
            window.layoutIfNeeded()
            phases["shown"] = scrollPhase(window: window, editor: editor, twin: twin, offsets: offsets)
            window.isHidden = true
            row["scroll"] = phases
        }
        twin.removeFromSuperview()

        // The editor's text in the frame the `no` height gives, where that
        // moves the frame or the scrolling.
        if noFrame != placement.frame || noScrolls != placement.scrolls {
            let other = UITextView(usingTextLayoutManager: true)
            other.textContainerInset = editor.textContainerInset
            other.textContainer.lineFragmentPadding = 0
            other.attributedText = editorText
            other.isScrollEnabled = noScrolls
            other.frame = CGRect(x: 0, y: 0, width: width, height: noFrame)
            host.addSubview(other)
            other.layoutIfNeeded()
            var block: [String: Any] = [
                "frame": d(noFrame), "scrolls": noScrolls,
                "bounds": d(other.bounds.height), "content": d(other.contentSize.height), "offset": d(other.contentOffset.y),
                "own": d(ComposerEditorGeometry.ownHeight(other, width: width)),
                "lines": ComposerEditorGeometry.lines(other),
                "carets": carets(other, offsets),
            ]
            if noScrolls {
                block["scroll"] = scrollSteps(other, offsets)
            }
            XCTAssertNotNil(other.textLayoutManager, "\(label): the TextKit 2 twin stays TextKit 2")
            other.removeFromSuperview()
            row["noFrameTK2"] = block
        }
        row["fonts"] = fonts.entries
        XCTAssertNotNil(editor.textLayoutManager, "\(label): still TextKit 2 after every read")
        return row
    }

    // MARK: TextKit 1

    /// `ComposerTextMeasure.run()`'s steps, on main, with the layout
    /// manager's `usesFontLeading` as made (nil) or set, and the glyph font
    /// recorder as its delegate.
    private func measureCopy(
        _ text: String,
        _ attributes: [NSAttributedString.Key: Any],
        key: ComposerTextHeights.Key,
        usesFontLeading: Bool?,
        fonts: ProbeFontTable
    ) -> (height: CGFloat, lines: Int, data: [String: Any]) {
        let storage = NSTextStorage(string: text, attributes: attributes)
        let manager = NSLayoutManager()
        let recorder = ProbeGlyphFonts()
        manager.delegate = recorder
        let made = manager.usesFontLeading
        if let usesFontLeading {
            manager.usesFontLeading = usesFontLeading
        }
        let container = NSTextContainer(size: CGSize(width: max(0, key.width), height: key.measureLimit))
        container.lineFragmentPadding = 0
        manager.addTextContainer(container)
        storage.addLayoutManager(manager)
        let glyphs = manager.glyphRange(for: container)
        let characters = manager.characterRange(forGlyphRange: glyphs, actualGlyphRange: nil)
        let used = manager.usedRect(for: container)
        let fits = NSMaxRange(characters) >= storage.length
        let height = key.contentHeight(usedHeight: used.height, fits: fits)
        var data = tk1Lines(manager, container, storage, generated: recorder, fonts: fonts)
        data["height"] = d(height)
        data["usedHeight"] = d(used.height)
        data["fits"] = fits
        data["madeUsesFontLeading"] = made
        withExtendedLifetime(recorder) {}
        return (height, data["lines"] as? Int ?? -1, data)
    }

    /// A TextKit 1 view of `text` as the oracle's twin is made, with the
    /// glyph font recorder as its layout manager's delegate if it has none.
    private func delegatedTwin(_ text: NSAttributedString, inset: UIEdgeInsets, width: CGFloat, fonts: ProbeFontTable) -> [String: Any] {
        let view = UITextView(usingTextLayoutManager: false)
        let recorder = ProbeGlyphFonts()
        var delegate = "probe"
        if let existing = view.layoutManager.delegate {
            delegate = String(describing: type(of: existing))
        } else {
            view.layoutManager.delegate = recorder
        }
        view.textContainerInset = inset
        view.textContainer.lineFragmentPadding = 0
        view.isScrollEnabled = false
        view.attributedText = text
        ComposerEditorGeometry.layOut(view, width: width)
        var data = tk1Lines(view.layoutManager, view.textContainer, view.textStorage, generated: delegate == "probe" ? recorder : nil, fonts: fonts)
        data["height"] = d(ComposerEditorGeometry.ownHeight(view, width: width))
        data["delegate"] = delegate
        data["usesFontLeading"] = view.layoutManager.usesFontLeading
        withExtendedLifetime(recorder) {}
        return data
    }

    /// Each line fragment a TextKit 1 layout manager laid out in its
    /// container: rect, used rect, characters, first glyph and fonts.
    private func tk1Lines(
        _ manager: NSLayoutManager,
        _ container: NSTextContainer,
        _ storage: NSTextStorage,
        generated: ProbeGlyphFonts?,
        fonts: ProbeFontTable
    ) -> [String: Any] {
        var lines: [[String: Any]] = []
        manager.enumerateLineFragments(forGlyphRange: manager.glyphRange(for: container)) { rect, usedRect, _, glyphs, _ in
            let characters = manager.characterRange(forGlyphRange: glyphs, actualGlyphRange: nil)
            var line: [String: Any] = [
                "y": d(rect.minY), "h": d(rect.height),
                "usedY": d(usedRect.minY), "usedH": d(usedRect.height), "usedW": d(usedRect.width),
                "loc": characters.location, "len": characters.length,
                "glyph": glyphs.location, "glyphs": glyphs.length,
            ]
            var stored: [String] = []
            storage.enumerateAttribute(.font, in: characters) { value, _, _ in
                if let font = value as? UIFont {
                    let name = fonts.key(font)
                    if !stored.contains(name) { stored.append(name) }
                }
            }
            line["stored"] = stored
            if let generated {
                var names: [String] = []
                var first: String?
                for run in generated.runs where NSIntersectionRange(run.range, glyphs).length > 0 {
                    let name = fonts.key(run.font)
                    if !names.contains(name) { names.append(name) }
                    if first == nil, NSLocationInRange(glyphs.location, run.range) { first = name }
                }
                line["generated"] = names
                line["firstGlyphFont"] = first ?? NSNull()
            }
            line["coreText"] = coreTextFonts(storage.attributedSubstring(from: characters), fonts: fonts)
            lines.append(line)
        }
        let used = manager.usedRect(for: container)
        let extra = manager.extraLineFragmentRect
        return [
            "lines": lines.count,
            "fragments": lines,
            "used": [d(used.minY), d(used.height)],
            "extra": [d(extra.minY), d(extra.height)],
            "generatedCalls": generated.map { $0.runs.count } ?? -1,
            "usesFontLeading": manager.usesFontLeading,
        ]
    }

    // MARK: TextKit 2

    /// The view's layout fragments and their lines in view coordinates,
    /// from its text layout manager; never its `layoutManager`.
    private func tk2Lines(_ view: UITextView) -> [String: Any] {
        guard let manager = view.textLayoutManager else { return ["missing": true] }
        let inset = view.textContainerInset
        var fragments: [[String: Any]] = []
        var all = 0
        var holding = 0
        _ = manager.enumerateTextLayoutFragments(from: manager.documentRange.location, options: [.ensuresLayout]) { fragment in
            let frame = fragment.layoutFragmentFrame
            let surface = fragment.renderingSurfaceBounds
            let start = manager.offset(from: manager.documentRange.location, to: fragment.rangeInElement.location)
            var lines: [[String: Any]] = []
            for line in fragment.textLineFragments {
                let bounds = line.typographicBounds
                all += 1
                if line.characterRange.length > 0 { holding += 1 }
                lines.append([
                    "y": d(inset.top + frame.minY + bounds.minY), "h": d(bounds.height),
                    "loc": start + line.characterRange.location, "len": line.characterRange.length,
                    "baseline": d(line.glyphOrigin.y),
                ])
            }
            fragments.append([
                "y": d(inset.top + frame.minY), "h": d(frame.height),
                "surfaceY": d(inset.top + frame.minY + surface.minY), "surfaceH": d(surface.height),
                "lines": lines,
            ])
            return true
        }
        return [
            "lines": holding, "allLines": all, "fragments": fragments,
            "insetTop": d(inset.top), "insetBottom": d(inset.bottom),
        ]
    }

    // MARK: Carets and scrolling

    /// [offset, minY, maxY] of the caret at each offset, in the view's
    /// coordinates (its bounds' origin is its content offset).
    private func carets(_ view: UITextView, _ offsets: [Int]) -> [[Any]] {
        offsets.map { offset -> [Any] in
            guard let position = view.position(from: view.beginningOfDocument, offset: offset) else { return [offset, "none"] }
            let caret = view.caretRect(for: position)
            return [offset, d(caret.minY), d(caret.maxY)]
        }
    }

    /// From offset 0, `scrollRangeToVisible` at each offset:
    /// [offset, content offset, caret minY, caret maxY, content height].
    private func scrollSteps(_ view: UITextView, _ offsets: [Int]) -> [String: Any] {
        let before: [Any] = [d(view.contentSize.height), d(view.bounds.height), d(view.contentOffset.y)]
        view.setContentOffset(.zero, animated: false)
        view.layoutIfNeeded()
        var steps: [[Any]] = []
        for offset in offsets {
            view.scrollRangeToVisible(NSRange(location: offset, length: 0))
            view.layoutIfNeeded()
            guard let position = view.position(from: view.beginningOfDocument, offset: offset) else {
                steps.append([offset, "none"])
                continue
            }
            let caret = view.caretRect(for: position)
            steps.append([offset, d(view.contentOffset.y), d(caret.minY), d(caret.maxY), d(view.contentSize.height)])
        }
        let after: [Any] = [d(view.contentSize.height), d(view.bounds.height), d(view.contentOffset.y)]
        view.setContentOffset(.zero, animated: false)
        view.layoutIfNeeded()
        return ["scrolls": view.isScrollEnabled, "before": before, "steps": steps, "after": after]
    }

    private func scrollPhase(window: UIWindow, editor: UITextView, twin: UITextView, offsets: [Int]) -> [String: Any] {
        [
            "window": [
                "hidden": window.isHidden, "key": window.isKeyWindow, "scene": window.windowScene != nil,
                "editorInWindow": editor.window === window, "twinInWindow": twin.window === window,
            ],
            "tk2": scrollSteps(editor, offsets),
            "tk1": scrollSteps(twin, offsets),
        ]
    }
}

private func d(_ value: CGFloat) -> Double {
    Double(value)
}

/// The fonts CoreText shapes `string` in: [location, length, font] per
/// glyph run.
private func coreTextFonts(_ string: NSAttributedString, fonts: ProbeFontTable) -> [[Any]] {
    let line = CTLineCreateWithAttributedString(string as CFAttributedString)
    guard let runs = CTLineGetGlyphRuns(line) as? [CTRun] else { return [] }
    return runs.map { run -> [Any] in
        let attributes = CTRunGetAttributes(run) as NSDictionary
        let range = CTRunGetStringRange(run)
        guard let value = attributes[kCTFontAttributeName as String] else { return [range.location, range.length, "none"] }
        guard let font = value as? UIFont else { return [range.location, range.length, "not a UIFont: \(type(of: value))"] }
        return [range.location, range.length, fonts.key(font)]
    }
}

/// The fonts a probe's own TextKit 1 layout manager generated glyphs in,
/// by glyph range. Never set on the real measure's layout manager or on a
/// TextKit 2 view.
private final class ProbeGlyphFonts: NSObject, NSLayoutManagerDelegate {
    var runs: [(range: NSRange, font: UIFont)] = []

    func layoutManager(
        _ layoutManager: NSLayoutManager,
        shouldGenerateGlyphs glyphs: UnsafePointer<CGGlyph>,
        properties props: UnsafePointer<NSLayoutManager.GlyphProperty>,
        characterIndexes charIndexes: UnsafePointer<Int>,
        font aFont: UIFont,
        forGlyphRange glyphRange: NSRange
    ) -> Int {
        runs.append((glyphRange, aFont))
        return 0
    }
}

/// The fonts a row met, by name and size, with their metrics.
private final class ProbeFontTable {
    var entries: [String: [String: Any]] = [:]

    func key(_ font: UIFont) -> String {
        let key = "\(font.fontName)@\(font.pointSize)"
        if entries[key] == nil {
            entries[key] = [
                "name": font.fontName, "size": d(font.pointSize), "ascender": d(font.ascender),
                "descender": d(font.descender), "leading": d(font.leading), "lineHeight": d(font.lineHeight),
            ]
        }
        return key
    }
}
#endif
