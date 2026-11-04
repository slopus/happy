package com.slopus.happy.ui.documents

import android.text.format.Formatter
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.produceState
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalConfiguration
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.viewinterop.AndroidView
import com.slopus.happy.R
import com.slopus.happy.agent.AgentSession
import com.slopus.happy.documents.DocumentChange
import com.slopus.happy.documents.DocumentEditor
import com.slopus.happy.documents.DocumentReader
import com.slopus.happy.documents.DocumentRoutes
import com.slopus.happy.documents.yjs.YDoc
import com.slopus.happy.references.ReferenceReader
import com.slopus.happy.ui.artifacts.PlaceScaffold
import com.slopus.happy.ui.components.Icon
import com.slopus.happy.ui.components.Ionicon
import com.slopus.happy.ui.layout.LocalWindowLayout
import com.slopus.happy.ui.layout.contentMaxWidth
import com.slopus.happy.ui.theme.HappyTheme
import com.slopus.happy.ui.theme.happyTextStyle
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import java.text.DateFormat
import java.util.Date

/** iOS's `DocumentHistoryRowLayout.Metrics`: a 36 face, 16 in, 12 to the words, 10 above and below, 2 between the lines. */
object DocumentHistorySpec {
    val avatar = 36.dp
    val padding = 16.dp
    val vertical = 10.dp
    val gap = 12.dp
    val lineGap = 2.dp
}

object DocumentHistoryTags {
    const val SCREEN = "document.history"
    const val STATUS = "document.history.status"
    const val VERSION = "document.version"
    fun row(seq: Int) = "document.history.$seq"
}

/** What the history knows: the changes newest first (null until read, empty when there are none), and whether reading failed. */
internal class DocumentHistoryState(val changes: List<DocumentChange>?, val failed: Boolean, val names: Map<String, String>)

/**
 * A document's permanent change log (iOS's `DocumentHistoryViewController`),
 * newest first: who made each change, when, and how big it was; the newest
 * says it is the current version. Choosing one shows the document as it
 * stood right after it ([DocumentVersionScreen]).
 */
@Composable
fun DocumentHistoryScreen(session: AgentSession, surfaceId: String, onBack: () -> Unit, onVersion: (seq: Int, title: String) -> Unit) {
    val state by produceState(DocumentHistoryState(null, false, emptyMap()), session, surfaceId) {
        // Every page, newest last on the wire; a long log is a few of them.
        val all = ArrayList<DocumentChange>()
        var after = 0
        val read = try {
            while (true) {
                val (page, next) = DocumentRoutes.changes(session.client, surfaceId, afterSeq = after)
                all += page
                if (next == null || next <= after) break
                after = next
            }
            all.reversed()
        } catch (e: CancellationException) {
            throw e
        } catch (_: Exception) {
            if (all.isEmpty()) null else all.reversed()
        }
        value = DocumentHistoryState(read.orEmpty(), read == null, emptyMap())
        val ids = read.orEmpty().mapNotNull { it.actor.userId }.distinct()
        if (ids.isNotEmpty()) {
            val names = try { ReferenceReader.userNames(session.client, ids) } catch (e: CancellationException) { throw e } catch (_: Exception) { emptyMap() }
            value = DocumentHistoryState(value.changes, value.failed, names)
        }
    }
    DocumentHistoryPage(state, onBack) { change, author -> onVersion(change.seq, author) }
}

/** [DocumentHistoryScreen] without its reading, for the layout tests. */
@Composable
internal fun DocumentHistoryPage(state: DocumentHistoryState, onBack: () -> Unit, onPick: (DocumentChange, String) -> Unit) {
    val context = LocalContext.current
    val locale = LocalConfiguration.current.locales[0]
    val format = remember(locale) { DateFormat.getDateTimeInstance(DateFormat.MEDIUM, DateFormat.SHORT, locale) }
    val words = HistoryWords(
        conversion = stringResource(R.string.document_conversion),
        agent = stringResource(R.string.document_agent),
        someone = stringResource(R.string.document_someone),
        current = stringResource(R.string.document_current),
    )
    PlaceScaffold(stringResource(R.string.document_history), onBack, DocumentHistoryTags.SCREEN) {
        val changes = state.changes
        when {
            changes == null -> HistoryStatus(stringResource(R.string.common_loading))
            changes.isEmpty() -> HistoryStatus(stringResource(if (state.failed) R.string.document_unavailable else R.string.document_history_empty))
            else -> LazyColumn(Modifier.fillMaxSize().contentMaxWidth(LocalWindowLayout.current)) {
                items(changes, key = { it.seq }) { change ->
                    val author = words.author(change, state.names)
                    val time = if (change.createdAt > 0) format.format(Date(change.createdAt.toLong())) else ""
                    val extra = if (change === changes.first()) words.current else Formatter.formatShortFileSize(context, change.size.toLong())
                    val detail = listOf(time, extra).filter { it.isNotEmpty() }.joinToString(" · ")
                    HistoryRow(author, detail, change.actor.userId ?: change.actor.agentId ?: "agent", Modifier.testTag(DocumentHistoryTags.row(change.seq))) { onPick(change, author) }
                }
            }
        }
    }
}

internal class HistoryWords(val conversion: String, val agent: String, val someone: String, val current: String) {
    /** iOS's `author(_:)`: who made a change, as its row and its version's bar say it. */
    fun author(change: DocumentChange, names: Map<String, String>): String {
        if (change.source == "conversion") return conversion
        val name = change.actor.userId?.let { names[it] }?.takeIf { it.isNotEmpty() }
        if (name != null) return if (change.actor.agentId == null) name else "$name · $agent"
        if (change.actor.agentId != null || change.source == "tool") return agent
        return someone
    }
}

/** One change: the author's initial on their colour, their name over when and how big, and a chevron. */
@Composable
private fun HistoryRow(title: String, detail: String, seed: String, modifier: Modifier = Modifier, onClick: () -> Unit) {
    val colors = HappyTheme.colors
    Row(
        modifier
            .fillMaxWidth()
            .clickable(role = Role.Button, onClick = onClick)
            .semantics(mergeDescendants = true) { contentDescription = "$title, $detail" }
            .heightIn(min = DocumentHistorySpec.avatar + DocumentHistorySpec.vertical * 2)
            .padding(horizontal = DocumentHistorySpec.padding, vertical = DocumentHistorySpec.vertical),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Box(
            Modifier.size(DocumentHistorySpec.avatar).clip(CircleShape).background(peerColor(seed)),
            contentAlignment = Alignment.Center,
        ) {
            Text(title.take(1).uppercase(), style = happyTextStyle(fontSize = 15, lineHeight = 20, weight = FontWeight.SemiBold), color = Color.White)
        }
        Spacer(Modifier.width(DocumentHistorySpec.gap))
        Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(DocumentHistorySpec.lineGap)) {
            Text(title, style = happyTextStyle(fontSize = 17, lineHeight = 22), color = colors.text)
            Text(detail, style = happyTextStyle(fontSize = 13, lineHeight = 18), color = colors.textSecondary)
        }
        Icon(Ionicon.ChevronForward, 16.dp, colors.textSecondary)
    }
}

private fun peerColor(seed: String): Color = Color(android.graphics.Color.parseColor(DocumentHolder.peerColor(seed)))

@Composable
private fun HistoryStatus(text: String) {
    Box(Modifier.fillMaxSize().padding(horizontal = 16.dp), contentAlignment = Alignment.Center) {
        Text(
            text,
            style = happyTextStyle(fontSize = 15, lineHeight = 20),
            color = HappyTheme.colors.textSecondary,
            textAlign = TextAlign.Center,
            modifier = Modifier.testTag(DocumentHistoryTags.STATUS),
        )
    }
}

/**
 * The document as it stood right after change [seq], read-only (iOS's
 * `DocumentVersionViewController`): "Version N" over who made it, the
 * text read and drawn off the main thread once, on the editor's keylines.
 */
@Composable
fun DocumentVersionScreen(session: AgentSession, surfaceId: String, seq: Int, title: String, onBack: () -> Unit) {
    val context = LocalContext.current
    val dark = HappyTheme.colors.dark
    val labels = DocumentStyle.Labels(
        picture = stringResource(R.string.document_picture),
        table = stringResource(R.string.document_table),
        unsupported = stringResource(R.string.document_unsupported),
        divider = stringResource(R.string.document_divider),
    )
    var failed by remember { mutableStateOf(false) }
    var text by remember { mutableStateOf<CharSequence?>(null) }
    LaunchedEffect(session, surfaceId, seq, dark) {
        val style = DocumentStyle(context.resources, dark, labels)
        text = try {
            withContext(Dispatchers.Default) {
                val state = DocumentRoutes.state(session.client, surfaceId, seq = seq)
                val doc = YDoc()
                doc.applyUpdate(state.update)
                style.document(DocumentEditor.flatten(DocumentReader.blocks(doc)))
            }
        } catch (e: CancellationException) {
            throw e
        } catch (_: Exception) {
            failed = true
            null
        }
    }
    PlaceScaffold(stringResource(R.string.document_version, seq), onBack, DocumentHistoryTags.VERSION, subtitle = title) {
        val shown = text
        when {
            shown != null -> BoxWithConstraints(Modifier.fillMaxSize()) {
                val side = keyline(maxWidth)
                val density = LocalDensity.current
                AndroidView(
                    factory = { DocumentTextView(it).apply { isFocusable = false; isCursorVisible = false; showSoftInputOnFocus = false } },
                    update = { view ->
                        with(density) { view.setPadding(side.roundToPx(), DocumentScreenSpec.top.roundToPx(), side.roundToPx(), DocumentScreenSpec.bottom.roundToPx()) }
                        view.setTextColor(DocumentTokens.text.of(dark))
                        if (view.text !== shown) view.setText(shown, android.widget.TextView.BufferType.SPANNABLE)
                    },
                    modifier = Modifier.fillMaxSize().testTag(DocumentScreenTags.TEXT),
                )
            }
            failed -> HistoryStatus(stringResource(R.string.document_unavailable))
            else -> HistoryStatus(stringResource(R.string.common_loading))
        }
    }
}
