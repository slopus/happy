package com.slopus.happy.ui.artifacts

import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalHapticFeedback
import androidx.compose.ui.hapticfeedback.HapticFeedbackType
import com.slopus.happy.ui.home.copyToClipboard
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.selected
import androidx.compose.ui.text.font.FontWeight
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.launch
import com.slopus.happy.ui.diff.MarkdownDiffView
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.navigationBars
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.windowInsetsBottomHeight
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Button
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.Stable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import com.slopus.happy.R
import com.slopus.happy.ui.components.LoadingIndicator
import com.slopus.happy.artifacts.ArtifactFile
import com.slopus.happy.artifacts.ArtifactMedia
import com.slopus.happy.artifacts.ArtifactMediaItem
import com.slopus.happy.artifacts.Extent
import com.slopus.happy.artifacts.documentPictureSize
import com.slopus.happy.chat.markdown.MarkdownBlock
import com.slopus.happy.conversation.MediaItem
import com.slopus.happy.ui.browser.BrowserPage
import com.slopus.happy.ui.browser.BrowserControls
import com.slopus.happy.ui.browser.BrowserView
import com.slopus.happy.ui.browser.rememberBrowserState
import com.slopus.happy.ui.chat.MarkdownView
import com.slopus.happy.ui.components.Alert
import com.slopus.happy.ui.connection.BarIconButton
import com.slopus.happy.ui.components.AlertButton
import com.slopus.happy.ui.components.HappyAlert
import com.slopus.happy.ui.components.Icon
import com.slopus.happy.ui.components.Ionicon
import com.slopus.happy.media.MediaSizeText
import com.slopus.happy.ui.conversation.MediaOpening
import com.slopus.happy.ui.conversation.MediaRing
import com.slopus.happy.ui.conversation.MediaRingState
import com.slopus.happy.ui.conversation.UploadRingSpec
import com.slopus.happy.ui.conversation.rememberMediaOpener
import com.slopus.happy.ui.layout.LocalWindowLayout
import com.slopus.happy.ui.layout.contentMaxWidth
import com.slopus.happy.ui.theme.HappyTheme
import com.slopus.happy.ui.theme.happyTextStyle

object ArtifactTags {
    const val SCREEN = "artifact.screen"
    const val DOCUMENT = "artifact.document"
    const val PICTURE = "artifact.picture"
    const val OPEN = "artifact.open"
    const val OPEN_RING = "artifact.open.ring"
    const val OPEN_STATUS = "artifact.open.status"
    const val DIFF_BAR = "artifact.diff.bar"
    const val DIFF_TAB = "artifact.diff.tab"
    const val LATEST_TAB = "artifact.diff.latest"
    const val DELETE = "artifact.delete"
    const val COPY_LINK = "artifact.copyLink"
}

/** What the artifact screen does with a tap, outside itself. */
@Stable
class ArtifactActions(
    val onBack: () -> Unit,
    /** Where a link in the document at `document` leads ([ArtifactLoader.link]). */
    val link: (raw: String, document: String) -> ArtifactLink = { _, _ -> ArtifactLink.Nothing },
    /** Another file of the version, pushed. */
    val onOpenFile: (version: Int, path: String) -> Unit = { _, _ -> },
    /** An address on the web, in the in-app browser. */
    val onOpenWeb: (String) -> Unit = {},
    /** Another scheme, for the system; a Happy URL stays in the app. */
    val onOpenExternal: (String) -> Unit = {},
    /** An artifact's external Happy link, for sharing; null where its server has no instance id ([BrowserView]). */
    val artifactLink: (artifactId: String) -> String? = { null },
    /** A file read whole, for handing to another app; it tells how much of how much is here as it reads. */
    val fileReader: suspend (ArtifactFile, progress: (done: Long, total: Long) -> Unit) -> ByteArray = { _, _ -> throw IllegalStateException("no reader") },
    /** Names this artifact's staged files apart from others'. */
    val artifactKey: String = "artifact",
    /**
     * The artifact's external Happy link, at the version it was pinned to
     * (iOS `CopyLinkItem`), for the bar's Copy Link; null where it has none:
     * a file a link opened, or a server with no instance id.
     */
    val shareLink: (() -> String?)? = null,
    /** Deletes the artifact for everyone (desktop's Delete); null where it can't be, such as one file of it a link opened. */
    val onDelete: (suspend () -> Unit)? = null,
)

/**
 * One artifact, or one file of it a link opened (iOS's
 * `ArtifactViewController`): Markdown in the conversation's renderer with
 * its own pictures and links; pictures, image series and videos natively,
 * opening in the viewer; any other page in the in-app browser on an origin
 * of its own, or full screen when it asks to run as an app
 * ([ArtifactAppPage]); a PDF or other file Android's WebView can't draw handed to an
 * app that reads it. While it reads, a loader; deleted or unreadable, the
 * screen says so in place.
 */
@Composable
fun ArtifactScreen(
    title: String,
    ui: ArtifactUi,
    media: ArtifactMedia?,
    computer: String,
    actions: ArtifactActions,
    /** Its versions: History in the bar, and a banner over an older one; null for a linked file or one not read yet. */
    history: ArtifactHistory? = null,
) {
    var viewing by remember { mutableStateOf<Pair<List<ArtifactMediaItem>, Int>?>(null) }
    var missing by remember { mutableStateOf(false) }
    var versions by remember { mutableStateOf(false) }
    var deleting by remember { mutableStateOf(DeleteStep.None) }
    val scope = rememberCoroutineScope()
    val named = title.ifBlank { stringResource(R.string.artifact_untitled) }
    // A page's browser buttons go in this bar, and the artifact's title stays (iOS 34aa464e1).
    val browser = rememberBrowserState()
    PlaceScaffold(
        title.ifBlank { stringResource(R.string.artifact_untitled) },
        actions.onBack,
        ArtifactTags.SCREEN,
        actions = {
            if (ui is ArtifactUi.Page && ui.app == null) BrowserControls(browser)
            // A page shares its link from the browser's own menu.
            val link = actions.shareLink?.takeIf { ui !is ArtifactUi.Page && ui !is ArtifactUi.Message }?.invoke()
            if (link != null) {
                val context = LocalContext.current
                val haptics = LocalHapticFeedback.current
                BarIconButton(
                    Ionicon.LinkOutline,
                    stringResource(R.string.link_menu_copy),
                    { if (copyToClipboard(context, link)) haptics.performHapticFeedback(HapticFeedbackType.Confirm) },
                    Modifier.testTag(ArtifactTags.COPY_LINK),
                )
            }
            if (history?.hasVersions == true) {
                BarIconButton(Ionicon.TimeOutline, stringResource(R.string.artifact_history), { versions = true }, Modifier.testTag(ArtifactHistoryTags.ACTION))
            }
            // A deleted or unreadable one has nothing left to delete.
            if (actions.onDelete != null && ui !is ArtifactUi.Message && ui != ArtifactUi.Loading) {
                BarIconButton(
                    Ionicon.TrashOutline,
                    stringResource(R.string.common_delete),
                    { if (deleting != DeleteStep.Running) deleting = DeleteStep.Asking },
                    Modifier.testTag(ArtifactTags.DELETE),
                )
            }
        },
    ) {
        Column(Modifier.fillMaxSize()) {
            if (history?.older == true) ArtifactOlderBanner(history)
            Box(Modifier.weight(1f).fillMaxWidth(), contentAlignment = Alignment.TopCenter) {
                when (ui) {
                    ArtifactUi.Loading -> LoadingIndicator(Modifier.testTag(PlaceTags.LOADER))
                    is ArtifactUi.Message -> Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState())) {
                        PlaceMessage(stringResource(if (ui.deleted) R.string.artifact_deleted else R.string.artifact_unavailable))
                    }
                    is ArtifactUi.Document -> ArtifactDocument(
                        ui,
                        media,
                        onPicture = { item -> viewing = ui.order to ui.order.indexOfFirst { it.key == item.key }.coerceAtLeast(0) },
                        onLink = { raw ->
                            when (val link = actions.link(raw, ui.path)) {
                                is ArtifactLink.View -> viewing = listOf(link.item) to 0
                                is ArtifactLink.File -> actions.onOpenFile(link.version, link.path)
                                is ArtifactLink.Web -> actions.onOpenWeb(link.url)
                                is ArtifactLink.External -> actions.onOpenExternal(link.url)
                                ArtifactLink.Missing -> missing = true
                                ArtifactLink.Nothing -> Unit
                            }
                        },
                    )
                    is ArtifactUi.Gallery -> if (media != null) ArtifactGallery(ui.items, media) { index -> viewing = ui.items to index }
                    // An app goes full screen over everything; closing it leaves the artifact.
                    is ArtifactUi.Page -> if (ui.app != null) {
                        ArtifactAppPage(browser, ui.prepare, computer, ui.app, onClose = actions.onBack, onOpenElsewhere = actions.onOpenWeb, artifactLink = actions.artifactLink)
                    } else {
                        BrowserView(browser, prepare = ui.prepare, computer = computer, onOpenElsewhere = actions.onOpenWeb, artifactLink = actions.artifactLink)
                    }
                    is ArtifactUi.Openable -> ArtifactOpenable(ui.file, actions)
                }
            }
        }
    }
    if (versions && history != null) ArtifactHistorySheet(history) { versions = false }
    val shown = viewing
    if (shown != null && media != null) ArtifactViewer(shown.first, shown.second, media) { viewing = null }
    val delete = actions.onDelete
    when (deleting) {
        DeleteStep.Asking -> if (delete != null) {
            HappyAlert(
                Alert(
                    stringResource(R.string.artifact_delete_title, named),
                    stringResource(R.string.artifact_delete_message),
                    listOf(
                        AlertButton(stringResource(R.string.common_cancel)) { deleting = DeleteStep.None },
                        AlertButton(stringResource(R.string.common_delete), destructive = true) {
                            deleting = DeleteStep.Running
                            scope.launch {
                                deleting = try {
                                    delete()
                                    // Gone: the screen goes with it.
                                    actions.onBack()
                                    DeleteStep.None
                                } catch (e: CancellationException) {
                                    throw e
                                } catch (_: Exception) {
                                    DeleteStep.Failed
                                }
                            }
                        },
                    ),
                ),
                onDismiss = { deleting = DeleteStep.None },
            )
        }
        DeleteStep.Failed -> HappyAlert(
            Alert(stringResource(R.string.artifact_delete_failed), null, listOf(AlertButton(stringResource(R.string.common_ok)))),
            onDismiss = { deleting = DeleteStep.None },
        )
        DeleteStep.None, DeleteStep.Running -> Unit
    }
    if (missing) {
        val ok = stringResource(R.string.common_ok)
        HappyAlert(Alert(stringResource(R.string.artifact_file_unavailable), null, listOf(AlertButton(ok))), onDismiss = { missing = false })
    }
}

/**
 * A Markdown file in the conversation's renderer, in the reading column:
 * every picture it shows in its own shape ([documentPictureSize]) read
 * through the artifact, every link resolved against the file. A fresh
 * version opens on its rendered diff against the one before (desktop
 * e10d6444), with Diff and Latest to switch.
 */
@Composable
private fun ArtifactDocument(
    ui: ArtifactUi.Document,
    media: ArtifactMedia?,
    onPicture: (ArtifactMediaItem) -> Unit,
    onLink: (String) -> Unit,
) {
    val links = remember(ui) { { raw: String -> onLink(raw) } }
    val previous = ui.previous
    var diff by rememberSaveable(ui.path, previous != null) { mutableStateOf(previous != null) }
    Column(Modifier.fillMaxSize()) {
        if (previous != null) {
            Row(
                Modifier.fillMaxWidth().contentMaxWidth(LocalWindowLayout.current).padding(horizontal = 16.dp, vertical = 8.dp).testTag(ArtifactTags.DIFF_BAR),
                horizontalArrangement = Arrangement.spacedBy(8.dp),
            ) {
                DocumentTab(stringResource(R.string.files_diff), diff, ArtifactTags.DIFF_TAB) { diff = true }
                DocumentTab(stringResource(R.string.artifact_history_latest), !diff, ArtifactTags.LATEST_TAB) { diff = false }
            }
        }
        Column(
            Modifier
                .weight(1f)
                .fillMaxWidth()
                .verticalScroll(rememberScrollState())
                .contentMaxWidth(LocalWindowLayout.current)
                .padding(horizontal = 16.dp, vertical = 8.dp)
                .testTag(ArtifactTags.DOCUMENT),
        ) {
            if (diff && previous != null) {
                Text(
                    stringResource(R.string.artifact_diff_since, ui.previousLabel.orEmpty()),
                    style = happyTextStyle(fontSize = 13, lineHeight = 18),
                    color = HappyTheme.colors.textSecondary,
                    modifier = Modifier.padding(bottom = 8.dp),
                )
                MarkdownDiffView(previous, ui.text)
            } else {
                MarkdownView(
                    ui.blocks,
                    onLink = links,
                    image = { block -> DocumentPicture(block, ui.pictures[block.url], media, onPicture) },
                )
            }
            Spacer(Modifier.windowInsetsBottomHeight(WindowInsets.navigationBars))
        }
    }
}

/** One of Diff and Latest over a fresh version, as a workspace file's Diff and Rendered (FileScreen's tabs). */
@Composable
private fun DocumentTab(label: String, selected: Boolean, tag: String, onClick: () -> Unit) {
    val colors = HappyTheme.colors
    Box(
        Modifier
            .testTag(tag)
            .clip(RoundedCornerShape(8.dp))
            .background(if (selected) colors.textLink.copy(alpha = 0x66 / 255f) else colors.glass.backgroundSubtle)
            .clickable(role = Role.Tab, onClick = onClick)
            .semantics { this.selected = selected }
            .padding(horizontal = 16.dp, vertical = 8.dp),
    ) {
        Text(label, style = happyTextStyle(fontSize = 14, weight = FontWeight.SemiBold), color = if (selected) Color.White else colors.textSecondary)
    }
}

/** One picture of a document: as wide as it is, no wider than the column, 8 above and below; its alt text under it. */
@Composable
private fun DocumentPicture(block: MarkdownBlock.Image, item: ArtifactMediaItem?, media: ArtifactMedia?, onOpen: (ArtifactMediaItem) -> Unit) {
    val colors = HappyTheme.colors
    Column(Modifier.padding(vertical = 8.dp).fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(8.dp)) {
        if (item != null && media != null) {
            BoxWithConstraints(Modifier.fillMaxWidth()) {
                val pixels: Extent? = media.sizes[item.key]
                val size = documentPictureSize(maxWidth.value.toDouble(), pixels)
                MediaTile(
                    item = item,
                    media = media,
                    modifier = Modifier.size(size.width.dp, size.height.dp).testTag(ArtifactTags.PICTURE),
                    onClick = { onOpen(item) },
                )
            }
        }
        // A picture that leaves the artifact (or is refused) is never fetched from the phone: only its words show.
        if (block.alt.isNotEmpty()) Text(block.alt, style = happyTextStyle(fontSize = 14, lineHeight = 20), color = colors.textSecondary)
    }
}

/**
 * A file Android's WebView would only download: its name and kind, and a
 * button that reads it through the agent connection and hands it to an app
 * that opens it (desktop d122790d's download states). While it reads, the
 * glyph wears Telegram's ring (RadialProgress2), filling as the ranges come,
 * with how much of how much is here under the name, and the button stops it;
 * failed, the ring's retry arrow and the reason, and the button tries again.
 */
@Composable
private fun ArtifactOpenable(file: ArtifactFile, actions: ArtifactActions) {
    val colors = HappyTheme.colors
    val opener = rememberMediaOpener()
    val key = "${actions.artifactKey}-${file.path.hashCode()}"
    val state = opener.state(key)
    var read by remember(key) { mutableStateOf<Pair<Long, Long>?>(null) }
    val open = {
        if (state !is MediaOpening.Reading) read = null
        opener.open(key, MediaItem("file", file.path, file.mimeType)) { actions.fileReader(file) { done, total -> read = done to total } }
    }
    Column(
        Modifier.fillMaxSize().padding(horizontal = 32.dp, vertical = 56.dp),
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        Box(Modifier.size(64.dp), contentAlignment = Alignment.Center) {
            val ring = when (state) {
                MediaOpening.Reading -> read?.takeIf { it.second > 0 }?.let { MediaRingState.Progress((it.first.toFloat() / it.second).coerceIn(0f, 1f)) } ?: MediaRingState.Waiting
                is MediaOpening.Failed -> MediaRingState.Failed
                null -> null
            }
            if (ring == null) {
                Icon(Ionicon.DocumentTextOutline, 48.dp, colors.textSecondary)
            } else {
                MediaRing(
                    state = ring,
                    onClick = open,
                    label = stringResource(if (ring == MediaRingState.Failed) R.string.common_retry else R.string.common_cancel),
                    modifier = Modifier.size(64.dp).testTag(ArtifactTags.OPEN_RING),
                    disc = if (colors.dark) UploadRingSpec.fileDiscDark else UploadRingSpec.fileDisc,
                )
            }
        }
        Text(file.name, style = happyTextStyle(fontSize = 17, lineHeight = 22), color = colors.text, textAlign = TextAlign.Center)
        Text(
            when (state) {
                is MediaOpening.Failed -> state.reason
                MediaOpening.Reading -> read?.let { (done, total) -> MediaSizeText.progress(done, total) } ?: stringResource(R.string.conversation_media_reading)
                null -> stringResource(R.string.artifact_open_with_body)
            },
            style = happyTextStyle(fontSize = 15, lineHeight = 21).copy(fontFeatureSettings = "tnum"),
            color = colors.textSecondary,
            textAlign = TextAlign.Center,
            modifier = Modifier.testTag(ArtifactTags.OPEN_STATUS),
        )
        Button(
            onClick = open,
            modifier = Modifier.testTag(ArtifactTags.OPEN).semantics { contentDescription = file.name },
        ) {
            Text(
                stringResource(
                    when (state) {
                        MediaOpening.Reading -> R.string.common_cancel
                        is MediaOpening.Failed -> R.string.common_retry
                        null -> R.string.artifact_open_with
                    },
                ),
            )
        }
    }
}

/** Where deleting the artifact is: asked, under way, or failed and saying so. */
private enum class DeleteStep { None, Asking, Running, Failed }
