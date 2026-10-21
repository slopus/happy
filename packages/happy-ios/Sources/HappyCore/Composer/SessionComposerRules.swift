import Foundation
import HappyStore
import HappyWire

/// What SessionView.tsx decides about the chat's composer from the session
/// record: whether Stop shows, whether a send is refused, whether pictures
/// can be attached.
public enum SessionComposerRules {
    /// rig.ts `rigCanAbort`: Happy Agent sessions must advertise it.
    public static func canAbortAgent(_ metadata: JSONValue?) -> Bool {
        guard RigCatalog.isRigV1(metadata) else { return true }
        let capabilities = metadata?["capabilities"]
        return capabilities?["abort"]?.boolValue == true
            && capabilities?["rpcMethods"]?.arrayValue?.contains(.string("abort")) == true
    }

    /// `blockSend`: a Happy Agent that refuses steering while it thinks.
    /// The send button turns into a lock; pressing it shakes the card.
    public static func isSendBlocked(_ record: SessionRecord?) -> Bool {
        guard let record, RigCatalog.isRig(record.metadata), record.thinking else { return false }
        return record.metadata?["capabilities"]?["steering"]?.boolValue != true
    }

    /// `showAbortButton`: the agent is working, or parked on a permission
    /// or a question, and it can be stopped.
    public static func showsAbortButton(_ record: SessionRecord?) -> Bool {
        guard let record, canAbortAgent(record.metadata) else { return false }
        switch SessionState(record) {
        case .thinking, .permissionRequired, .inputRequired: return true
        case .waiting, .disconnected: return false
        }
    }

    /// `onAbort` is set: there is a session, it is connected, and it can be
    /// stopped.
    public static func canAbort(_ record: SessionRecord?) -> Bool {
        guard let record else { return false }
        return SessionState(record) != .disconnected && canAbortAgent(record.metadata)
    }

    /// `canUseAttachments`: Happy Agent sessions by capability, the others
    /// by flavor (attachmentSupport.ts: none, Claude or Codex).
    public static func canUseAttachments(_ record: SessionRecord?) -> Bool {
        guard let record else { return false }
        let metadata = record.metadata
        if RigCatalog.isRigV1(metadata) {
            return metadata?["capabilities"]?["attachments"]?["enabled"]?.boolValue == true
        }
        let flavor = metadata?["flavor"]?.stringValue ?? ""
        return flavor.isEmpty || flavor == "claude" || flavor == "codex"
    }
}

/// useSessionStatus: the status row above the card.
public struct ComposerStatus: Equatable, Sendable {
    public enum Text: Equatable, Sendable {
        /// `status.lastSeen`.
        case lastSeen(LastSeen)
        /// `status.permissionRequired`.
        case permissionRequired
        /// `status.inputRequired`.
        case inputRequired
        /// A vibing word, lowercased, with "…".
        case thinking(String)
        /// `status.online`.
        case online
    }

    /// sessionUtils.ts `formatLastSeen`.
    public enum LastSeen: Equatable, Sendable {
        case justNow
        case minutes(Int)
        case hours(Int)
        case days(Int)
        /// A week or more: the date (milliseconds).
        case date(Int64)
    }

    /// The colour: #999 offline, #FF9500 waiting on the person, #007AFF
    /// thinking, #34C759 online.
    public enum Tone: Equatable, Sendable {
        case disconnected
        case attention
        case thinking
        case online
    }

    public var state: SessionState
    public var text: Text
    public var tone: Tone
    public var isPulsing: Bool

    /// `vibingWord` is drawn afresh each time the state changes
    /// (`randomVibingWord`). `lastSeen`, worked out on the presence clock
    /// (`ChatSessionState.lastSeen`), is shown as it is; without it a
    /// stopped session's is worked out from `now`.
    public init(record: SessionRecord, lastSeen: LastSeen? = nil, now: Int64, vibingWord: String) {
        state = SessionState(record)
        switch state {
        case .disconnected:
            text = .lastSeen(lastSeen ?? Self.lastSeen(activeAt: record.activeAt, now: now))
            tone = .disconnected
            isPulsing = false
        case .permissionRequired:
            text = .permissionRequired
            tone = .attention
            isPulsing = true
        case .inputRequired:
            text = .inputRequired
            tone = .attention
            isPulsing = true
        case .thinking:
            text = .thinking(vibingWord.lowercased() + "…")
            tone = .thinking
            isPulsing = true
        case .waiting:
            text = .online
            tone = .online
            isPulsing = false
        }
    }

    public static func lastSeen(activeAt: Int64, now: Int64) -> LastSeen {
        let seconds = Int64((Double(now - activeAt) / 1000).rounded(.down))
        let minutes = Int64((Double(seconds) / 60).rounded(.down))
        let hours = Int64((Double(minutes) / 60).rounded(.down))
        let days = Int64((Double(hours) / 24).rounded(.down))
        if seconds < 60 { return .justNow }
        if minutes < 60 { return .minutes(Int(minutes)) }
        if hours < 24 { return .hours(Int(hours)) }
        if days < 7 { return .days(Int(days)) }
        return .date(activeAt)
    }

    public static func randomVibingWord() -> String {
        vibingMessages.randomElement() ?? "Thinking"
    }

    /// sessionUtils.ts `vibingMessages`.
    public static let vibingMessages = [
        "Accomplishing", "Actioning", "Actualizing", "Baking", "Booping", "Brewing", "Calculating", "Cerebrating",
        "Channelling", "Churning", "Clauding", "Coalescing", "Cogitating", "Computing", "Combobulating", "Concocting",
        "Conjuring", "Considering", "Contemplating", "Cooking", "Crafting", "Creating", "Crunching", "Deciphering",
        "Deliberating", "Determining", "Discombobulating", "Divining", "Doing", "Effecting", "Elucidating",
        "Enchanting", "Envisioning", "Finagling", "Flibbertigibbeting", "Forging", "Forming", "Frolicking",
        "Generating", "Germinating", "Hatching", "Herding", "Honking", "Ideating", "Imagining", "Incubating",
        "Inferring", "Manifesting", "Marinating", "Meandering", "Moseying", "Mulling", "Mustering", "Musing",
        "Noodling", "Percolating", "Perusing", "Philosophising", "Pontificating", "Pondering", "Processing",
        "Puttering", "Puzzling", "Reticulating", "Ruminating", "Scheming", "Schlepping", "Shimmying", "Simmering",
        "Smooshing", "Spelunking", "Spinning", "Stewing", "Sussing", "Synthesizing", "Thinking", "Tinkering",
        "Transmuting", "Unfurling", "Unravelling", "Vibing", "Wandering", "Whirring", "Wibbling", "Wizarding",
        "Working", "Wrangling",
    ]
}

/// The usage row under the card: the week's quota and the context gauge.
public struct ComposerUsage: Equatable, Sendable {
    /// `getContextStatus`.
    public struct Context: Equatable, Sendable {
        public enum Level: Equatable, Sendable {
            /// 5% or less left: warningCritical.
            case critical
            /// 10% or less left: theme `warning`.
            case warning
            /// Shown only because the setting asks: textSecondary.
            case normal
        }

        public var percent: Int
        public var used: Int
        public var total: Int
        public var level: Level

        public init(percent: Int, used: Int, total: Int, level: Level) {
            self.percent = percent
            self.used = used
            self.total = total
            self.level = level
        }
    }

    /// sessionStatusBar.ts `UsageLimitRow`.
    public struct Window: Equatable, Sendable {
        public var id: String
        public var label: String
        /// Percent used, 0…100, rounded.
        public var utilization: Int?
        /// Milliseconds.
        public var resetsAt: Double?
    }

    /// A row of the week text's menu: the session or the week window, and
    /// its percent as shown.
    public struct MenuRow: Equatable, Sendable {
        public enum Kind: Equatable, Sendable {
            case session
            case week
        }

        public var kind: Kind
        public var percent: Int
        /// Milliseconds.
        public var resetsAt: Double?

        public init(kind: Kind, percent: Int, resetsAt: Double?) {
            self.kind = kind
            self.percent = percent
            self.resetsAt = resetsAt
        }
    }

    public var context: Context?
    /// The week's percent as shown (used, or left with
    /// `usageLimitShowRemaining`); nil hides it.
    public var weekPercent: Int?
    /// The week text's menu (`usageMenuOptions`).
    public var menu: [MenuRow]

    public init(usage: ChatUsage?, usageLimits: JSONValue?, alwaysShowContextSize: Bool, showRemaining: Bool) {
        context = usage.flatMap { usage in
            usage.contextSize == 0 ? nil : Self.contextStatus(
                contextSize: usage.contextSize,
                contextWindow: usage.contextWindow,
                alwaysShow: alwaysShowContextSize
            )
        }
        let rows = Self.usageLimitRows(usageLimits)
        let session = rows.first { $0.id == "five_hour" }
        let week = rows.first { $0.id == "seven_day" }
        func shown(_ utilization: Int) -> Int {
            showRemaining ? 100 - utilization : utilization
        }
        if let utilization = week?.utilization, alwaysShowContextSize || context != nil {
            weekPercent = shown(utilization)
        } else {
            weekPercent = nil
        }
        menu = [(MenuRow.Kind.session, session), (.week, week)].compactMap { kind, window in
            guard let window, let utilization = window.utilization else { return nil }
            return MenuRow(kind: kind, percent: shown(utilization), resetsAt: window.resetsAt)
        }
    }

    /// `getContextStatus`: nothing until the session reports its window;
    /// then shown near the limit, or always when the setting asks.
    public static func contextStatus(contextSize: Int, contextWindow: Int?, alwaysShow: Bool) -> Context? {
        guard let contextWindow, contextWindow > 0 else { return nil }
        let used = max(0, min(100, Double(contextSize) / Double(contextWindow) * 100))
        let remaining = 100 - used
        let level: Context.Level
        if remaining <= 5 {
            level = .critical
        } else if remaining <= 10 {
            level = .warning
        } else if alwaysShow {
            level = .normal
        } else {
            return nil
        }
        return Context(percent: jsRound(used), used: contextSize, total: contextWindow, level: level)
    }

    /// AgentInput.tsx `formatTokenCount`: 950, 12k, 1.2M, 12M.
    public static func formatTokenCount(_ tokens: Int) -> String {
        if tokens < 1000 {
            return "\(max(0, tokens))"
        }
        if tokens < 999_500 {
            return "\(jsRound(Double(tokens) / 1000))k"
        }
        let millions = Double(tokens) / 1_000_000
        if millions >= 10 {
            return "\(jsRound(millions))M"
        }
        let tenths = jsRound(millions * 10)
        return tenths % 10 == 0 ? "\(tenths / 10)M" : "\(tenths / 10).\(tenths % 10)M"
    }

    /// `getUsageLimitRows`: every window, the 5h and 7d ones first.
    public static func usageLimitRows(_ limits: JSONValue?) -> [Window] {
        guard let windows = limits?["windows"]?.arrayValue else { return [] }
        let known = ["five_hour", "seven_day"]
        func rank(_ window: JSONValue) -> Int {
            known.firstIndex(of: window["id"]?.stringValue ?? "") ?? known.count
        }
        let sorted = windows.enumerated()
            .sorted { rank($0.element) != rank($1.element) ? rank($0.element) < rank($1.element) : $0.offset < $1.offset }
            .map(\.element)
        return sorted.compactMap { window in
            guard let id = window["id"]?.stringValue else { return nil }
            let utilization = window["utilization"]?.numberValue.flatMap { $0.isFinite ? jsRound(min(100, max(0, $0))) : nil }
            let resetsAt = window["resetsAt"]?.numberValue.flatMap { $0.isFinite ? $0 : nil }
            return Window(
                id: id,
                label: window["label"]?.stringValue ?? id.replacingOccurrences(of: "_", with: " "),
                utilization: utilization,
                resetsAt: resetsAt
            )
        }
    }

    /// `Math.round`: halves go up.
    static func jsRound(_ value: Double) -> Int {
        Int((value + 0.5).rounded(.down))
    }
}

/// useDraft.ts's autosave: a change between empty and not saves at once,
/// an edit to non-empty text waits `interval`, and a pending edit is
/// flushed when the app leaves the foreground or the composer goes away.
/// A Happy Agent session saves every edit at once and takes remote edits
/// from the store (`storeChanged`).
///
/// It never sees the text, which may be long: only whether each edit left
/// it blank. useDraft's `value === lastSavedValue` check moved to the
/// writer, off the main thread (`ComposerDraftModel.Write.Persist`), and
/// so did the remote edit's comparison with what was saved
/// (`ComposerStoreDelivery.draftIsSaved`). useDraft also compares a remote
/// draft with the store's previous one, but that one always equals the
/// text last saved, so the one comparison decides.
public struct DraftAutosave: Equatable, Sendable {
    public enum Action: Equatable, Sendable {
        case none
        case saveNow
        /// Save after `interval` unless another change comes first.
        case saveLater
    }

    /// 2000ms.
    public static let interval: Duration = .seconds(2)

    /// Whether the text last saved, loaded or taken is blank.
    public private(set) var savedIsBlank: Bool
    /// An edit waits for the debounce.
    public private(set) var hasPending = false
    /// A remote edit came while an input method was composing; look again
    /// when the composition ends.
    public private(set) var remoteDeferred = false

    /// Seeded with the draft the composer opened with, so loading it
    /// doesn't write it back.
    public init(loadedIsBlank: Bool = true) {
        savedIsBlank = loadedIsBlank
    }

    /// An edit that left the text blank or not. `synced`: a Happy Agent
    /// session, whose draft goes to the mirror on every edit.
    public mutating func textChanged(isBlank: Bool, synced: Bool = false) -> Action {
        hasPending = false
        if synced || savedIsBlank != isBlank {
            savedIsBlank = isBlank
            return .saveNow
        }
        if !isBlank {
            hasPending = true
            return .saveLater
        }
        return .none
    }

    /// Nothing but whitespace (`trim().length === 0`). Stops at the first
    /// other character instead of copying the trimmed text.
    public static func isBlank(_ text: String) -> Bool {
        !text.unicodeScalars.contains { !blank.contains($0) }
    }

    private static let blank = CharacterSet.whitespacesAndNewlines

    /// Background, teardown or the debounce: whether an edit is pending,
    /// to save now.
    public mutating func flush() -> Bool {
        defer { hasPending = false }
        return hasPending
    }

    /// `clearDraft`, after a send: the stored draft is deleted.
    public mutating func clear() {
        savedIsBlank = true
        hasPending = false
    }

    /// A synced session's stored draft, read again after its record
    /// changed. `isSaved`: it is the text last saved (the writer compared
    /// them off the main thread). True if it is a remote edit to take: it
    /// drops the pending save and counts as saved (`took`).
    ///
    /// While `composing`, nothing is taken: the edit waits in
    /// `remoteDeferred`, and the composition's end reads the store again.
    /// By then a local edit may have been saved over it, and wins.
    public mutating func storeChanged(isSaved: Bool, composing: Bool = false) -> Bool {
        if composing {
            remoteDeferred = true
            return false
        }
        remoteDeferred = false
        return !isSaved
    }

    /// A stored draft became the text (loaded or taken).
    public mutating func took(isBlank: Bool) {
        savedIsBlank = isBlank
        hasPending = false
    }
}

/// The composer's three chips and their menus (AgentInput.tsx
/// `permissionSettingsGroups` and `modelSettingsGroups` on iOS).
public struct ComposerChipSet: Equatable, Sendable {
    public struct Option: Equatable, Sendable {
        public var key: String
        public var label: String
        public var isDisabled: Bool
    }

    public struct Section: Equatable, Sendable {
        public var title: String?
        public var options: [Option]
    }

    public struct Chip: Equatable, Sendable {
        /// Nil draws the permission chip's shield glyph.
        public var label: String?
        public var accessibilityLabel: String
        /// Nil: the chip shows but can't be opened.
        public var sections: [Section]?
        public var selectedKey: String?
    }

    /// The copy the chips fall back to (en.ts `agentInput.*.title`).
    public struct Titles: Equatable, Sendable {
        public var permission: String
        public var codexPermission: String
        public var geminiPermission: String
        public var model: String
        public var effort: String

        public init(permission: String, codexPermission: String, geminiPermission: String, model: String, effort: String) {
            self.permission = permission
            self.codexPermission = codexPermission
            self.geminiPermission = geminiPermission
            self.model = model
            self.effort = effort
        }
    }

    /// A section of the wide composer's settings menu, under its heading.
    public struct SettingsSection: Equatable, Sendable {
        public enum Kind: Equatable, Sendable {
            case permission
            case model
            case effort
        }

        public var kind: Kind
        public var title: String
        /// The SF Symbol beside the heading.
        public var systemImage: String
        public var options: [Option]
        public var selectedKey: String?
    }

    /// Nil hides the chip: no session, Happy Agent locks the choice, or
    /// there is nothing to pick.
    public var permission: Chip?
    public var model: Chip
    /// Nil hides the chip and the "·" before it.
    public var effort: Chip?
    /// The wide composer's gear (a window wider than 700 points), there
    /// wherever the permission can be picked (`onPermissionModeChange`)
    /// however little its menu holds.
    public var showsSettings: Bool
    /// The gear's menu (`permissionSettingsGroups` and
    /// `modelSettingsGroups`): the permission modes ("shield"), each
    /// provider's models ("cube"), the effort ("bolt"), wherever the chip
    /// would open.
    public var settings: [SettingsSection]

    /// `record` nil is a chat that doesn't exist yet: nothing can be picked.
    public init(modes: ComposerModes, record: SessionRecord?, titles: Titles) {
        let metadata = record?.metadata
        let flavor = metadata?["flavor"]?.stringValue
        let isRig = RigCatalog.isRig(metadata)
        let canPickPermission = record != nil && RigCatalog.isPermissionSelectionEnabled(metadata)
        let canPickModel = record != nil && RigCatalog.isModelSelectionEnabled(metadata)
        let canPickEffort = record != nil && RigCatalog.isReasoningSelectionEnabled(metadata)

        let current = modes.permissionMode.map(ModeHacks.hack)
        let availableModes = ModeHacks.hack(modes.availableModes)
        let permissionTitle = !isRig && flavor == "codex"
            ? titles.codexPermission
            : flavor == "gemini" ? titles.geminiPermission : titles.permission
        if canPickPermission, !availableModes.isEmpty {
            let sandboxed = ModelModeOptions.isSandboxEnabled(metadata: metadata)
            permission = Chip(
                label: PermissionModeLabels.shortLabel(current),
                accessibilityLabel: permissionTitle,
                sections: [Section(title: nil, options: availableModes.map { mode in
                    Option(
                        key: mode.key,
                        label: ModelModeOptions.withSandboxSuffix(
                            PermissionModeLabels.menuLabel(mode),
                            modeKey: mode.key,
                            sandboxEnabled: sandboxed
                        ),
                        isDisabled: mode.isDisabled
                    )
                })],
                selectedKey: current?.key ?? "default"
            )
        } else {
            permission = nil
        }

        let modelName = (modes.modelMode?.name ?? titles.model).trimmingCharacters(in: .whitespacesAndNewlines)
        let canOpenModels = canPickModel && !modes.availableModels.isEmpty
        model = Chip(
            label: ModelModeOptions.truncateModelLabel(modelName),
            accessibilityLabel: titles.model,
            sections: canOpenModels ? ModelModeOptions.groupByProvider(modes.availableModels).map { group in
                Section(
                    title: group.title ?? titles.model,
                    options: group.models.map { Option(key: $0.key, label: $0.name, isDisabled: $0.isDisabled) }
                )
            } : nil,
            selectedKey: modes.modelMode?.key
        )

        if canPickEffort, !modes.availableEffortLevels.isEmpty {
            effort = Chip(
                label: modes.effortLevel?.name ?? titles.effort,
                accessibilityLabel: titles.effort,
                sections: [Section(title: nil, options: modes.availableEffortLevels.map {
                    Option(key: $0.key, label: $0.name, isDisabled: $0.isDisabled)
                })],
                selectedKey: modes.effortLevel?.key
            )
        } else {
            effort = nil
        }

        showsSettings = canPickPermission
        var settings: [SettingsSection] = []
        if let permission, let options = permission.sections?.first?.options {
            settings.append(SettingsSection(
                kind: .permission, title: permissionTitle, systemImage: "shield", options: options, selectedKey: permission.selectedKey
            ))
        }
        for group in model.sections ?? [] {
            settings.append(SettingsSection(
                kind: .model, title: group.title ?? titles.model, systemImage: "cube", options: group.options, selectedKey: model.selectedKey
            ))
        }
        if let effort, let options = effort.sections?.first?.options {
            settings.append(SettingsSection(
                kind: .effort, title: titles.effort, systemImage: "bolt", options: options, selectedKey: effort.selectedKey
            ))
        }
        self.settings = settings
    }
}

extension ComposerPicks {
    /// The picks after `patch` (`.null` clears a field).
    public func applying(_ patch: SessionAgentModesPatch) -> ComposerPicks {
        func merge(_ current: String?, _ change: JSONValue?) -> String? {
            guard let change else { return current }
            return change.stringValue
        }
        return ComposerPicks(
            permissionMode: merge(permissionMode, patch.permissionMode),
            modelMode: merge(modelMode, patch.modelMode),
            effortLevel: merge(effortLevel, patch.effortLevel)
        )
    }
}
