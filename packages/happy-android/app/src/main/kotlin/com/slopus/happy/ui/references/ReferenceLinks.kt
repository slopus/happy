package com.slopus.happy.ui.references

import androidx.compose.runtime.Composable
import androidx.compose.runtime.SideEffect
import androidx.compose.runtime.remember
import androidx.compose.ui.res.stringResource
import androidx.navigation.NavHostController
import com.slopus.happy.R
import com.slopus.happy.references.HappyReferences
import com.slopus.happy.references.ReferenceReader
import com.slopus.happy.references.ReferenceWords
import com.slopus.happy.references.References
import com.slopus.happy.ui.artifacts.ArtifactRoute
import com.slopus.happy.ui.connection.HappyLinks
import com.slopus.happy.ui.conversation.openConversation

/**
 * Where the app's own links in a connection's screens go (iOS
 * ChatViewController's `open(link:)`): a reference a message named opens
 * what it names, an artifact at the version it pinned and a conversation
 * as its row would; a mention opens nothing; a Happy URL goes to
 * [HappyLinks]. Anything else is the caller's.
 */
class ReferenceOpener(
    private val nav: NavHostController,
    private val connectionId: String,
    private val reader: ReferenceReader?,
    private val happyLinks: HappyLinks?,
) {
    /** True when [url] was the app's, opened or not; false for any other address. */
    fun open(url: String): Boolean {
        HappyReferences.reference(url)?.let {
            open(it)
            return true
        }
        if (HappyReferences.owns(url)) return true
        return happyLinks?.open(url, connectionId) ?: com.slopus.happy.agent.HappyUrls.owns(url)
    }

    /** Whether a tap on [url] opens anything here: an address that isn't the app's does, as does a reference; a Happy URL as [HappyLinks.opens] says. */
    fun opens(url: String): Boolean = when {
        HappyReferences.reference(url) != null -> true
        HappyReferences.owns(url) -> false
        com.slopus.happy.agent.HappyUrls.owns(url) -> happyLinks?.opens(url, connectionId) == true
        else -> true
    }

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
    )
    val other = stringResource(R.string.reference_unavailable)
    return remember(artifact, untitledArtifact, untitledAgent, untitledWorkspace, subagent, kinds, other) {
        ReferenceWords(artifact, untitledArtifact, untitledAgent, untitledWorkspace, subagent, kinds, other)
    }
}

/** Gives [reader] the app's words, before the rows that read them are built, and again when the language changes. */
@Composable
fun ProvideReferenceWords(reader: ReferenceReader) {
    val words = rememberReferenceWords()
    SideEffect { reader.setWords(words) }
}
