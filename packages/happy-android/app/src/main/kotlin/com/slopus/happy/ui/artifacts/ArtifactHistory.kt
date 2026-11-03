package com.slopus.happy.ui.artifacts

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.rememberModalBottomSheetState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.Stable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.key
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalConfiguration
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import com.slopus.happy.R
import com.slopus.happy.artifacts.ArtifactVersion
import com.slopus.happy.ui.cards.CardListSpec
import com.slopus.happy.ui.components.Icon
import com.slopus.happy.ui.components.Ionicon
import com.slopus.happy.ui.components.LoadingIndicator
import com.slopus.happy.ui.theme.HappyTheme
import com.slopus.happy.ui.theme.happyTextStyle
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.launch
import java.text.DateFormat
import java.util.Date

object ArtifactHistoryTags {
    const val ACTION = "artifact.history"
    const val SHEET = "artifact.history.sheet"
    const val ROW = "artifact.history.row"
    const val BANNER = "artifact.history.banner"
    const val LATEST = "artifact.history.latest"
    const val MORE = "artifact.history.more"
}

/**
 * An artifact's versions on its screen (desktop e73f2095,
 * HappyAgentArtifactViewer's History and ArtifactOlder banner): the
 * version shown, the latest, and how to read the list a page at a time.
 */
@Stable
class ArtifactHistory(
    /** The version on screen. */
    val shown: ArtifactVersion,
    /** The newest version's number, once known. */
    val latest: Int?,
    /** One page of versions, newest first, and the next page's cursor. */
    val read: suspend (pageCursor: String?) -> Pair<List<ArtifactVersion>, String?>,
    /** Shows version [number] in this screen's place. */
    val onPick: (number: Int) -> Unit,
    /** Shows the latest version, following it. */
    val onLatest: () -> Unit,
) {
    /** An older version is on screen. */
    val older: Boolean get() = latest != null && shown.number < latest

    /** There is more than one version to choose from. */
    val hasVersions: Boolean get() = (latest ?: shown.number) > 1
}

/** "Showing version N" over an older version, with Show latest (desktop's ArtifactOlder). */
@Composable
internal fun ArtifactOlderBanner(history: ArtifactHistory) {
    val colors = HappyTheme.colors
    Row(
        Modifier
            .fillMaxWidth()
            .background(colors.surfaceHigh)
            .padding(start = 16.dp, end = 4.dp)
            .heightIn(min = 48.dp)
            .testTag(ArtifactHistoryTags.BANNER),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Icon(Ionicon.TimeOutline, 18.dp, colors.textSecondary)
        Text(
            stringResource(R.string.artifact_history_showing, history.shown.label),
            style = happyTextStyle(fontSize = 15, lineHeight = 20),
            color = colors.text,
            modifier = Modifier.weight(1f).padding(horizontal = 10.dp),
        )
        TextButton(onClick = history.onLatest, modifier = Modifier.testTag(ArtifactHistoryTags.LATEST)) {
            Text(stringResource(R.string.artifact_history_show_latest), style = happyTextStyle(fontSize = 15, lineHeight = 20, weight = FontWeight.Medium))
        }
    }
}

/**
 * The versions, newest first, in a sheet (Telegram's
 * BottomSheetWithRecyclerListView): each its label, when it was made, the
 * latest marked, the one on screen checked; Load more reads the next page
 * of 50. A tap shows that version and closes the sheet.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
internal fun ArtifactHistorySheet(history: ArtifactHistory, onDismiss: () -> Unit) {
    val colors = HappyTheme.colors
    val sheet = rememberModalBottomSheetState(skipPartiallyExpanded = true)
    val scope = rememberCoroutineScope()
    val locale = LocalConfiguration.current.locales[0]
    val format = remember(locale) { DateFormat.getDateTimeInstance(DateFormat.MEDIUM, DateFormat.SHORT, locale) }
    var versions by remember { mutableStateOf<List<ArtifactVersion>>(emptyList()) }
    var cursor by remember { mutableStateOf<String?>(null) }
    var done by remember { mutableStateOf(false) }
    var failed by remember { mutableStateOf(false) }
    var reading by remember { mutableStateOf(false) }
    suspend fun more() {
        if (reading || done) return
        reading = true
        failed = false
        try {
            val (page, next) = history.read(cursor)
            versions = (versions + page).distinctBy { it.number }
            cursor = next
            done = next == null || page.isEmpty()
        } catch (e: CancellationException) {
            throw e
        } catch (_: Exception) {
            failed = true
        } finally {
            reading = false
        }
    }
    LaunchedEffect(history.read) { more() }
    ModalBottomSheet(onDismissRequest = onDismiss, sheetState = sheet, containerColor = colors.surface, modifier = Modifier.testTag(ArtifactHistoryTags.SHEET)) {
        Column(Modifier.fillMaxWidth().navigationBarsPadding().padding(bottom = 8.dp)) {
            Text(
                stringResource(R.string.artifact_history),
                style = happyTextStyle(fontSize = 17, lineHeight = 22, weight = FontWeight.SemiBold),
                color = colors.text,
                modifier = Modifier.padding(horizontal = 24.dp).padding(bottom = 8.dp),
            )
            Column(Modifier.fillMaxWidth().verticalScroll(rememberScrollState())) {
                versions.forEach { version ->
                    key(version.number) {
                        VersionRow(
                            version,
                            if (version.createdAt > 0) format.format(Date(version.createdAt)) else "",
                            latest = version.number == (history.latest ?: versions.first().number),
                            shown = version.number == history.shown.number,
                        ) {
                            scope.launch {
                                sheet.hide()
                                onDismiss()
                                if (version.number != history.shown.number) history.onPick(version.number)
                            }
                        }
                    }
                }
                when {
                    reading -> Box(Modifier.fillMaxWidth().padding(16.dp), contentAlignment = Alignment.Center) { LoadingIndicator() }
                    failed -> Column(Modifier.fillMaxWidth().padding(16.dp), horizontalAlignment = Alignment.CenterHorizontally) {
                        Text(stringResource(R.string.artifact_history_failed), style = happyTextStyle(fontSize = 15, lineHeight = 20), color = colors.textSecondary)
                        TextButton(onClick = { scope.launch { more() } }) { Text(stringResource(R.string.common_retry)) }
                    }
                    !done -> TextButton(onClick = { scope.launch { more() } }, modifier = Modifier.padding(horizontal = 12.dp).testTag(ArtifactHistoryTags.MORE)) {
                        Text(stringResource(R.string.common_load_more))
                    }
                }
            }
        }
    }
}

@Composable
private fun VersionRow(version: ArtifactVersion, time: String, latest: Boolean, shown: Boolean, onClick: () -> Unit) {
    val colors = HappyTheme.colors
    Row(
        Modifier
            .fillMaxWidth()
            .clickable(onClick = onClick)
            .heightIn(min = CardListSpec.tiledRow)
            .padding(horizontal = 24.dp, vertical = CardListSpec.padding)
            .testTag(ArtifactHistoryTags.ROW),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(CardListSpec.lineGap)) {
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                Text(stringResource(R.string.artifact_history_version, version.label), style = CardListSpec.title, color = colors.text)
                if (latest) Text(stringResource(R.string.artifact_history_latest), style = CardListSpec.subtitle, color = colors.textSecondary)
            }
            if (time.isNotEmpty()) Text(time, style = CardListSpec.subtitle, color = colors.textSecondary)
        }
        if (shown) Icon(Ionicon.Checkmark, 22.dp, colors.text)
    }
}
