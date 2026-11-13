package com.slopus.happy.ui.artifacts

import androidx.compose.runtime.Composable
import androidx.compose.ui.res.stringResource
import com.slopus.happy.R
import com.slopus.happy.ui.components.Ionicon

/** Desktop's `ArtifactTypeGlyph` (iOS's `ChatMediaPlan.glyph`): an artifact card's glyph by its type. */
fun artifactCardGlyph(type: String): Ionicon = when (type) {
    "markdown" -> Ionicon.DocumentTextOutline
    "html" -> Ionicon.GlobeOutline
    "image" -> Ionicon.ImageOutline
    "image_series" -> Ionicon.Images
    "video" -> Ionicon.Videocam
    "document" -> Ionicon.DocumentOutline
    "gen_ui" -> Ionicon.CodeWorkingOutline
    else -> Ionicon.CubeOutline
}

/**
 * An artifact card's detail (iOS's `Strings.artifactDetail`): a creation's
 * card names its kind, a change's also the version it made. An HTML page
 * that runs as an app ([app]) is an App.
 */
@Composable
fun artifactCardDetail(type: String, version: Int, app: Boolean = false): String {
    val kind = when {
        app -> stringResource(R.string.artifact_kind_app)
        else -> artifactCardKind(type)
    }
    return if (version == 1) kind else stringResource(R.string.artifact_card_version, kind, version)
}

@Composable
private fun artifactCardKind(type: String): String =
    when (type) {
        "markdown" -> stringResource(R.string.artifact_card_kind_markdown)
        "html" -> stringResource(R.string.artifact_kind_html)
        "image" -> stringResource(R.string.artifact_kind_image)
        "image_series" -> stringResource(R.string.artifact_card_kind_image_series)
        "video" -> stringResource(R.string.artifact_kind_video)
        "document" -> stringResource(R.string.artifact_card_kind_document)
        "gen_ui" -> stringResource(R.string.artifact_kind_gen_ui)
        else -> stringResource(R.string.artifact_kind_unknown)
    }
