import Foundation
import HappyWire

/// What one DiffChunk in a tool view compares: the text before and after,
/// and the file it names (for its language). The diff itself is built by
/// the shared engine (`HappyCore/Diff`).
public struct ToolDiffChunk: Equatable, Sendable {
    public var oldText: String
    public var newText: String
    /// nil reads as "file.txt" (ToolDiffView).
    public var fileName: String?

    public init(oldText: String, newText: String, fileName: String?) {
        self.oldText = oldText
        self.newText = newText
        self.fileName = fileName
    }
}

/// The diffs EditView, WriteView, MultiEditView and GeminiEditView draw,
/// read from the tool's input the way their zod schemas read it: an input
/// that doesn't parse still draws, from empty text.
public enum ToolDiffInputs {
    public static func chunks(_ kind: ToolViewKind, input: JSONValue) -> [ToolDiffChunk] {
        switch kind {
        case .edit: [edit(input)]
        case .write: [write(input)]
        case .multiEdit: multiEdit(input)
        case .geminiEdit: [geminiEdit(input)]
        default: []
        }
    }

    /// knownTools.Edit.input: file_path, old_string and new_string strings,
    /// replace_all a boolean when present.
    static func edit(_ input: JSONValue) -> ToolDiffChunk {
        guard let path = input["file_path"]?.stringValue,
              let old = input["old_string"]?.stringValue,
              let new = input["new_string"]?.stringValue,
              optionalBool(input["replace_all"])
        else { return ToolDiffChunk(oldText: "", newText: "", fileName: nil) }
        return ToolDiffChunk(oldText: old, newText: new, fileName: path)
    }

    /// knownTools.Write.input; "<no contents>" when it doesn't parse.
    static func write(_ input: JSONValue) -> ToolDiffChunk {
        guard let path = input["file_path"]?.stringValue, let content = input["content"]?.stringValue else {
            return ToolDiffChunk(oldText: "", newText: "<no contents>", fileName: nil)
        }
        return ToolDiffChunk(oldText: "", newText: content, fileName: path)
    }

    /// knownTools.MultiEdit.input: one diff per edit; nothing when any
    /// edit doesn't parse.
    static func multiEdit(_ input: JSONValue) -> [ToolDiffChunk] {
        guard let path = input["file_path"]?.stringValue, let edits = input["edits"]?.arrayValue else { return [] }
        var chunks: [ToolDiffChunk] = []
        for edit in edits {
            guard edit.objectValue != nil,
                  let old = edit["old_string"]?.stringValue,
                  let new = edit["new_string"]?.stringValue,
                  optionalBool(edit["replace_all"])
            else { return [] }
            chunks.append(ToolDiffChunk(oldText: old, newText: new, fileName: path))
        }
        return chunks
    }

    /// GeminiEditView's `extractEditContent`: `toolCall.content[0]`, then
    /// `input[0]`, then the input's own fields.
    static func geminiEdit(_ input: JSONValue) -> ToolDiffChunk {
        func text(_ value: JSONValue?) -> String {
            // `value || ''`: anything falsy reads as empty.
            guard let value, ChatToolPresentation.truthy(value) else { return "" }
            return value.stringValue ?? ChatToolPresentation.pretty(value)
        }
        func chunk(_ content: JSONValue, old: JSONValue?, new: JSONValue?, path: JSONValue?) -> ToolDiffChunk {
            let name = text(path)
            return ToolDiffChunk(oldText: text(old), newText: text(new), fileName: name.isEmpty ? nil : name)
        }
        if let content = input["toolCall"]?["content"]?.arrayValue?.first, ChatToolPresentation.truthy(content) {
            return chunk(content, old: content["oldText"], new: content["newText"], path: content["path"])
        }
        if let content = input["input"]?.arrayValue?.first, ChatToolPresentation.truthy(content) {
            return chunk(content, old: content["oldText"], new: content["newText"], path: content["path"])
        }
        func either(_ first: String, _ second: String) -> JSONValue? {
            let value = input[first]
            return value.map(ChatToolPresentation.truthy) == true ? value : input[second]
        }
        return chunk(input, old: either("oldText", "old_string"), new: either("newText", "new_string"), path: either("path", "file_path"))
    }

    /// An optional zod boolean: absent, or a boolean.
    private static func optionalBool(_ value: JSONValue?) -> Bool {
        switch value {
        case nil, .bool?: true
        default: false
        }
    }
}
