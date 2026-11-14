package com.slopus.happy.ui.references

import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.getValue
import androidx.compose.runtime.SideEffect
import androidx.compose.runtime.remember
import androidx.compose.ui.res.stringResource
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.navigation.NavHostController
import com.slopus.happy.R
import com.slopus.happy.references.HappyReferences
import com.slopus.happy.references.ReferenceReader
import com.slopus.happy.references.ReferenceWords
import com.slopus.happy.references.References
import com.slopus.happy.ui.artifacts.ArtifactRoute
import com.slopus.happy.ui.chat.BusyLinks
import com.slopus.happy.ui.chat.LocalBusyLinks
import com.slopus.happy.ui.connection.HappyLinks
import com.slopus.happy.ui.conversation.openConversation

/**
 * Where the app's own links in a connection's screens go (iOS
 * ChatViewController's `open(link:)`), read from the link's own address: a
 * Happy URL or a share link naming what this connection holds opens it, an
 * artifact at the version it pinned, a Surface, and a conversation as its
 * row would; a mention opens nothing; any other Happy URL or share link goes
 * to [HappyLinks], which says when its server isn't connected. Anything else
 * is the caller's.
 */
class ReferenceOpener(
    private val nav: NavHostController,
    private val connectionId: String,
    private val reader: ReferenceReader?,
    private val happyLinks: HappyLinks?,
    /** Whether an installation is this connection's: a link locked to it reads as one of its own. */
    private val here: (String) -> Boolean = { false },
) {
    /** True when [url] was the app's, opened or not; false for any other address. */
    fun open(url: String): Boolean {
        resolve(url)?.let {
            open(it)
            return true
        }
        if (HappyReferences.mention(url)) return true
        return happyLinks?.open(url, connectionId) ?: HappyReferences.opensInApp(url)
    }

    /** Whether a tap on [url] opens anything here: an address that isn't the app's does; a Happy URL or share link as [HappyLinks.opens] says. */
    fun opens(url: String): Boolean = when {
        HappyReferences.mention(url) -> false
        resolve(url) != null -> true
        HappyReferences.opensInApp(url) -> happyLinks?.opens(url, connectionId) == true
        else -> true
    }

    /** The reference [url] names when this connection holds it ([References.resolve]): an in-app link. */
    fun resolve(url: String): HappyReferences.Reference? = (reader?.references?.value ?: References()).resolve(url, here)

    /** Whether [url] names a conversation of this connection's whose work runs now ([References.busy]). */
    fun busy(url: String, references: References, busy: Set<String>): Boolean = references.busy(url, here, busy)

    /** What [reference] names, over this screen. */
    fun open(reference: HappyReferences.Reference) {
        val references = reader?.references?.value ?: References()
        if (reference.kind == "artifact") {
            // Still being read, the viewer reads it itself.
            val known = when (val read = references.artifacts[reference.id]) {
                is References.Artifact.Active -> read
                null -> {
                    reader?.readArtifacts(listOf(reference.id))
                    References.Artifact.Active("", "", 1)
                }
                else -> return
            }
            nav.navigate(
                ArtifactRoute(
                    connectionId, reference.id,
                    version = reference.version ?: known.latestVersion,
                    type = known.type,
                    title = known.title,
                    followsLatest = reference.version == null,
                    pinned = reference.version != null,
                ),
            )
            return
        }
        if (reference.kind == "surface") {
            val name = references.surfaces[reference.id] ?: return
            nav.navigate(com.slopus.happy.ui.surfaces.SurfaceRoute(connectionId, reference.id, name))
            return
        }
        val entity = references.entity(reference) ?: return
        nav.openConversation(connectionId, entity.agentId)
    }
}

/** The words references read as where nothing names them, in the app's language. */
@Composable
fun rememberReferenceWords(): ReferenceWords {
    val artifact = stringResource(R.string.reference_artifact)
    val untitledArtifact = stringResource(R.string.artifact_untitled)
    val untitledAgent = stringResource(R.string.reference_untitled_agent)
    val untitledWorkspace = stringResource(R.string.reference_untitled_workspace)
    val subagent = stringResource(R.string.agent_page_subagent)
    val kinds = mapOf(
        "artifact" to stringResource(R.string.reference_unavailable_artifact),
        "agent" to stringResource(R.string.reference_unavailable_agent),
        "workspace" to stringResource(R.string.reference_unavailable_workspace),
        "project" to stringResource(R.string.reference_unavailable_project),
        "service" to stringResource(R.string.reference_unavailable_service),
        "user" to stringResource(R.string.reference_unavailable_user),
        "surface" to stringResource(R.string.reference_unavailable_surface),
    )
    val other = stringResource(R.string.reference_unavailable)
    val untitledSurface = stringResource(R.string.document_untitled)
    return remember(artifact, untitledArtifact, untitledAgent, untitledWorkspace, subagent, kinds, other, untitledSurface) {
        ReferenceWords(artifact, untitledArtifact, untitledAgent, untitledWorkspace, subagent, kinds, other, untitledSurface)
    }
}

/**
 * Links under [content] to a conversation of [opener]'s connection that
 * works now shimmer ([LocalBusyLinks]), following [reader] as turns start
 * and end.
 */
@Composable
fun ProvideBusyLinks(opener: ReferenceOpener, reader: ReferenceReader, content: @Composable () -> Unit) {
    val references by reader.references.collectAsStateWithLifecycle()
    val busy by reader.busy.collectAsStateWithLifecycle()
    val links = remember(opener, references, busy) { BusyLinks { url -> opener.busy(url, references, busy) } }
    CompositionLocalProvider(LocalBusyLinks provides links, content = content)
}

/** Gives [reader] the app's words, before the rows that read them are built, and again when the language changes. */
@Composable
fun ProvideReferenceWords(reader: ReferenceReader) {
    val words = rememberReferenceWords()
    SideEffect { reader.setWords(words) }
}
