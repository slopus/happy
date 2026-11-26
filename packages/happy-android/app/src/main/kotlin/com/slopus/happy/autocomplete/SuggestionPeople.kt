package com.slopus.happy.autocomplete

import com.slopus.happy.agent.HappyLink
import com.slopus.happy.agent.HappyReferenceKind
import com.slopus.happy.agent.HappyUrls
import com.slopus.happy.agent.TeamUser
import com.slopus.happy.references.HappyMarkdownLinks
import com.slopus.happy.references.HappyReferences

/** happyAgentMentionPlaces.ts `MENTION_PLACES_LIMIT`: one `@` word offers at most this many people. */
const val PEOPLE_LIMIT = 5

/**
 * The people an `@` word names, as desktop's happyAgentMentionPlaces.ts
 * offers them: the team in its own (name) order, [self] left out, each
 * whose name holds [query] in any letter case, at most [limit]. A blank
 * query offers the first of them.
 */
fun searchPeople(people: Collection<TeamUser>, query: String, self: String?, limit: Int = PEOPLE_LIMIT): List<TeamUser> {
    val needle = query.trim().lowercase()
    return people.asSequence()
        .filter { it.id != self && it.name.isNotBlank() && it.name.lowercase().contains(needle) }
        .take(limit)
        .toList()
}

/**
 * How the draft names [user]: `[Name](happy://users/<id>)`, the reference
 * agents write and every client reads as "@Name", labelled with the name so
 * it reads on any surface that can't look it up. In a task's chat, sending it
 * brings them in (API.md, "Mentioning from a message"). Null for an ID the
 * grammar can't carry.
 */
fun mentionMarkdown(user: TeamUser): String? {
    val url = runCatching { HappyUrls.format(HappyLink.Reference(HappyReferenceKind.User, user.id)) }.getOrNull() ?: return null
    val label = HappyReferences.label(user.name)
    return if (label.isEmpty()) null else "[$label]($url)"
}

/** A person's mention in a draft: [start] to [end] of its Markdown, shown as [shown] ("@Name"). */
data class DraftMention(val start: Int, val end: Int, val shown: String)

/**
 * The people [draft] mentions, as the composer shows them (desktop's
 * composerDraftParse for a person): each labelled `happy://users/…` link is
 * "@" and its label, everything else stays as written. A link with no words
 * is left as its Markdown.
 */
fun draftMentions(draft: String): List<DraftMention> {
    if (!draft.contains("happy:", ignoreCase = true)) return emptyList()
    return HappyMarkdownLinks.matches(draft).mapNotNull { match ->
        if (match.image || !HappyReferences.mention(match.url)) return@mapNotNull null
        val name = HappyReferences.label(match.label).removePrefix("@")
        if (name.isEmpty()) null else DraftMention(match.start, match.end, "@$name")
    }
}

/** [draft] as the composer shows it: each mention as its "@Name" ([draftMentions]). */
fun shownDraft(draft: String): String {
    val mentions = draftMentions(draft)
    if (mentions.isEmpty()) return draft
    return buildString(draft.length) {
        var at = 0
        for (mention in mentions) {
            append(draft, at, mention.start)
            append(mention.shown)
            at = mention.end
        }
        append(draft, at, draft.length)
    }
}
