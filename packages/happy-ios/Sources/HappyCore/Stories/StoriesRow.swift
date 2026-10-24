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
    /// The blue "+" at the bottom right: always on My Story.
    public var showsPlus: Bool

    /// Everything in its circle is seen: a grey ring, the name dimmed.
    public var allSeen: Bool { segments > 0 && unseen == 0 }
}

/// The row from the feed, in the daemon's order. My Story is always first,
/// even before the feed has been read.
public enum StoriesRow {
    public static func items(_ feed: StoryFeed?, myStory: String) -> [StoriesRowItem] {
        let authors = feed?.authors ?? []
        var items: [StoriesRowItem] = []
        if let me = authors.first(where: \.isSelf) {
            items.append(item(me, myStory: myStory))
        } else {
            items.append(StoriesRowItem(id: "self", title: myStory, isSelf: true, photo: nil, thumbhash: nil, initials: "", segments: 0, unseen: 0, showsPlus: true))
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
            segments: author.storyIds.count, unseen: author.isSelf ? 0 : min(author.unseenCount, author.storyIds.count),
            showsPlus: author.isSelf
        )
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
