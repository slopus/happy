package com.slopus.happy.ui.vaults

import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.withStyle
import androidx.compose.ui.unit.dp
import com.slopus.happy.R
import com.slopus.happy.agent.AgentSession
import com.slopus.happy.conversation.Conversation
import com.slopus.happy.conversation.Problem
import com.slopus.happy.ui.artifacts.PlaceMessage
import com.slopus.happy.ui.artifacts.PlaceScaffold
import com.slopus.happy.ui.components.Ionicon
import com.slopus.happy.ui.components.LoadingIndicator
import com.slopus.happy.ui.components.barInsetTop
import com.slopus.happy.ui.connection.AgentSearchField
import com.slopus.happy.ui.connection.AgentTopBar
import com.slopus.happy.ui.connection.BarIconButton
import com.slopus.happy.ui.conversation.problemText
import com.slopus.happy.ui.layout.LocalWindowLayout
import com.slopus.happy.ui.layout.contentMaxWidth
import com.slopus.happy.ui.theme.HappyTheme
import com.slopus.happy.ui.theme.happyTextStyle
import com.slopus.happy.vaults.VaultItem
import com.slopus.happy.vaults.VaultEvent
import com.slopus.happy.vaults.VaultPreview
import com.slopus.happy.vaults.VaultSearchResult
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.filter

object VaultSearchTags {
    const val SCREEN = "vault.search.screen"
    const val BAR = "vault.search.bar"
    const val CLEAR = "vault.search.clear"
    const val NAMES = "vault.search.names"
    const val CONTENTS = "vault.search.contents"
    const val NOTHING = "vault.search.nothing"
}

/** What a search found: name matches, then text matches, and whether there are more. */
private data class Found(val query: String, val names: List<VaultSearchResult>, val contents: List<VaultSearchResult>, val truncated: Boolean)

/**
 * Search across a vault: the bar becomes the field. Names match first
 * (a name equal to what is typed, then starting with it, then containing
 * it, then paths), then text inside files and sites, each with the line
 * that matched and the words around it, the match in bold. It asks once
 * typing pauses, and again as the vault changes while it is open. A
 * result opens where its entry opens.
 */
@Composable
fun VaultSearchScreen(session: AgentSession, surfaceId: String, onBack: () -> Unit, open: (Any) -> Unit) {
    var query by rememberSaveable { mutableStateOf("") }
    var found by remember { mutableStateOf<Found?>(null) }
    var failed by remember { mutableStateOf<Problem?>(null) }
    var searching by remember { mutableStateOf(false) }
    var changes by remember { mutableStateOf(0) }
    var viewing by remember { mutableStateOf<VaultItem?>(null) }
    val actions = rememberVaultActions(session, surfaceId, open)
    LaunchedEffect(session, surfaceId) {
        session.vaults.events.filter { it.surfaceId == surfaceId || it == VaultEvent.Resync }.collect { changes += 1 }
    }
    LaunchedEffect(query, changes) {
        val text = query.trim()
        if (text.isEmpty()) {
            found = null
            searching = false
            return@LaunchedEffect
        }
        delay(if (changes > 0 && found?.query == text) CHANGE_DELAY_MS else TYPING_DELAY_MS)
        searching = true
        try {
            val (results, truncated) = session.vaults.routes.search(surfaceId, text.take(256))
            found = Found(text, results.filter { it.match == VaultSearchResult.NAME }, results.filter { it.match == VaultSearchResult.CONTENT }, truncated)
            failed = null
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            failed = Conversation.describe(e)
        } finally {
            searching = false
        }
    }
    val openEntry: (VaultSearchResult) -> Unit = { result ->
        val entry = result.item
        when {
            entry.isFolder -> open(VaultFolderRoute(session.connectionId, surfaceId, entry.id, entry.name))
            VaultPreview.inViewer(entry) -> viewing = entry
            else -> open(VaultFileRoute(session.connectionId, surfaceId, entry.id, name = entry.name))
        }
    }
    val placeholder = stringResource(R.string.vaults_search_placeholder)
    PlaceScaffold(
        title = placeholder,
        onBack = onBack,
        tag = VaultSearchTags.SCREEN,
        bar = {
            AgentTopBar(
                tag = VaultSearchTags.BAR,
                container = HappyTheme.colors.surface,
                navigationIcon = { BarIconButton(Ionicon.ArrowBack, stringResource(R.string.common_back), onBack) },
                title = { AgentSearchField(query, { query = it }, placeholder = placeholder) },
                actions = { if (query.isNotEmpty()) BarIconButton(Ionicon.Close, stringResource(R.string.agent_search_clear), { query = "" }, Modifier.testTag(VaultSearchTags.CLEAR)) },
            )
        },
    ) {
        val shown = found
        when {
            query.isBlank() -> Column(Modifier.padding(top = barInsetTop())) { PlaceMessage(stringResource(R.string.vaults_search_hint)) }
            shown == null && failed != null -> Column(Modifier.padding(top = barInsetTop())) { PlaceMessage(problemText(failed!!)) }
            shown == null -> LoadingIndicator()
            shown.names.isEmpty() && shown.contents.isEmpty() -> Column(Modifier.padding(top = barInsetTop())) {
                PlaceMessage(stringResource(R.string.vaults_search_nothing, shown.query), Modifier.testTag(VaultSearchTags.NOTHING))
            }
            else -> LazyColumn(Modifier.fillMaxSize().imePadding(), contentPadding = PaddingValues(top = barInsetTop(), bottom = 32.dp)) {
                if (shown.names.isNotEmpty()) {
                    item(key = "names") { Heading(stringResource(R.string.vaults_search_names), VaultSearchTags.NAMES) }
                    items(shown.names, key = { "n-${it.item.id}" }) { result ->
                        VaultItemRow(result.item, last = result === shown.names.last(), actions = actions, detail = where(result.path), onClick = { openEntry(result) })
                    }
                }
                if (shown.contents.isNotEmpty()) {
                    item(key = "contents") { Heading(stringResource(R.string.vaults_search_contents), VaultSearchTags.CONTENTS) }
                    items(shown.contents, key = { "c-${it.item.id}-${it.innerPath}" }) { result ->
                        val place = listOfNotNull(result.path + (result.innerPath?.let { "/$it" } ?: ""), result.line?.let { stringResource(R.string.vaults_line, it) }).joinToString(" · ")
                        Column {
                            VaultItemRow(result.item, last = result === shown.contents.last(), actions = actions, detail = place, onClick = { openEntry(result) })
                            result.snippet?.let { Snippet(highlight(it, shown.query)) }
                        }
                    }
                }
                if (shown.truncated) item(key = "more") { PlaceMessage(stringResource(R.string.vaults_search_more)) }
            }
        }
        if (searching && shown != null) LoadingIndicator(Modifier.padding(top = barInsetTop()))
    }
    viewing?.let { VaultMediaViewer(session, listOf(it), 0) { viewing = null } }
    VaultActionsHost(actions)
}

private const val TYPING_DELAY_MS = 250L
private const val CHANGE_DELAY_MS = 400L

/** The folder a result is in. */
private fun where(path: String): String = path.substringBeforeLast('/').ifEmpty { "/" }

@Composable
private fun Heading(text: String, tag: String) {
    Text(
        text.uppercase(),
        style = happyTextStyle(fontSize = 13, lineHeight = 18, weight = FontWeight.Medium),
        color = HappyTheme.colors.textSecondary,
        modifier = Modifier.contentMaxWidth(LocalWindowLayout.current).fillMaxWidth().padding(start = 16.dp, end = 16.dp, top = 16.dp, bottom = 6.dp).semantics { heading() }.testTag(tag),
    )
}

/** The words around a text match, under its row and level with its name. */
@Composable
private fun Snippet(text: AnnotatedString) {
    Text(
        text,
        style = happyTextStyle(fontSize = 13, lineHeight = 18),
        color = HappyTheme.colors.textSecondary,
        maxLines = 3,
        modifier = Modifier.contentMaxWidth(LocalWindowLayout.current).fillMaxWidth().padding(start = VaultRowSpec.textX, end = 16.dp, bottom = 10.dp),
    )
}

/** [snippet] with every case-insensitive [query] in it bold. */
internal fun highlight(snippet: String, query: String): AnnotatedString = buildAnnotatedString {
    val text = snippet.replace('\n', ' ')
    if (query.isEmpty()) {
        append(text)
        return@buildAnnotatedString
    }
    var at = 0
    while (at < text.length) {
        val hit = text.indexOf(query, at, ignoreCase = true)
        if (hit < 0) break
        append(text.substring(at, hit))
        withStyle(SpanStyle(fontWeight = FontWeight.SemiBold)) { append(text.substring(hit, hit + query.length)) }
        at = hit + query.length
    }
    append(text.substring(at))
}
