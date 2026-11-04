package com.slopus.happy.ui.surfaces

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.RowScope
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.widthIn
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import com.slopus.happy.R
import com.slopus.happy.agent.SurfaceType
import com.slopus.happy.ui.artifacts.PlaceScaffold
import com.slopus.happy.ui.artifacts.PlaceTags
import com.slopus.happy.ui.components.LoadingIndicator
import com.slopus.happy.ui.components.RoundButton
import com.slopus.happy.ui.components.RoundButtonSize
import com.slopus.happy.ui.components.Seedling
import com.slopus.happy.ui.components.SeedlingEmptySpec
import com.slopus.happy.ui.theme.HappyTheme
import com.slopus.happy.ui.theme.happyTextStyle

object SurfaceTags {
    const val ELSEWHERE = "surface.elsewhere"
    const val MISSING = "surface.missing"
    const val EMPTY = "surface.empty"
    const val EMPTY_MARK = "surface.empty.mark"
    const val EMPTY_TEXT = "surface.empty.text"
    const val EMPTY_BUTTON = "surface.empty.button"
    const val REFERENCE = "surface.reference"
}

/** iOS's `EmptyLayout.Metrics.buttonGap`. */
object SurfaceSpec {
    val buttonGap = 24.dp
}

/**
 * A kind of Surface the phone doesn't open (iOS's
 * `SurfaceElsewhereViewController`): its name in the bar, and the seedling
 * over a line saying to open it on the computer.
 */
@Composable
fun SurfaceElsewhere(name: String, onBack: () -> Unit, actions: @Composable RowScope.() -> Unit = {}) {
    PlaceScaffold(name, onBack, SurfaceTags.ELSEWHERE, actions = actions) {
        SeedlingEmpty(stringResource(R.string.agent_surface_open_on_computer))
    }
}

/**
 * A Surface the catalog doesn't know: read while the catalog isn't, then
 * desktop's missing page ("It may belong to a Happy Agent this one can't
 * reach").
 */
@Composable
internal fun SurfaceMissing(name: String, loading: Boolean, onBack: () -> Unit) {
    PlaceScaffold(name, onBack, SurfaceTags.MISSING) {
        if (loading) LoadingIndicator(Modifier.testTag(PlaceTags.LOADER))
        else SeedlingEmpty(stringResource(R.string.surface_missing))
    }
}

/**
 * iOS's `EmptyView` (`EmptyLayout`): the 64 seedling (seed "v2"), 20 above
 * a medium 16 line in the row grey, centred as one block, the line at most
 * 360 wide and 24 in from the sides; its [button], if any, 24 under it.
 */
@Composable
internal fun SeedlingEmpty(text: String, modifier: Modifier = Modifier, button: Pair<String, () -> Unit>? = null) {
    Box(modifier.fillMaxSize().testTag(SurfaceTags.EMPTY), contentAlignment = Alignment.Center) {
        Column(horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.Top) {
            Seedling("v2", SeedlingEmptySpec.mark, Modifier.testTag(SurfaceTags.EMPTY_MARK))
            Spacer(Modifier.height(SeedlingEmptySpec.markGap))
            Text(
                text,
                style = happyTextStyle(fontSize = 16, lineHeight = 21, weight = FontWeight.Medium),
                color = HappyTheme.colors.textSecondary,
                textAlign = TextAlign.Center,
                modifier = Modifier
                    .padding(horizontal = SeedlingEmptySpec.sideInset)
                    .widthIn(max = SeedlingEmptySpec.maxWidth)
                    .fillMaxWidth()
                    .testTag(SurfaceTags.EMPTY_TEXT),
            )
            if (button != null) {
                Spacer(Modifier.height(SurfaceSpec.buttonGap))
                RoundButton(
                    button.first,
                    onClick = button.second,
                    modifier = Modifier.padding(horizontal = SeedlingEmptySpec.sideInset).widthIn(max = SeedlingEmptySpec.maxWidth).testTag(SurfaceTags.EMPTY_BUTTON),
                    size = RoundButtonSize.Normal,
                )
            }
        }
    }
}

/**
 * An artifact, bot or task kept among the Surfaces, when opening it did not
 * go straight to it (desktop's `HappyAgentSurfaceReferencePage`): what it
 * points at with a button to open it where it always opens; or, quietly,
 * that it isn't there for this reader, the Surface keeping its place in
 * case it comes back.
 */
@Composable
internal fun SurfaceReference(name: String, type: String, target: Any?, targetName: String?, onBack: () -> Unit, open: (Any) -> Unit, actions: @Composable RowScope.() -> Unit = {}) {
    PlaceScaffold(name, onBack, SurfaceTags.REFERENCE, actions = actions) {
        if (target != null) {
            val label = stringResource(if (type == SurfaceType.ARTIFACT) R.string.surface_open_artifact else R.string.surface_open_chat)
            SeedlingEmpty(targetName?.takeIf { it.isNotEmpty() } ?: name, button = label to { open(target) })
        } else {
            val gone = stringResource(if (type == SurfaceType.ARTIFACT) R.string.surface_gone_deleted else R.string.surface_gone_archived)
            SeedlingEmpty(stringResource(R.string.surface_unavailable, name) + "\n" + gone)
        }
    }
}
