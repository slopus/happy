package com.slopus.happy.model

import com.slopus.happy.R
import com.slopus.happy.text.Words
import androidx.compose.runtime.Immutable

// The name a new bot goes by (utils/botName.ts). It wears no face of its
// own: like every bot without a picture, the placeholder its ID picks.

/** The daemon's ceiling on a bot's name (Happy Agent's `botNameSchema`). */
const val BOT_NAME_MAX_LENGTH = 256

private val CONTROL_CHARACTERS = Regex("[\\x00-\\x1f\\x7f]")

/** sanitizeBotName: a pasted line break or tab becomes a space, and the ceiling is kept. */
fun sanitizeBotName(input: String): String = input.replace(CONTROL_CHARACTERS, " ").take(BOT_NAME_MAX_LENGTH)

/** isValidBotName: nonblank once trimmed, within the ceiling, no control characters. */
fun isValidBotName(name: String): Boolean = describeBotNameProblem(name) == null

/** describeBotNameProblem: why the daemon would refuse [name], in the person's words; null when it's fine. */
fun describeBotNameProblem(name: String): Words? {
    val trimmed = name.trim()
    return when {
        trimmed.isEmpty() -> Words.ours(R.string.home_bot_name_empty)
        trimmed.length > BOT_NAME_MAX_LENGTH -> Words.ours(R.string.home_bot_name_too_long, BOT_NAME_MAX_LENGTH)
        CONTROL_CHARACTERS.containsMatchIn(trimmed) -> Words.ours(R.string.home_bot_name_control)
        else -> null
    }
}

/**
 * useNewSessionDraft's bot fields: whether the composer makes a bot, and
 * its name. Memory only: a restarted app offers a session, the ordinary
 * case.
 */
@Immutable
data class BotDraft(
    val creating: Boolean = false,
    val name: String = "",
)

/** What a bot start asks for: its name, trimmed. */
data class BotRequest(val name: String)
