package com.slopus.happy.ui.chat

import android.content.res.Resources
import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.compose.ui.platform.LocalResources
import androidx.compose.ui.res.stringResource
import com.slopus.happy.R
import com.slopus.happy.model.SessionState
import com.slopus.happy.text.plural
import java.text.SimpleDateFormat
import java.util.Calendar
import java.util.Date
import java.util.Locale

/** sessionUtils.ts `vibingMessages`: shown, lowercased with "…", while the agent thinks. */
val VibingMessages = listOf(
    "Accomplishing", "Actioning", "Actualizing", "Baking", "Booping", "Brewing", "Calculating", "Cerebrating",
    "Channelling", "Churning", "Clauding", "Coalescing", "Cogitating", "Computing", "Combobulating", "Concocting",
    "Conjuring", "Considering", "Contemplating", "Cooking", "Crafting", "Creating", "Crunching", "Deciphering",
    "Deliberating", "Determining", "Discombobulating", "Divining", "Doing", "Effecting", "Elucidating", "Enchanting",
    "Envisioning", "Finagling", "Flibbertigibbeting", "Forging", "Forming", "Frolicking", "Generating", "Germinating",
    "Hatching", "Herding", "Honking", "Ideating", "Imagining", "Incubating", "Inferring", "Manifesting", "Marinating",
    "Meandering", "Moseying", "Mulling", "Mustering", "Musing", "Noodling", "Percolating", "Perusing", "Philosophising",
    "Pontificating", "Pondering", "Processing", "Puttering", "Puzzling", "Reticulating", "Ruminating", "Scheming",
    "Schlepping", "Shimmying", "Simmering", "Smooshing", "Spelunking", "Spinning", "Stewing", "Sussing", "Synthesizing",
    "Thinking", "Tinkering", "Transmuting", "Unfurling", "Unravelling", "Vibing", "Wandering", "Whirring", "Wibbling",
    "Wizarding", "Working", "Wrangling",
)

/**
 * `useSessionStatus` → AgentInput's `connectionStatus`: last seen (grey),
 * permission or input required (orange, pulsing), a vibing word while
 * thinking (blue, pulsing, a new word each time thinking starts), online
 * (green).
 */
@Composable
fun rememberComposerStatus(state: SessionState, activeAt: Long, now: Long = System.currentTimeMillis()): ComposerStatus {
    val resources = LocalResources.current
    val vibing = remember(state) { VibingMessages.random().lowercase() + "…" }
    return when (state) {
        SessionState.Disconnected -> ComposerStatus(
            stringResource(R.string.status_last_seen, formatLastSeen(resources, activeAt, now)),
            SessionStatusColors.disconnected,
            pulsing = false,
        )
        SessionState.PermissionRequired ->
            ComposerStatus(stringResource(R.string.status_permission_required), SessionStatusColors.attention, pulsing = true)
        SessionState.InputRequired ->
            ComposerStatus(stringResource(R.string.status_input_required), SessionStatusColors.attention, pulsing = true)
        SessionState.Thinking -> ComposerStatus(vibing, SessionStatusColors.thinking, pulsing = true)
        SessionState.Waiting -> ComposerStatus(stringResource(R.string.status_online), SessionStatusColors.online, pulsing = false)
    }
}

/** sessionUtils.ts `formatLastSeen` (not active): relative within a week, then a short date. */
fun formatLastSeen(resources: Resources, activeAt: Long, now: Long): String {
    val seconds = (now - activeAt) / 1000
    val minutes = seconds / 60
    val hours = minutes / 60
    val days = hours / 24
    return when {
        seconds < 60 -> resources.getString(R.string.time_just_now)
        minutes < 60 -> resources.plural(R.plurals.time_minutes_ago, minutes.toInt(), minutes.toInt())
        hours < 24 -> resources.plural(R.plurals.time_hours_ago, hours.toInt(), hours.toInt())
        days < 7 -> resources.plural(R.plurals.session_history_days_ago, days.toInt(), days.toInt())
        else -> {
            val date = Calendar.getInstance().apply { timeInMillis = activeAt }
            val thisYear = Calendar.getInstance().apply { timeInMillis = now }.get(Calendar.YEAR)
            val pattern = if (date.get(Calendar.YEAR) != thisYear) "MMM d, yyyy" else "MMM d"
            SimpleDateFormat(pattern, Locale.getDefault()).format(Date(activeAt))
        }
    }
}

/** EmptyMessages.tsx `formatRelativeTime`: just now, minutes, hours, then days. */
fun formatRelativeTime(resources: Resources, timestamp: Long, now: Long): String {
    val minutes = (now - timestamp) / 60_000
    val hours = minutes / 60
    val days = hours / 24
    return when {
        minutes < 1 -> resources.getString(R.string.time_just_now)
        minutes < 60 -> resources.plural(R.plurals.time_minutes_ago, minutes.toInt(), minutes.toInt())
        hours < 24 -> resources.plural(R.plurals.time_hours_ago, hours.toInt(), hours.toInt())
        else -> resources.plural(R.plurals.session_history_days_ago, days.toInt(), days.toInt())
    }
}
