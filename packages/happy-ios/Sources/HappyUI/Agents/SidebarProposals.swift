#if canImport(UIKit)
import HappyCore
import HappyLayout
import UIKit

/// One sidebar proposal as a chat shows it.
struct ProposalShown: Equatable, Sendable {
    enum Status: Equatable, Sendable {
        case loading
        /// Gone, another person's, or from a daemon without proposals.
        case missing
        case open, accepted, declined
    }

    enum Answer: Equatable, Sendable { case accept, decline }

    var status: Status = .loading
    /// Which revision this is, counted from 1: version 1 is the sidebar it
    /// was drafted from, so the first proposal is 2.
    var revision = 1
    /// The rows drawn, folds applied; the phone's Search and Create are
    /// elsewhere, so they aren't here either.
    var rows: [Row] = []
    /// An answer is on its way; both buttons wait.
    var answering: Answer?
    /// Why the last answer didn't go through, until the next one.
    var notice: String?

    /// What the card's layout needs, measured with the card's own faces.
    var input: SidebarProposalLayout.Input {
        typealias M = SidebarProposalLayout.Metrics
        func width(_ text: String, _ font: UIFont) -> CGFloat {
            (text as NSString).size(withAttributes: [.font: font]).width
        }
        let button = Fonts.ui(.bold, size: M.buttonSize)
        let footer: SidebarProposalLayout.Footer = status == .open
            ? .answers(keep: width(Strings.keepMine, button), use: width(Strings.useThisSidebar, button), notice: notice != nil)
            : .status
        return SidebarProposalLayout.Input(
            rows: SidebarView.layoutRows(rows),
            titleWidth: width(Strings.proposedSidebar, Fonts.ui(.semiBold, size: M.headerSize)),
            footer: footer
        )
    }
}

/// The sidebar proposals a conversation shows, as desktop's
/// `sidebarProposalsStore` keeps them: each read when the chat first shows
/// it, then read again whenever `space.sidebar.proposal.changed` names it or
/// the stream comes back. The rows are drawn from the proposal's document
/// with the spaces the sidebar holds now. A read-only card's folds are the
/// reader's alone, as are an open one's on the phone.
@MainActor
final class SidebarProposals {
    private(set) var shown: [String: ProposalShown] = [:]
    var onChange: (() -> Void)?

    private struct Held {
        var proposal: AgentWire.SidebarProposal
        var html: String
        /// Every row, folded ones included.
        var rows: [Row]
    }

    private let client: AgentClient
    private let store: Store
    private var held: [String: Held] = [:]
    /// Rows the reader folded or unfolded, by proposal.
    private var turned: [String: Set<String>] = [:]
    private var reading: Set<String> = []
    /// A read asked for while one was out: it runs again when that ends.
    private var again: Set<String> = []
    private var following: Task<Void, Never>?
    private var refreshing: Task<Void, Never>?

    init(client: AgentClient, store: Store) {
        self.client = client
        self.store = store
    }

    func stop() {
        following?.cancel()
        following = nil
        refreshing?.cancel()
        refreshing = nil
    }

    /// The computer is back: every proposal is read again, as one that
    /// failed while it was away would otherwise wait for the next event.
    func reconnected() {
        for artifactId in shown.keys { read(artifactId) }
    }

    /// The proposals the transcript holds; a new one is read.
    func want(_ artifactIds: [String]) {
        for artifactId in artifactIds where shown[artifactId] == nil {
            shown[artifactId] = ProposalShown()
            read(artifactId)
        }
        guard following == nil, !shown.isEmpty else { return }
        let store = store
        following = Task { [weak self] in
            let events = await store.events(matching: ["space.sidebar.proposal."])
            for await event in events {
                guard let self else { return }
                switch event {
                case .resync:
                    for artifactId in shown.keys { read(artifactId) }
                case .event(let envelope):
                    guard let artifactId = envelope["payload"]?["proposal"]?["artifactId"]?.stringValue, shown[artifactId] != nil else { continue }
                    read(artifactId)
                }
            }
        }
    }

    /// The sidebar's spaces changed: names, marks and statuses are drawn again.
    func spacesChanged() {
        refreshing?.cancel()
        let documents = held.mapValues(\.html)
        guard !documents.isEmpty else { return }
        let store = store
        // One pass at a time: a newer change cancels the one before it.
        refreshing = Task { [weak self] in
            for (artifactId, html) in documents {
                let rows = await store.rows(of: html)
                guard !Task.isCancelled, let self else { return }
                guard let rows, held[artifactId]?.html == html else { continue }
                held[artifactId]?.rows = rows
                show(artifactId)
            }
        }
    }

    /// Folds or unfolds a row in this card alone.
    func turn(_ artifactId: String, rowId: String) {
        var rows = turned[artifactId] ?? []
        if rows.remove(rowId) == nil { rows.insert(rowId) }
        turned[artifactId] = rows
        show(artifactId)
    }

    func accept(_ artifactId: String) { answer(artifactId, .accept) }

    func decline(_ artifactId: String) { answer(artifactId, .decline) }

    // MARK: Reads

    private func read(_ artifactId: String) {
        guard !reading.contains(artifactId) else {
            again.insert(artifactId)
            return
        }
        reading.insert(artifactId)
        let client = client
        let store = store
        Task { [weak self] in
            let result: Result<(AgentWire.SidebarProposalResponse, [Row]), Error>
            do {
                let answer = try await client.sidebarProposal(artifactId)
                let rows = await store.rows(of: answer.html) ?? []
                result = .success((answer, rows))
            } catch {
                result = .failure(error)
            }
            guard let self else { return }
            reading.remove(artifactId)
            switch result {
            case .success(let (answer, rows)):
                // A version this card already holds stands, and so does an
                // answer: it keeps the version, and a read sent before it
                // still says open.
                if let current = held[artifactId], current.proposal.version > answer.proposal.version
                    || (current.proposal.version == answer.proposal.version && current.proposal.status != "open" && answer.proposal.status == "open") {
                    break
                }
                held[artifactId] = Held(proposal: answer.proposal, html: answer.html, rows: rows)
                show(artifactId)
            case .failure(let error):
                if (error as? AgentClientError)?.status == 404 {
                    held[artifactId] = nil
                    shown[artifactId]?.status = .missing
                    onChange?()
                }
                // Otherwise the computer is away: the stream's return reads it again.
            }
            if again.remove(artifactId) != nil { read(artifactId) }
        }
    }

    /// Whether it published.
    @discardableResult
    private func show(_ artifactId: String) -> Bool {
        guard let entry = held[artifactId] else { return false }
        var next = shown[artifactId] ?? ProposalShown()
        next.status = switch entry.proposal.status {
        case "accepted": .accepted
        case "declined": .declined
        default: .open
        }
        next.revision = max(1, entry.proposal.version - 1)
        let turned = turned[artifactId] ?? []
        let rows = entry.rows
            .filter { $0.kind != .search && $0.kind != .create }
            .map { row -> Row in
                guard turned.contains(row.id) else { return row }
                var row = row
                row.collapsed = row.collapsed != true
                return row
            }
        next.rows = Rows.visible(rows)
        if next.status != .open {
            next.answering = nil
            next.notice = nil
        }
        guard next != shown[artifactId] else { return false }
        shown[artifactId] = next
        onChange?()
        return true
    }

    // MARK: Answers

    private func answer(_ artifactId: String, _ answer: ProposalShown.Answer) {
        guard var entry = shown[artifactId], entry.status == .open, entry.answering == nil else { return }
        entry.answering = answer
        entry.notice = nil
        shown[artifactId] = entry
        onChange?()
        let client = client
        // One mutation ID across the tries, so a retry of one that was heard
        // gets the first answer back.
        let mutationId = UUID().uuidString.lowercased()
        Task { [weak self] in
            do {
                let proposal = try await Self.attempt {
                    switch answer {
                    case .accept: try await client.acceptSidebarProposal(artifactId, mutationId: mutationId)
                    case .decline: try await client.declineSidebarProposal(artifactId, mutationId: mutationId)
                    }
                }
                guard let self else { return }
                shown[artifactId]?.answering = nil
                held[artifactId]?.proposal = proposal
                if answer == .accept { Haptics.play(.putAway) }
                // Published once, by show() when the status moved.
                if !show(artifactId) { onChange?() }
            } catch {
                guard let self else { return }
                shown[artifactId]?.answering = nil
                shown[artifactId]?.notice = Self.notice(error)
                onChange?()
                // The proposal may have moved on: read where it stands.
                read(artifactId)
            }
        }
    }

    /// Tries again what wasn't heard; a refusal is final.
    private static func attempt<Answer: Sendable>(_ act: @Sendable () async throws -> Answer) async throws -> Answer {
        var tries = 0
        while true {
            do {
                return try await act()
            } catch {
                let status = (error as? AgentClientError)?.status
                if tries >= 2 || error is CancellationError || error as? AgentClientError == .revoked || (status.map { $0 < 500 } ?? false) { throw error }
                tries += 1
                try await Task.sleep(for: .milliseconds(400 * tries))
            }
        }
    }

    private static func notice(_ error: Error) -> String {
        if case .status(_, _, let message?) = error as? AgentClientError, !message.isEmpty { return message }
        return Strings.proposalFailed
    }
}
#endif
