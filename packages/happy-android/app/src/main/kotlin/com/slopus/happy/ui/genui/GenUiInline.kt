package com.slopus.happy.ui.genui

import android.util.LruCache
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.Stable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateMapOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.layout.layout
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import com.slopus.happy.agent.AgentClient
import com.slopus.happy.artifacts.ArtifactClient
import com.slopus.happy.artifacts.ArtifactFile
import com.slopus.happy.artifacts.ArtifactMedia
import com.slopus.happy.artifacts.ArtifactMediaItem
import com.slopus.happy.artifacts.ArtifactVersion
import com.slopus.happy.artifacts.Extent
import com.slopus.happy.browser.BrowserFetcher
import com.slopus.happy.browser.browserNetwork
import com.slopus.happy.genui.Element
import com.slopus.happy.genui.GEN_UI_RENDER_PATH
import com.slopus.happy.genui.GenUi
import com.slopus.happy.media.MediaLibrary
import com.slopus.happy.ui.artifacts.ArtifactUi
import com.slopus.happy.ui.artifacts.ArtifactViewer
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext

/** API.md: a render document is at most 4 MiB. */
private const val RENDER_LIMIT = 4L * 1024 * 1024

/**
 * [version]'s render document, read from [render] and parsed off the main
 * thread, and every picture it names that the version holds, sized from the
 * document so the viewer opens at its shape. A picture the version lacks
 * keeps its placeholder.
 */
suspend fun readGenUi(
    files: ArtifactClient,
    version: ArtifactVersion,
    render: ArtifactFile,
    media: ArtifactMedia,
    label: (path: String) -> String,
): ArtifactUi.GenUi {
    val body = files.bytes(media.artifactId, version.number, render.path, limit = RENDER_LIMIT)
    val document = withContext(Dispatchers.Default) { GenUi.parse(String(body, Charsets.UTF_8)) }
    val named = document.elements.values.filterIsInstance<Element.Image>().map { Triple(it.file, it.alt, Extent(it.width.toDouble(), it.height.toDouble())) } +
        document.viewers.values.flatten().map { Triple(it.file, it.caption ?: it.alt, Extent(it.width.toDouble(), it.height.toDouble())) }
    val pictures = named.mapNotNull { (path, alt, size) ->
        val file = version.file(path)?.takeIf { it.isVisual && !it.isVideo } ?: return@mapNotNull null
        val item = media.media(file, alt.ifEmpty { label(path) })
        if (size.width > 0 && size.height > 0 && item.key !in media.sizes) media.sizes[item.key] = size
        path to item
    }.toMap()
    return ArtifactUi.GenUi(version.number, document, pictures, version.origin)
}

/**
 * The Gen UI artifacts a conversation shows under their cards: each
 * version read once (a numbered version never changes), its choices, and
 * the height it last drew at. What was read stays for the process
 * ([recent]), so a chat opened again draws its blocks in their first frame
 * at their height, without reading them again.
 */
@Stable
class GenUiInline(
    private val client: AgentClient,
    private val library: MediaLibrary?,
    /** The conversation's agent: a block's `message` runs only when it is the version's origin. */
    val agentId: String,
    /** Sends words as the person's next message in this conversation. */
    val onMessage: (String) -> Unit,
    /** An https address a block opened. */
    val onOpenWeb: (String) -> Unit,
) {
    /** One version as read, with what was done to it. */
    class Block(val ui: ArtifactUi.GenUi, val media: ArtifactMedia, val state: GenUiState = GenUiState())

    private val files = ArtifactClient(client)

    /** Where a block's secret form saves. */
    val secrets = GenUiSecretApi(client)
    private val blocks = mutableStateMapOf<String, Block>()
    private val failed = mutableStateMapOf<String, Boolean>()

    private fun key(artifactId: String, version: Int) = "${client.hashCode()}/$artifactId/$version"

    /** [artifactId]'s [version], once read: from this chat, or one opened before. */
    fun block(artifactId: String, version: Int): Block? {
        val key = key(artifactId, version)
        return blocks[key] ?: recent.get(key)
    }

    fun failed(artifactId: String, version: Int): Boolean = failed[key(artifactId, version)] == true

    /** Reads [artifactId]'s [version] unless it is here; a failure is kept until asked again. */
    suspend fun read(artifactId: String, version: Int, label: (String) -> String) {
        val key = key(artifactId, version)
        if (block(artifactId, version) != null) return
        failed -= key
        try {
            val manifest = files.version(artifactId, version)
            val render = manifest.file(GEN_UI_RENDER_PATH) ?: throw IllegalStateException("no render document")
            val media = ArtifactMedia(files, artifactId, version, library) { BrowserFetcher(client, { client.browserNetwork(artifactId = artifactId) }) }
            val block = Block(readGenUi(files, manifest, render, media, label), media)
            blocks[key] = block
            recent.put(key, block)
        } catch (e: CancellationException) {
            throw e
        } catch (_: Exception) {
            failed[key] = true
        }
    }

    /** The height [artifactId]'s [version] last drew at, at [width] px and [fontScale]. */
    internal fun height(artifactId: String, version: Int, width: Int, fontScale: Float): Int? = heights.get("${key(artifactId, version)}/$width/$fontScale")

    internal fun drew(artifactId: String, version: Int, width: Int, fontScale: Float, height: Int) {
        heights.put("${key(artifactId, version)}/$width/$fontScale", height)
    }

    companion object {
        /** Versions read lately in any chat, so one opened again draws at once. */
        private val recent = LruCache<String, Block>(24)

        /** Heights by version, width and text size (RENDER.md M9). */
        private val heights = LruCache<String, Int>(512)

        /** What a block takes before its version has ever been read here. */
        val DEFAULT_HEIGHT: Dp = 120.dp
    }
}

object GenUiInlineTags {
    const val BLOCK = "genui.inline"
    const val WAITING = "genui.inline.waiting"
}

/**
 * [artifactId]'s [version] under its card in a conversation, at the
 * column's width. Read before, it draws in its first frame; otherwise it
 * holds the height it last drew at (or [GenUiInline.DEFAULT_HEIGHT]) until
 * read. A failed read leaves only the card. A picture opens the viewer on
 * its group; `message` goes to this conversation when its agent made the
 * version; `secret` opens the secret form, saved for whichever agent made it.
 */
@Composable
fun GenUiInlineBlock(artifactId: String, version: Int, inline: GenUiInline, label: (String) -> String, modifier: Modifier = Modifier) {
    val block = inline.block(artifactId, version)
    if (block == null) {
        LaunchedEffect(artifactId, version) { inline.read(artifactId, version, label) }
        if (inline.failed(artifactId, version)) return
        val density = LocalDensity.current
        Box(
            modifier.fillMaxWidth().testTag(GenUiInlineTags.WAITING).layout { m, c ->
                val held = inline.height(artifactId, version, c.maxWidth, density.fontScale) ?: GenUiInline.DEFAULT_HEIGHT.roundToPx()
                val p = m.measure(c.copy(minHeight = held, maxHeight = held))
                layout(p.width, p.height) { p.place(0, 0) }
            },
        )
        return
    }
    var viewing by remember { mutableStateOf<Pair<List<ArtifactMediaItem>, Int>?>(null) }
    val sends = block.ui.origin != null && block.ui.origin == inline.agentId
    val secrets = rememberGenUiSecretForm(inline.secrets, artifactId, version, block.state)
    val host = rememberGenUiArtifactHost(
        block.ui, block.media, inline.onOpenWeb,
        onView = { items, index -> viewing = items to index },
        onMessage = if (sends) inline.onMessage else null,
        secrets = secrets,
    )
    val density = LocalDensity.current
    GenUiView(
        block.ui.document,
        modifier.testTag(GenUiInlineTags.BLOCK).layout { m, c ->
            val p = m.measure(c)
            inline.drew(artifactId, version, c.maxWidth, density.fontScale, p.height)
            layout(p.width, p.height) { p.place(0, 0) }
        },
        host,
        block.state,
    )
    viewing?.let { (items, index) -> ArtifactViewer(items, index, block.media) { viewing = null } }
    secrets?.Sheet()
}
