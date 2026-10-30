package com.slopus.happy.ui.conversation

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.navigationBars
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.windowInsetsPadding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.Text
import androidx.compose.material3.TopAppBar
import androidx.compose.material3.TopAppBarDefaults
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import com.slopus.happy.R
import com.slopus.happy.chat.markdown.parseMarkdown
import com.slopus.happy.conversation.Artifact
import com.slopus.happy.conversation.ArtifactFile
import com.slopus.happy.conversation.ArtifactView
import com.slopus.happy.ui.chat.MarkdownView
import com.slopus.happy.ui.components.Ionicon
import com.slopus.happy.ui.components.MaterialSymbols
import com.slopus.happy.ui.components.RemoteImage
import com.slopus.happy.ui.components.StateArt
import com.slopus.happy.ui.components.StatePage
import com.slopus.happy.ui.theme.HappyTheme

object ArtifactTags {
    const val SCREEN = "artifact.screen"
    const val LOADING = "artifact.loading"
    const val WORDS = "artifact.words"
    const val PICTURE = "artifact.picture"
    const val OPEN = "artifact.open"
    const val NOT_HERE = "artifact.notHere"
}

/** What the artifact screen draws: the artifact, what it could read of it, or why it couldn't. */
sealed interface ArtifactContent {
    data object Reading : ArtifactContent
    data class Ready(val artifact: Artifact, val view: ArtifactView, val pictures: Map<String, ByteArray>) : ArtifactContent
    data class Failed(val reason: String) : ArtifactContent
}

/**
 * One artifact of the paired computer: its words read and drawn here, its
 * pictures shown here and opened full screen on a tap, a video or document
 * handed to whatever on the phone reads it. A page, a sidebar, a story or
 * a live URL is not something this build draws, and the screen says so
 * instead of pretending.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun ArtifactScreen(
    content: ArtifactContent,
    onBack: () -> Unit,
    onRetry: () -> Unit,
    onOpenPicture: (bytes: ByteArray, cacheKey: String, name: String?) -> Unit,
    onOpenFile: (ArtifactFile) -> Unit,
    opening: MediaOpening? = null,
) {
    val colors = HappyTheme.colors
    val ready = content as? ArtifactContent.Ready
    Column(Modifier.fillMaxSize().background(colors.surface).testTag(ArtifactTags.SCREEN)) {
        TopAppBar(
            title = {
                Text(
                    ready?.artifact?.title?.takeIf { it.isNotBlank() } ?: stringResource(R.string.conversation_artifact),
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                )
            },
            navigationIcon = {
                IconButton(onClick = onBack, modifier = Modifier.testTag(ConversationScreenTags.BACK)) {
                    Icon(MaterialSymbols.ArrowBack, stringResource(R.string.conversation_back))
                }
            },
            colors = TopAppBarDefaults.topAppBarColors(
                containerColor = colors.surface,
                scrolledContainerColor = colors.surface,
                titleContentColor = colors.text,
                navigationIconContentColor = colors.text,
            ),
        )
        Box(Modifier.weight(1f).fillMaxWidth().windowInsetsPadding(WindowInsets.navigationBars)) {
            when (content) {
                is ArtifactContent.Reading -> StatePage(title = null, body = null, art = StateArt.Waiting, tag = ArtifactTags.LOADING)
                is ArtifactContent.Failed -> StatePage(
                    title = stringResource(R.string.conversation_artifact_failed),
                    body = content.reason,
                    icon = Ionicon.CloudOfflineOutline,
                    action = stringResource(R.string.common_retry) to onRetry,
                    tag = ConversationScreenTags.ERROR,
                )
                is ArtifactContent.Ready -> when (val view = content.view) {
                    is ArtifactView.Words -> Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(16.dp).testTag(ArtifactTags.WORDS)) {
                        MarkdownView(parseMarkdown(view.markdown))
                    }
                    is ArtifactView.Pictures -> Column(
                        Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(16.dp),
                        verticalArrangement = Arrangement.spacedBy(12.dp),
                    ) {
                        view.files.forEach { file ->
                            val bytes = content.pictures[file.path]
                            if (bytes != null) {
                                RemoteImage(
                                    model = bytes,
                                    cacheKey = "artifact/${content.artifact.id}/${content.artifact.version}/${file.path}",
                                    contentDescription = file.path,
                                    contentScale = ContentScale.Fit,
                                    modifier = Modifier
                                        .fillMaxWidth()
                                        .testTag(ArtifactTags.PICTURE)
                                        .clickable(role = Role.Button) {
                                            onOpenPicture(bytes, "artifact/${content.artifact.id}/${content.artifact.version}/${file.path}", file.path)
                                        },
                                )
                            }
                        }
                    }
                    is ArtifactView.Openable -> ArtifactOpenCard(view.file, opening, onOpenFile)
                    is ArtifactView.NotHere -> StatePage(
                        title = null,
                        body = stringResource(R.string.conversation_artifact_kind_unavailable, view.kind),
                        icon = Ionicon.LayersOutline,
                        tag = ArtifactTags.NOT_HERE,
                    )
                }
            }
        }
    }
}

@Composable
private fun ArtifactOpenCard(file: ArtifactFile, opening: MediaOpening?, onOpenFile: (ArtifactFile) -> Unit) {
    val colors = HappyTheme.colors
    Column(Modifier.fillMaxSize().padding(16.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
        Text(file.path, color = colors.text)
        Text(
            when (opening) {
                is MediaOpening.Failed -> opening.reason
                MediaOpening.Reading -> stringResource(R.string.conversation_media_reading)
                null -> stringResource(R.string.conversation_artifact_open)
            },
            color = colors.textSecondary,
            modifier = Modifier
                .testTag(ArtifactTags.OPEN)
                .clickable(role = Role.Button) { onOpenFile(file) }
                .padding(vertical = 8.dp),
        )
    }
}
