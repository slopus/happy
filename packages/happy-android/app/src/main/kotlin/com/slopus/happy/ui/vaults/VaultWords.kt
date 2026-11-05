package com.slopus.happy.ui.vaults

import android.text.format.DateUtils
import android.text.format.Formatter
import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.stringResource
import com.slopus.happy.R
import com.slopus.happy.ui.theme.happyTextStyle
import com.slopus.happy.vaults.VaultActor
import com.slopus.happy.vaults.VaultItem

/** The vault screens' type: a row's name and its line under it. */
internal object VaultText {
    val name = happyTextStyle(fontSize = 16, lineHeight = 20)
    val meta = happyTextStyle(fontSize = 13, lineHeight = 17)
}

/** [bytes] as the phone writes sizes ("1.2 MB"). */
@Composable
internal fun vaultSize(bytes: Long): String {
    val context = LocalContext.current
    return remember(bytes) { Formatter.formatShortFileSize(context, bytes) }
}

/** How much of [total] has gone: "1.2 MB of 8.4 MB", or what has gone alone when the whole isn't known. */
@Composable
internal fun vaultBytes(sent: Long, total: Long?): String =
    if (total != null && total > 0) stringResource(R.string.vaults_bytes_of, vaultSize(sent), vaultSize(total)) else vaultSize(sent)

/** When something happened, as a short date or a time today. */
@Composable
internal fun vaultTime(at: Long): String {
    val context = LocalContext.current
    return remember(at) {
        if (at <= 0) "" else DateUtils.formatDateTime(
            context, at,
            if (DateUtils.isToday(at)) DateUtils.FORMAT_SHOW_TIME else DateUtils.FORMAT_SHOW_DATE or DateUtils.FORMAT_ABBREV_MONTH,
        )
    }
}

/** When something happened, its date and time. */
@Composable
internal fun vaultDateTime(at: Long): String {
    val context = LocalContext.current
    return remember(at) {
        if (at <= 0) "" else DateUtils.formatDateTime(context, at, DateUtils.FORMAT_SHOW_DATE or DateUtils.FORMAT_SHOW_TIME or DateUtils.FORMAT_ABBREV_MONTH or DateUtils.FORMAT_SHOW_YEAR)
    }
}

/** A row's line: "Folder", a site's kind and size, or a file's size and when it changed. */
@Composable
internal fun vaultItemDetail(entry: VaultItem): String {
    val time = vaultTime(entry.updatedAt)
    val parts = when {
        entry.isFolder -> listOf(stringResource(R.string.vaults_folder))
        entry.isArtifact -> listOf(
            stringResource(if (entry.artifact?.type == "markdown") R.string.vaults_markdown_site else R.string.vaults_web_page),
            vaultSize(entry.size ?: 0),
            time,
        )
        else -> listOf(vaultSize(entry.size ?: 0), time)
    }
    return parts.filter { it.isNotEmpty() }.joinToString(" · ")
}

/** Who made a change: a person's name, with "via agent" when an agent made it for them; an agent; or someone. */
@Composable
internal fun vaultActor(actor: VaultActor, names: Map<String, String>, agents: Map<String, String>): String {
    val person = actor.userId?.let { names[it] }?.takeIf { it.isNotEmpty() }
    val agent = actor.agentId?.let { agents[it] }?.takeIf { it.isNotEmpty() } ?: actor.agentId?.let { stringResource(R.string.vaults_an_agent) }
    return when {
        person != null && agent != null -> stringResource(R.string.vaults_actor_via, person, agent)
        person != null -> person
        agent != null -> agent
        else -> stringResource(R.string.vaults_someone)
    }
}
