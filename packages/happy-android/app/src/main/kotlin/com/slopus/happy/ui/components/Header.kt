package com.slopus.happy.ui.components

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.defaultMinSize
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.statusBars
import androidx.compose.foundation.layout.windowInsetsPadding
import androidx.compose.material3.Text
import androidx.compose.material3.ripple
import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import com.slopus.happy.R
import com.slopus.happy.ui.theme.HappyTheme
import com.slopus.happy.ui.theme.happyTextStyle

object HeaderTags {
    const val BAR = "header.bar"
    const val LEFT = "header.left"
    const val RIGHT = "header.right"
    const val TITLE_BOX = "header.titleBox"
    const val TITLE = "header.title"
    const val SUBTITLE = "header.subtitle"
}

/** navigation/Header.tsx on an Android phone. */
object HeaderSpec {
    /** React Navigation's default Android header height. */
    val height = 64.dp
    val paddingHorizontal = 16.dp
    val gap = 8.dp
    val controlSlot = 48.dp
    val centeredTitleInset = 64.dp
    val title = happyTextStyle(fontSize = 16, lineHeight = 20, weight = FontWeight.SemiBold)
    val subtitle = happyTextStyle(fontSize = 12, lineHeight = 16)
}

enum class TitleAlignment { Start, Center }

/**
 * Spec: status-bar inset, then a 64 bar with 16 side padding and 8 gaps.
 * Left and right controls sit in 48x48 slots (wider if the control is).
 * A start-aligned title fills the space between them; a centred title is
 * laid out 64 in from both edges of the bar, independent of the controls.
 * Title 16 semibold, subtitle 12, both in the header tint. The bar is the
 * header colour, or surfaceHigh once content has scrolled under it. No shadow.
 */
@Composable
fun Header(
    modifier: Modifier = Modifier,
    title: String? = null,
    subtitle: String? = null,
    alignment: TitleAlignment = TitleAlignment.Start,
    scrolled: Boolean = false,
    left: (@Composable () -> Unit)? = null,
    right: (@Composable () -> Unit)? = null,
    titleContent: (@Composable () -> Unit)? = null,
) {
    val colors = HappyTheme.colors
    val titleBlock: @Composable () -> Unit = titleContent ?: {
        Column(horizontalAlignment = if (alignment == TitleAlignment.Center) Alignment.CenterHorizontally else Alignment.Start) {
            if (title != null) {
                Text(
                    text = title,
                    style = HeaderSpec.title,
                    color = colors.header.tint,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                    textAlign = if (alignment == TitleAlignment.Center) TextAlign.Center else TextAlign.Start,
                    modifier = Modifier.testTag(HeaderTags.TITLE).semantics { heading() },
                )
            }
            if (subtitle != null) {
                Text(
                    text = subtitle,
                    style = HeaderSpec.subtitle,
                    color = colors.header.tint,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                    modifier = Modifier.padding(top = 1.dp).testTag(HeaderTags.SUBTITLE),
                )
            }
        }
    }

    Box(
        modifier = modifier
            .fillMaxWidth()
            .background(if (scrolled) colors.surfaceHigh else colors.header.background)
            .windowInsetsPadding(WindowInsets.statusBars),
    ) {
        Row(
            modifier = Modifier
                .fillMaxWidth()
                .height(HeaderSpec.height)
                .testTag(HeaderTags.BAR)
                .padding(horizontal = HeaderSpec.paddingHorizontal),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(HeaderSpec.gap),
        ) {
            if (left != null) ControlSlot(Modifier.testTag(HeaderTags.LEFT), left)
            Box(
                modifier = Modifier
                    .weight(1f)
                    .fillMaxHeight()
                    .then(if (alignment == TitleAlignment.Start) Modifier.testTag(HeaderTags.TITLE_BOX) else Modifier),
                contentAlignment = Alignment.CenterStart,
            ) {
                if (alignment == TitleAlignment.Start) titleBlock()
            }
            if (right != null) ControlSlot(Modifier.testTag(HeaderTags.RIGHT), right)
        }
        if (alignment == TitleAlignment.Center) {
            Box(
                modifier = Modifier
                    .align(Alignment.BottomCenter)
                    .fillMaxWidth()
                    .height(HeaderSpec.height)
                    .padding(horizontal = HeaderSpec.centeredTitleInset)
                    .testTag(HeaderTags.TITLE_BOX),
                contentAlignment = Alignment.Center,
            ) { titleBlock() }
        }
    }
}

@Composable
private fun ControlSlot(modifier: Modifier, content: @Composable () -> Unit) {
    Box(
        modifier = modifier.defaultMinSize(minWidth = HeaderSpec.controlSlot).height(HeaderSpec.controlSlot),
        contentAlignment = Alignment.Center,
    ) { content() }
}

/** The Android back control: a 48x48 target around a 24 arrow. */
@Composable
fun HeaderBackButton(onClick: () -> Unit) {
    HeaderIconButton(
        icon = Ionicon.ArrowBack,
        iconSize = 24.dp,
        buttonSize = 48.dp,
        contentDescription = stringResource(R.string.common_back),
        onClick = onClick,
    )
}

/** HomeHeader's 32x32 header buttons (settings gear: 22). */
@Composable
fun HeaderIconButton(
    icon: Ionicon,
    contentDescription: String,
    onClick: () -> Unit,
    iconSize: androidx.compose.ui.unit.Dp = 22.dp,
    buttonSize: androidx.compose.ui.unit.Dp = 32.dp,
) {
    val colors = HappyTheme.colors
    Box(
        modifier = Modifier
            .size(buttonSize)
            .clickable(
                interactionSource = remember { MutableInteractionSource() },
                indication = ripple(bounded = false, radius = 24.dp, color = colors.text),
                role = Role.Button,
                onClick = onClick,
            ),
        contentAlignment = Alignment.Center,
    ) {
        Icon(icon = icon, size = iconSize, color = colors.header.tint, contentDescription = contentDescription)
    }
}
