import Foundation
import HappyWire

/// One set of choices drawn as a `ChoiceList`: an inline `<menu>`'s
/// buttons, or one prompt of an agent's question, open or answered.
public struct ChoiceBlock: Equatable, Sendable {
    public enum Source: Equatable, Sendable {
        case menu(messageId: String, blockIndex: Int, buttons: [ChatActions.Button]), question(id: String, prompt: String), answered
    }

    public struct Option: Equatable, Sendable { public var label: String, detail: String? = nil, pressable = true }

    /// `context`: the question's shared background, over its first prompt. `multi`: checkboxes and a
    /// submit, not buttons. `chosen`, once chosen, locked: what was (empty: nothing to emphasize).
    public var source: Source, prompt: String? = nil, context: String? = nil, options: [Option], multi = false
    public var chosen: [Int]? = nil, picked: [Int] = [], emphasized: Int? = nil
}

/// Inline action blocks in an agent's text (happy-agent `API.md`, "Inline
/// actions"): `<menu>` buttons only, read as @slopus/happy-agent-client's
/// `chatActionBlocks` reads them; its vectors
/// (`tests/fixtures/chatActionBlocks.vectors.json`) are this one's tests too.
public enum ChatActions {
    /// Only a `reply` is pressed here; any other action is drawn, inert.
    public struct Button: Equatable, Sendable {
        public var label: String, actionId: String? = nil, params: [String: String] = [:]
        /// The words a press sends: `data-text`, else the label.
        public var text: String { params["text"] ?? label }
    }

    /// `broken`: a menu out of grammar, shown as its text, still numbered.
    public enum Segment: Equatable, Sendable { case text(String), menu([Button]), broken(String) }

    /// The text and its menus, in order; a block still open is left out while it streams.
    public static func split(_ text: String, streaming: Bool) -> [Segment] {
        MediaBlocks.split(text, roots: ["menu"], images: false).compactMap {
            let raw: String
            switch $0 {
            case .markdown(let text): raw = text
            case .layout(let block) where block.complete: return menu(block.raw).map(Segment.menu) ?? .broken(block.raw.trimmingCharacters(in: .whitespacesAndNewlines))
            case .layout(let block): if streaming { return nil } else { raw = block.raw }
            }
            let kept = raw.trimmingCharacters(in: .whitespacesAndNewlines)
            return kept.isEmpty ? nil : .text(kept)
        }
    }

    static let entities = ["amp": "&", "lt": "<", "gt": ">", "quot": "\"", "apos": "'", "nbsp": "\u{a0}", "middot": "·", "hellip": "…", "mdash": "—", "ndash": "–"]
    /// Presentation, never parameters (the daemon's list).
    static let presentation: Set = ["data-action", "data-emphasis", "data-mark", "data-icon"]

    /// A `<menu>` block's buttons; nil when it breaks the grammar: buttons
    /// only, `<br>` alone inside their labels, no `on*` or `style`.
    public static func menu(_ html: String) -> [Button]? {
        let attributes = #"((?:[^>"']|"[^"]*"|'[^']*')*)"#
        let body = html.replacing(try! Regex(#"<!--[\s\S]*?-->"#), with: "")
        guard let menu = try? Regex(#"\s*<menu(?![\w-])"# + attributes + #">([\s\S]*)</menu\s*>\s*"#).ignoresCase().wholeMatch(in: body),
              values(menu.output[1].substring ?? "") != nil, var rest = menu.output[2].substring else { return nil }
        let tag = try! Regex(#"\s*<button(?![\w-])"# + attributes + #">((?:[^<]|<br\s*/?>)*)</button\s*>"#).ignoresCase()
        var buttons: [Button] = []
        while let match = try? tag.prefixMatch(in: rest), let values = values(match.output[1].substring ?? "") {
            let label = decode(String(match.output[2].substring ?? "").replacing(try! Regex(#"<br\s*/?>"#).ignoresCase(), with: " "))
                .split(whereSeparator: \.isWhitespace).joined(separator: " ")
            guard !label.isEmpty else { return nil }
            buttons.append(Button(label: label, actionId: values["data-action"],
                params: Dictionary(uniqueKeysWithValues: values.filter { $0.key.hasPrefix("data-") && !presentation.contains($0.key) }.map { (String($0.key.dropFirst(5)), $0.value) })))
            rest = rest[match.range.upperBound...]
        }
        return rest.allSatisfy(\.isWhitespace) && !buttons.isEmpty ? buttons : nil
    }

    /// A tag's attributes by lowercased name; nil holding a handler or `style`.
    static func values(_ attributes: Substring) -> [String: String]? {
        var values: [String: String] = [:]
        for found in attributes.matches(of: try! Regex(#"([^\s"'>/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?"#)) {
            let key = found.output[1].substring!.lowercased()
            guard !key.hasPrefix("on"), key != "style" else { return nil }
            values[key] = decode(found.output[2].substring ?? found.output[3].substring ?? found.output[4].substring ?? "")
        }
        return values
    }

    static func decode(_ text: some StringProtocol) -> String {
        guard text.contains("&") else { return String(text) }
        return String(text).replacing(try! Regex(#"&(#[xX][0-9a-fA-F]+|#[0-9]+|[a-zA-Z]+);"#), with: { match in
            let name = String(match.output[1].substring!)
            let number = name.hasPrefix("#x") || name.hasPrefix("#X") ? UInt32(name.dropFirst(2), radix: 16) : name.hasPrefix("#") ? UInt32(name.dropFirst()) : nil
            if let number, let scalar = Unicode.Scalar(number) { return String(scalar) }
            return entities[name.lowercased()] ?? "&\(name);"
        })
    }

    /// A menu as drawn: chosen from the message's `actionChoices`, or from a
    /// press on its way. An unknown kind is chosen with nothing emphasized.
    public static func choices(_ buttons: [Button], messageId: String, blockIndex: Int, choice: JSONValue?, pressed: Int?) -> ChoiceBlock {
        let chosen: [Int]? = choice.map { $0["kind"] == .string("button") ? ($0["index"]?.numberValue).map { [Int($0)] } ?? [] : [] } ?? pressed.map { [$0] }
        return ChoiceBlock(source: .menu(messageId: messageId, blockIndex: blockIndex, buttons: buttons),
            options: buttons.map { .init(label: $0.label, pressable: $0.actionId == "reply") },
            chosen: chosen, emphasized: buttons.isEmpty ? nil : 0)  // the first is primary, as on desktop
    }

    /// The press's one `action` block, for `POST /v0/agents/:id/send`.
    public static func press(_ button: Button, messageId: String, blockIndex: Int, controlIndex: Int) -> JSONValue {
        .object(["type": .string("action"), "messageId": .string(messageId), "blockIndex": .number(Double(blockIndex)), "controlIndex": .number(Double(controlIndex)),
                 "actionId": .string(button.actionId ?? ""), "params": .object(button.params.mapValues { .string($0) })])
    }

    /// A prompt's options as drawn: an "Other" isn't, the composer's words answer it.
    public static func offered(_ prompt: AgentQuestion) -> [AgentQuestionOption] {
        prompt.options.filter { $0.label.caseInsensitiveCompare("Other") != .orderedSame }
    }

    /// One prompt of a question as a ChoiceList: buttons, or checkboxes when
    /// it takes several. Words no label matches, typed or answered, are shown
    /// as one more option after them.
    public static func question(_ prompt: AgentQuestion, source: ChoiceBlock.Source, answer: [String]?, picked: [Int] = [], typed: String? = nil, context: String? = nil) -> ChoiceBlock {
        var options = offered(prompt).map { ChoiceBlock.Option(label: $0.label, detail: $0.description) }
        func index(_ value: String) -> Int {
            if let index = options.firstIndex(where: { $0.label == value }) { return index }
            options.append(.init(label: value))
            return options.count - 1
        }
        let chosen = answer.map { $0.map(index) }
        let picked = picked + (chosen == nil ? typed.map { [index($0)] } ?? [] : [])
        return ChoiceBlock(source: source, prompt: prompt.question, context: context, options: options, multi: prompt.multiSelect, chosen: chosen, picked: picked)
    }
}
