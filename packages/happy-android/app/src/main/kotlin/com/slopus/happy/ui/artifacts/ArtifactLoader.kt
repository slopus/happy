package com.slopus.happy.ui.artifacts

import androidx.compose.runtime.Immutable
import com.slopus.happy.agent.AgentClient
import com.slopus.happy.artifacts.ArtifactClient
import com.slopus.happy.artifacts.ArtifactFile
import com.slopus.happy.artifacts.ArtifactGoneException
import com.slopus.happy.artifacts.ArtifactMarkdown
import com.slopus.happy.artifacts.ArtifactMedia
import com.slopus.happy.artifacts.ArtifactMediaItem
import com.slopus.happy.artifacts.ArtifactPageMode
import com.slopus.happy.artifacts.AppClose
import com.slopus.happy.artifacts.ArtifactRef
import com.slopus.happy.artifacts.ArtifactReference
import com.slopus.happy.artifacts.ArtifactShow
import com.slopus.happy.artifacts.ArtifactVersion
import com.slopus.happy.browser.BrowserException
import com.slopus.happy.browser.BrowserFetcher
import com.slopus.happy.browser.BrowserPolicy
import com.slopus.happy.browser.BrowserProxy
import com.slopus.happy.browser.browserNetwork
import com.slopus.happy.chat.markdown.MarkdownBlock
import com.slopus.happy.chat.num
import com.slopus.happy.chat.markdown.parseMarkdownBlocks
import com.slopus.happy.media.MediaLibrary
import com.slopus.happy.ui.browser.BrowserPage
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.async
import kotlinx.coroutines.awaitAll
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeoutOrNull

/** What the artifact screen shows. */
@Immutable
sealed interface ArtifactUi {
    data object Loading : ArtifactUi

    /** Deleted, or not to be had; said in place, as iOS does. */
    data class Message(val deleted: Boolean) : ArtifactUi

    /**
     * A Markdown file, its pictures by the address it wrote, in the order
     * they show. A version made in the last [ArtifactLoader.FRESH_DIFF_MILLIS]
     * also carries its [text] and the version before's ([previous], labelled
     * [previousLabel]), so it opens on what changed (desktop e10d6444).
     */
    data class Document(
        val path: String,
        val blocks: List<MarkdownBlock>,
        val pictures: Map<String, ArtifactMediaItem>,
        val order: List<ArtifactMediaItem>,
        val text: String = "",
        val previous: String? = null,
        val previousLabel: String? = null,
    ) : ArtifactUi

    /** Pictures and recordings, one large or several in a grid. */
    data class Gallery(val items: List<ArtifactMediaItem>) : ArtifactUi

    /**
     * A page in the in-app browser, made when it shows; [app] where its
     * close button goes when it asks to run as an app ([ArtifactPageMode]),
     * full screen over everything.
     */
    class Page(val app: AppClose? = null, val prepare: suspend () -> BrowserPage) : ArtifactUi

    /** A file Android's WebView doesn't draw (a PDF, an office file), opened in an app that reads it. */
    data class Openable(val file: ArtifactFile) : ArtifactUi
}

/** Where a tapped link in a document leads (iOS's `ArtifactViewController.open(link:)`). */
sealed interface ArtifactLink {
    /** A picture or recording of the version: the viewer, on it alone. */
    data class View(val item: ArtifactMediaItem) : ArtifactLink
    /** Another file of the version, pushed in its own artifact screen. */
    data class File(val version: Int, val path: String) : ArtifactLink
    /** An address on the web, in the in-app browser through the computer. */
    data class Web(val url: String) : ArtifactLink
    /** Any other scheme, for the system. */
    data class External(val url: String) : ArtifactLink
    /** A file the version doesn't have. */
    data object Missing : ArtifactLink
    /** A place in the document, a `data:` address, or a refused path: nothing happens. */
    data object Nothing : ArtifactLink
}

/**
 * One artifact, or one file of it a link opened (iOS's
 * `ArtifactViewController`): the version read (the latest, or the one it
 * names), then shown by what its file is. Markdown waits up to a second for
 * its pictures' sizes before it shows, so it doesn't jump as they arrive;
 * a gallery waits the same for its items'. A 404 is a deleted artifact.
 */
class ArtifactLoader(
    private val files: ArtifactClient,
    private val agent: AgentClient?,
    private val scope: CoroutineScope,
    val ref: ArtifactRef,
    /** Opened from a link in another of its files: that version, that file. */
    private val opened: Pair<Int, String>? = null,
    private val labels: (isVideo: Boolean, name: String) -> String = { _, name -> name },
    private val sizeWait: Long = SIZE_WAIT,
    /** The connection's kept media, where the version's files are read once. */
    private val library: MediaLibrary? = null,
    private val now: () -> Long = System::currentTimeMillis,
) {
    private val stateFlow = MutableStateFlow<ArtifactUi>(ArtifactUi.Loading)
    val state: StateFlow<ArtifactUi> = stateFlow.asStateFlow()

    private val titleFlow = MutableStateFlow(opened?.second?.substringAfterLast('/') ?: ref.title)
    /** The bar's title: the version's once read; a linked file's name. Empty reads as untitled. */
    val title: StateFlow<String> = titleFlow.asStateFlow()

    var version: ArtifactVersion? = null
        private set

    private val shownFlow = MutableStateFlow<ArtifactVersion?>(null)
    private val latestFlow = MutableStateFlow<Int?>(null)

    /** The version shown, once read: the History sheet marks it and the banner names it. Null for a linked file. */
    val shown: StateFlow<ArtifactVersion?> = shownFlow.asStateFlow()

    /** The artifact's latest version number, once known: the version read when it follows the latest, else asked of its catalog entry. */
    val latest: StateFlow<Int?> = latestFlow.asStateFlow()
    var media: ArtifactMedia? = null
        private set
    private var loading: Job? = null

    fun load() {
        if (loading != null) return
        loading = scope.launch { stateFlow.value = read() }
    }

    private suspend fun read(): ArtifactUi = try {
        val version = files.version(ref.id, opened?.first ?: if (ref.opensLatest) null else ref.version)
        if (opened == null && version.title.isNotEmpty()) titleFlow.value = version.title
        this.version = version
        if (opened == null) {
            shownFlow.value = version
            if (ref.opensLatest) {
                latestFlow.value = version.number
            } else {
                // A pinned version: is there a newer one? A failure here only leaves the banner off.
                scope.launch {
                    latestFlow.value = runCatching { files.artifact(ref.id)["latestVersion"].num?.toInt() }.getOrNull()
                }
            }
        }
        show(version, ArtifactShow.of(version, opened?.second))
    } catch (e: CancellationException) {
        throw e
    } catch (_: ArtifactGoneException) {
        ArtifactUi.Message(deleted = true)
    } catch (_: Exception) {
        ArtifactUi.Message(deleted = false)
    }

    private suspend fun show(version: ArtifactVersion, show: ArtifactShow): ArtifactUi {
        val agent = agent
        return when (show) {
            is ArtifactShow.Live -> ArtifactUi.Page { livePage(agent, show.url) }
            ArtifactShow.Unavailable -> ArtifactUi.Message(deleted = false)
            is ArtifactShow.Document -> document(version, show.file)
            is ArtifactShow.Gallery -> gallery(version, show.files)
            is ArtifactShow.Page -> ArtifactUi.Page(app = ArtifactPageMode.of(files, ref.id, version.number, show.file.path)) {
                agent ?: throw BrowserException(BrowserException.Kind.Unavailable)
                BrowserPage.artifact(
                    { authority -> BrowserProxy.Scope.Artifact(agent, ref.id, version.number, authority) { agent.browserNetwork(artifactId = ref.id) } },
                    ref.id,
                    show.file.path,
                )
            }
            is ArtifactShow.Openable -> ArtifactUi.Openable(show.file)
        }
    }

    /**
     * A live artifact at the URL of the version shown, http or https,
     * through the artifact's own proxy in the network it was made on
     * (happy-agent API.md, "Live URLs"): no workspace is looked up for it,
     * and its `/api/…` is the site's own.
     */
    private fun livePage(agent: AgentClient?, url: String): BrowserPage {
        agent ?: throw BrowserException(BrowserException.Kind.Unavailable)
        val authority = BrowserPolicy.Authority.of(url) ?: throw BrowserException(BrowserException.Kind.Malformed)
        return BrowserPage(url, BrowserProxy.Scope.Live(agent, ref.id, authority), ref.id)
    }

    private fun media(version: ArtifactVersion): ArtifactMedia = media ?: ArtifactMedia(files, ref.id, version.number, library) {
        agent?.let { client -> BrowserFetcher(client, { client.browserNetwork(artifactId = ref.id) }) }
    }.also { media = it }

    private suspend fun document(version: ArtifactVersion, file: ArtifactFile): ArtifactUi {
        val media = media(version)
        val self = media.media(file, labels(false, file.name))
        val body = media.data(self.key) ?: throw IllegalStateException("unreadable")
        val (raws, blocks) = withContext(Dispatchers.Default) {
            val text = ArtifactMarkdown.prepare(String(body, Charsets.UTF_8))
            ArtifactMarkdown.pictures(text) to parseMarkdownBlocks(text)
        }
        val pictures = LinkedHashMap<String, ArtifactMediaItem>()
        for (raw in raws) {
            if (raw in pictures) continue
            val item = when (val reference = ArtifactMarkdown.resolve(raw, file.path)) {
                is ArtifactReference.File -> version.files.firstOrNull { it.path == reference.path }?.takeIf { it.isVisual }?.let { media.media(it, labels(it.isVideo, it.name)) }
                is ArtifactReference.Web -> media.web(reference.url, labels(false, reference.url.substringAfterLast('/')))
                is ArtifactReference.Data -> media.data(reference.url, labels(false, ""))
                else -> null
            } ?: continue
            pictures[raw] = item
        }
        val order = raws.mapNotNull { pictures[it] }.distinctBy { it.key }
        val before = previous(version)
        awaitSizes(media, order)
        return if (before == null) ArtifactUi.Document(file.path, blocks, pictures, order)
        else ArtifactUi.Document(file.path, blocks, pictures, order, ArtifactMarkdown.prepare(String(body, Charsets.UTF_8)), before.second, before.first)
    }

    /**
     * The version before [version]'s Markdown entry, and its label, when
     * [version] is a fresh one (made under [FRESH_DIFF_MILLIS] ago) of the
     * artifact itself, not a linked file: what its screen diffs it against.
     * Null otherwise, or when the version before can't be read or isn't Markdown.
     */
    private suspend fun previous(version: ArtifactVersion): Pair<String, String>? {
        if (opened != null || version.number <= 1 || version.createdAt <= 0 || now() - version.createdAt > FRESH_DIFF_MILLIS) return null
        return try {
            val before = files.version(ref.id, version.number - 1)
            val entry = before.entry?.takeIf { it.isMarkdown } ?: return null
            val bytes = files.bytes(ref.id, before.number, entry.path, limit = MAX_DIFF_BYTES)
            before.label to ArtifactMarkdown.prepare(String(bytes, Charsets.UTF_8))
        } catch (e: CancellationException) {
            throw e
        } catch (_: Exception) {
            null
        }
    }

    private suspend fun gallery(version: ArtifactVersion, shown: List<ArtifactFile>): ArtifactUi {
        val media = media(version)
        val items = shown.map { media.media(it, labels(it.isVideo, it.name)) }
        awaitSizes(media, items, durations = true)
        return ArtifactUi.Gallery(items)
    }

    /** Waits for the items' sizes (and a recording's length), no longer than [sizeWait]; the rest land as they come. */
    private suspend fun awaitSizes(media: ArtifactMedia, items: List<ArtifactMediaItem>, durations: Boolean = false) {
        if (items.isEmpty()) return
        val all = scope.async {
            items.map { item ->
                async {
                    media.pixelSize(item.key)
                    if (durations && item.isVideo) media.duration(item.key)
                }
            }.awaitAll()
        }
        withTimeoutOrNull(sizeWait) { all.await() }
    }

    /** Where [raw], a link in the document at [document], leads. */
    fun link(raw: String, document: String): ArtifactLink {
        val version = version ?: return ArtifactLink.Nothing
        return when (val reference = ArtifactMarkdown.resolve(raw, document)) {
            is ArtifactReference.File -> {
                val file = version.files.firstOrNull { it.path == reference.path } ?: return ArtifactLink.Missing
                val media = media
                if (file.isVisual && !file.isMarkdown && media != null) ArtifactLink.View(media.media(file, labels(file.isVideo, file.name)))
                else ArtifactLink.File(version.number, file.path)
            }
            is ArtifactReference.Web -> ArtifactLink.Web(reference.url)
            is ArtifactReference.External -> ArtifactLink.External(reference.url)
            else -> ArtifactLink.Nothing
        }
    }

    fun close() {
        loading?.cancel()
        media?.close()
    }

    companion object {
        /** How long the first drawing waits for the pictures' sizes. */
        const val SIZE_WAIT = 1_000L

        /** A Markdown version this new opens on its diff against the one before (desktop's 20 minutes). */
        const val FRESH_DIFF_MILLIS = 20 * 60 * 1_000L

        /** The most of the version before that is read to diff against. */
        const val MAX_DIFF_BYTES = 2L * 1024 * 1024
    }
}
