package com.slopus.happy.ui.vaults

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.widthIn
import androidx.compose.material3.IconButton
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.key
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.lifecycle.ViewModel
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.viewModelScope
import androidx.lifecycle.viewmodel.compose.viewModel
import com.slopus.happy.R
import com.slopus.happy.agent.AgentApiException
import com.slopus.happy.agent.AgentSession
import com.slopus.happy.browser.BrowserProxy
import com.slopus.happy.browser.browserWorkspace
import com.slopus.happy.conversation.Conversation
import com.slopus.happy.conversation.MediaFiles
import com.slopus.happy.ui.artifacts.PlaceScaffold
import com.slopus.happy.ui.browser.BrowserPage
import com.slopus.happy.ui.browser.BrowserView
import com.slopus.happy.ui.browser.rememberBrowserState
import com.slopus.happy.ui.components.Icon
import com.slopus.happy.ui.components.Ionicon
import com.slopus.happy.ui.components.LoadingIndicator
import com.slopus.happy.ui.components.RoundButton
import com.slopus.happy.ui.components.RoundButtonDisplay
import com.slopus.happy.ui.components.RoundButtonSize
import com.slopus.happy.ui.conversation.problemText
import com.slopus.happy.ui.files.FileLoad
import com.slopus.happy.ui.files.FileScreen
import com.slopus.happy.ui.files.fileLoadOf
import com.slopus.happy.ui.surfaces.SeedlingEmpty
import com.slopus.happy.ui.theme.HappyTheme
import com.slopus.happy.ui.theme.happyTextStyle
import com.slopus.happy.vaults.VaultDownloads
import com.slopus.happy.vaults.VaultItem
import com.slopus.happy.vaults.VaultEvent
import com.slopus.happy.vaults.VaultLocation
import com.slopus.happy.vaults.VaultPreview
import com.slopus.happy.vaults.VaultPreviewKind
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import java.io.File

object VaultFileTags {
    const val SCREEN = "vault.file"
    const val SHARE = "vault.file.share"
    const val OTHER = "vault.file.other"
    const val PLAY = "vault.file.play"
}

/** What a shown entry is, and what of it is read: nothing yet, its text, its PDF on the phone. */
internal class VaultFileModel(val session: AgentSession, val surfaceId: String, val itemId: String, val version: Int?, private val cache: File) : ViewModel() {
    sealed interface Body {
        data object Reading : Body
        data class Text(val load: FileLoad, val bytes: ByteArray?) : Body
        data class Pdf(val file: File) : Body
        /** A site, a recording or anything else: drawn from the entry alone. */
        data object Entry : Body
        data class Failed(val problem: com.slopus.happy.conversation.Problem) : Body
    }

    data class State(val location: VaultLocation? = null, val body: Body = Body.Reading, val gone: Boolean = false)

    private val stateFlow = MutableStateFlow(State())
    val state: StateFlow<State> = stateFlow.asStateFlow()
    private var reading: Job? = null
    /** The version whose content is shown. */
    private var shown: Int? = null

    init {
        viewModelScope.launch {
            locate()
            session.vaults.events.collect { event ->
                when {
                    event is VaultEvent.Resync -> locate()
                    event is VaultEvent.Updated && event.itemId == itemId -> locate()
                    event is VaultEvent.Known && event.item.id == itemId -> place(stateFlow.value.location?.copy(item = event.item))
                    event is VaultEvent.Removed && event.itemId == itemId -> stateFlow.value = stateFlow.value.copy(gone = true)
                }
            }
        }
    }

    fun retry() {
        shown = null
        viewModelScope.launch { locate() }
    }

    private suspend fun locate() {
        try {
            place(session.vaults.routes.location(surfaceId, itemId, folder = false))
        } catch (e: CancellationException) {
            throw e
        } catch (e: AgentApiException) {
            if (e.status == 404) stateFlow.value = stateFlow.value.copy(gone = true)
            else if (stateFlow.value.location == null) stateFlow.value = stateFlow.value.copy(body = Body.Failed(Conversation.describe(e)))
        } catch (e: Exception) {
            if (stateFlow.value.location == null) stateFlow.value = stateFlow.value.copy(body = Body.Failed(Conversation.describe(e)))
        }
    }

    /** The entry as it now is; its content read again when the version shown is no longer the one asked for. */
    private fun place(location: VaultLocation?) {
        location ?: return
        val previous = stateFlow.value.location?.item
        stateFlow.value = stateFlow.value.copy(location = location, gone = false)
        val entry = location.item
        val number = version ?: entry.latestVersion
        if (number == shown && previous?.name == entry.name) return
        shown = number
        reading?.cancel()
        reading = viewModelScope.launch { stateFlow.value = stateFlow.value.copy(body = read(entry, number)) }
    }

    private suspend fun read(entry: VaultItem, number: Int?): Body = try {
        val routes = session.vaults.routes
        when (VaultPreview.kind(entry, if (version == null) entry.size else 0L)) {
            VaultPreviewKind.Text, VaultPreviewKind.Picture -> {
                val bytes = routes.content(surfaceId, itemId, number).body
                Body.Text(withContext(Dispatchers.Default) { fileLoadOf(entry.name, bytes) }, bytes)
            }
            VaultPreviewKind.Site -> if (entry.artifact?.type == "markdown") {
                val bytes = routes.artifactFile(surfaceId, itemId, number ?: 1, entry.artifact.entry)
                Body.Text(withContext(Dispatchers.Default) { fileLoadOf("index.md", bytes) }, bytes)
            } else Body.Entry
            VaultPreviewKind.Pdf -> Body.Pdf(
                withContext(Dispatchers.IO) {
                    val directory = File(File(cache, MediaFiles.DIRECTORY), "vault-$itemId-$number").apply { mkdirs() }
                    val file = File(directory, "document.pdf")
                    if (!file.exists()) {
                        val partial = File(directory, "document.pdf.part")
                        partial.outputStream().use { VaultDownloads.write(routes, entry, number, if (version == null) entry.size else null, it) }
                        partial.renameTo(file)
                    }
                    file
                },
            )
            else -> Body.Entry
        }
    } catch (e: CancellationException) {
        throw e
    } catch (e: Exception) {
        Body.Failed(Conversation.describe(e))
    }
}

/**
 * A file or an artifact entry on its own page, by what it is: an
 * artifact as its live site (an HTML one through the in-app browser on an
 * origin of its own, fed from the vault's routes; a Markdown one
 * rendered), text and source with their syntax and Markdown rendered
 * (the file viewer), a picture, a PDF's pages, a recording in the viewer,
 * and anything else as its name and size with Open in, Share and Save to
 * device. The latest version follows the vault live; [version] shows an
 * earlier one, titled so, with Restore. The bar's Share sends it on; More
 * has the rest of what can be done to it.
 */
@Composable
fun VaultFileScreen(session: AgentSession, surfaceId: String, itemId: String, version: Int?, name: String, computer: String, onBack: () -> Unit, open: (Any) -> Unit) {
    val context = LocalContext.current
    val model = viewModel(key = "vault-file:${session.connectionId}:$itemId:${version ?: "latest"}") { VaultFileModel(session, surfaceId, itemId, version, context.cacheDir) }
    val state by model.state.collectAsStateWithLifecycle()
    val actions = rememberVaultActions(session, surfaceId, open)
    val entry = state.location?.item
    val title = entry?.name ?: name
    val subtitle = version?.let { stringResource(R.string.vaults_version_number, it) }
    var viewing by remember { mutableStateOf(false) }
    val bar: @Composable androidx.compose.foundation.layout.RowScope.() -> Unit = {
        if (entry != null) {
            if (version != null && entry.deletedAt == null && state.location?.inTrash != true) {
                IconButton(onClick = { actions.restoreVersion(entry, version) }) {
                    Icon(Ionicon.ArrowUndoOutline, 24.dp, HappyTheme.colors.text, contentDescription = stringResource(R.string.vaults_restore_version))
                }
            }
            IconButton(onClick = { actions.share(entry, version) }, modifier = Modifier.testTag(VaultFileTags.SHARE)) {
                Icon(Ionicon.ShareOutline, 24.dp, HappyTheme.colors.text, contentDescription = stringResource(R.string.vaults_share))
            }
            MoreMenu { close -> VaultItemMenuItems(entry, actions, close, inTrash = state.location?.inTrash == true) }
        }
    }
    val body = state.body
    when {
        state.gone -> PlaceScaffold(title, onBack, VaultFileTags.SCREEN, subtitle = subtitle) { SeedlingEmpty(stringResource(R.string.vaults_entry_gone)) }
        body is VaultFileModel.Body.Text -> FileScreen(
            body.load,
            if (entry?.isArtifact == true) "index.md" else title,
            onBack,
            onRetry = model::retry,
            title = title,
            actions = bar,
        )
        else -> PlaceScaffold(title, onBack, VaultFileTags.SCREEN, subtitle = subtitle, actions = bar) {
            when {
                entry == null || body == VaultFileModel.Body.Reading -> when (body) {
                    is VaultFileModel.Body.Failed -> Failure(problemText(body.problem), model::retry)
                    else -> LoadingIndicator()
                }
                body is VaultFileModel.Body.Failed -> Failure(problemText(body.problem), model::retry)
                body is VaultFileModel.Body.Pdf -> VaultPdfView(body.file) { actions.openElsewhere(entry, version) }
                entry.isArtifact -> {
                    val number = version ?: entry.latestVersion ?: 1
                    key(number) { VaultSite(session, entry, number, computer, open) }
                }
                VaultPreview.kind(entry) == VaultPreviewKind.Video -> Other(entry, version, actions, play = { viewing = true })
                else -> Other(entry, version, actions)
            }
        }
    }
    if (viewing && entry != null) VaultMediaViewer(session, listOf(entry), 0, version) { viewing = false }
    VaultActionsHost(actions)
}

/** An artifact entry's HTML site, live in the in-app browser on an origin of its own, its files read from the vault. */
@Composable
private fun VaultSite(session: AgentSession, entry: VaultItem, number: Int, computer: String, open: (Any) -> Unit) {
    val browser = rememberBrowserState()
    val client = session.client
    val base = session.vaults.routes.filePath(entry.surfaceId, entry.id)
    val status by session.status.collectAsStateWithLifecycle()
    BrowserView(
        browser,
        prepare = {
            BrowserPage.artifact(
                { authority -> BrowserProxy.Scope.Artifact(client, entry.id, number, authority, vault = base) { client.browserWorkspace() } },
                entry.id,
                entry.artifact?.entry ?: "index.html",
            )
        },
        computer = computer,
        agentStatus = status,
        onOpenElsewhere = { url -> open(com.slopus.happy.ui.artifacts.BrowserRoute(session.connectionId, url)) },
    )
}

/** Anything the phone doesn't show: its tile, name and size, and ways to open it elsewhere; a recording plays in the viewer. */
@Composable
private fun Other(entry: VaultItem, version: Int?, actions: VaultActions, play: (() -> Unit)? = null) {
    val colors = HappyTheme.colors
    Column(
        Modifier.fillMaxSize().padding(24.dp).testTag(VaultFileTags.OTHER),
        verticalArrangement = Arrangement.Center,
        horizontalAlignment = Alignment.CenterHorizontally,
    ) {
        com.slopus.happy.ui.files.FileIcon(entry.name, 56.dp)
        Spacer(Modifier.height(16.dp))
        Text(entry.name, style = happyTextStyle(fontSize = 18, lineHeight = 24), color = colors.text, textAlign = TextAlign.Center)
        Text(vaultItemDetail(entry), style = happyTextStyle(fontSize = 14, lineHeight = 20), color = colors.textSecondary, textAlign = TextAlign.Center, modifier = Modifier.padding(top = 4.dp))
        Spacer(Modifier.height(24.dp))
        val buttons = Modifier.widthIn(max = 320.dp).fillMaxWidth()
        if (play != null) {
            RoundButton(stringResource(R.string.vaults_play), onClick = play, modifier = buttons.testTag(VaultFileTags.PLAY), size = RoundButtonSize.Normal)
            Spacer(Modifier.height(12.dp))
        }
        RoundButton(stringResource(R.string.vaults_open_in), onClick = { actions.openElsewhere(entry, version) }, modifier = buttons, size = RoundButtonSize.Normal, display = if (play != null) RoundButtonDisplay.Inverted else RoundButtonDisplay.Default)
        Spacer(Modifier.height(12.dp))
        RoundButton(stringResource(R.string.vaults_share), onClick = { actions.share(entry, version) }, modifier = buttons, size = RoundButtonSize.Normal, display = RoundButtonDisplay.Inverted)
        Spacer(Modifier.height(12.dp))
        RoundButton(stringResource(R.string.vaults_save_to_device), onClick = { actions.save(entry, version) }, modifier = buttons, size = RoundButtonSize.Normal, display = RoundButtonDisplay.Inverted)
    }
}

@Composable
private fun Failure(reason: String, retry: () -> Unit) {
    SeedlingEmpty(reason, button = stringResource(R.string.common_retry) to retry)
}
