import Foundation

/// One circle of the stories row, as it is drawn.
public struct StoriesRowItem: Equatable, Sendable, Identifiable {
    public var id: String
    /// "My Story", or the author's first name.
    public var title: String
    public var isSelf: Bool
    /// A daemon-relative path, read with the same bearer token.
    public var photo: String?
    public var thumbhash: String?
    /// Drawn without a photo.
    public var initials: String
    /// One ring segment per story, the unseen ones last and coloured.
    public var segments: Int
    public var unseen: Int

    /// Everything in its circle is seen: a grey ring, the name dimmed.
    public var allSeen: Bool { segments > 0 && unseen == 0 }
}

/// The row from the feed, in the daemon's order: the person's own stories
/// first when they have any, then everyone with a story. Nothing here makes
/// a story; that happens in a conversation.
public enum StoriesRow {
    public static func items(_ feed: StoryFeed?, myStory: String) -> [StoriesRowItem] {
        let authors = feed?.authors ?? []
        var items: [StoriesRowItem] = []
        if let me = authors.first(where: \.isSelf), !me.storyIds.isEmpty {
            items.append(item(me, myStory: myStory))
        }
        var keys: Set<String> = ["self"]
        for author in authors where !author.isSelf && !author.storyIds.isEmpty && keys.insert(author.key).inserted {
            items.append(item(author, myStory: myStory))
        }
        return items
    }

    static func item(_ author: StoryFeedAuthor, myStory: String) -> StoriesRowItem {
        StoriesRowItem(
            id: author.key, title: author.isSelf ? myStory : firstName(author.name), isSelf: author.isSelf,
            photo: author.photo, thumbhash: author.thumbhash, initials: initials(author.name),
            segments: author.storyIds.count, unseen: author.isSelf ? 0 : min(author.unseenCount, author.storyIds.count)
        )
    }

    /// The first circle that closes into the title: the person's own is
    /// left out, as it never has anything new.
    public static func collapseStart(_ items: [StoriesRowItem]) -> Int {
        items.first?.isSelf == true ? 1 : 0
    }

    /// Something in the row is still to be seen.
    public static func hasUnseen(_ items: [StoriesRowItem]) -> Bool {
        items.contains { $0.unseen > 0 }
    }

    /// When the newest story in the row was posted, as the daemon dates it:
    /// what putting the row away remembers. `stories` are those known
    /// besides the feed's own.
    public static func newest(_ feed: StoryFeed?, stories: [String: Story] = [:]) -> Int64 {
        (feed?.authors ?? []).compactMap { latest($0, feed, stories) }.max() ?? 0
    }

    /// The row starts open as home first shows it when it has something to
    /// look at (someone else's unseen story, or the person's own) and was
    /// never put away, or something of that was posted since it last was.
    public static func opensAtLaunch(_ feed: StoryFeed?, stories: [String: Story] = [:], putAwayThrough: Int64?) -> Bool {
        let showing = (feed?.authors ?? []).filter { !$0.storyIds.isEmpty && ($0.isSelf || $0.unseenCount > 0) }
        guard let putAwayThrough else { return !showing.isEmpty }
        return showing.contains { (latest($0, feed, stories) ?? 0) > putAwayThrough }
    }

    /// An author's newest posted story: the newest of the stories known,
    /// else the feed's own date (which a deletion leaves stale until the
    /// feed is read again).
    private static func latest(_ author: StoryFeedAuthor, _ feed: StoryFeed?, _ stories: [String: Story]) -> Int64? {
        guard !author.storyIds.isEmpty else { return nil }
        let posted = author.storyIds.compactMap { (feed?.stories[$0] ?? stories[$0])?.postedAt }
        return posted.max() ?? author.latestPostedAt
    }

    public static func firstName(_ name: String) -> String {
        let trimmed = name.trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmed.split(whereSeparator: \.isWhitespace).first.map(String.init) ?? trimmed
    }

    /// Up to two letters: the first of the first and last words.
    public static func initials(_ name: String) -> String {
        let words = name.split(whereSeparator: \.isWhitespace)
        let letters = [words.first, words.count > 1 ? words.last : nil].compactMap { $0?.first }
        return String(letters).uppercased()
    }

    /// Where the viewer opens on an author: their first unseen story, or
    /// their first when all are seen.
    public static func start(_ author: StoryFeedAuthor, stories: [String: Story]) -> Int {
        author.storyIds.firstIndex { stories[$0]?.seen == false } ?? 0
    }
}
