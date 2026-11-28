package com.slopus.happy.model

import androidx.compose.runtime.Immutable

/**
 * Filter chips on the home screen:
 * - [All]: all chats and project hierarchies
 * - [Bots]: only Bot chats
 * - [Tasks]: only Task chats
 * - [Projects]: only Projects and Worktrees
 * - [Unread]: only chats with unread messages
 */
@Immutable
enum class HomeFilter(val wire: String) {
    All("all"),
    Bots("bots"),
    Tasks("tasks"),
    Projects("projects"),
    Unread("unread");

    companion object {
        fun fromWire(wire: String?): HomeFilter =
            entries.firstOrNull { it.wire == wire } ?: All
    }
}
