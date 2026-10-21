package com.slopus.happy.ui.components

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.interaction.collectIsPressedAsState
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.defaultMinSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import com.slopus.happy.ui.theme.HappyTheme
import com.slopus.happy.ui.theme.happyTextStyle
import kotlin.math.roundToInt

object RoundButtonTags {
    const val CONTAINER = "roundButton.container"
    const val LABEL = "roundButton.label"
}

/** RoundButton.tsx sizes: height, label size, horizontal padding. */
enum class RoundButtonSize(val height: Dp, val fontSize: Int, val paddingHorizontal: Dp) {
    Large(50.dp, 17, 24.dp),
    Normal(44.dp, 15, 20.dp),
    Small(32.dp, 13, 14.dp);

    /** Math.round(fontSize * 1.3) */
    val lineHeight: Int get() = (fontSize * 1.3).roundToInt()
}

/** `Default` is the one filled action on a screen; `Inverted` is the quiet text action under it. */
enum class RoundButtonDisplay { Default, Inverted }

/**
 * Spec: stretches to the parent's width, min width 64, min height from the
 * size, fully rounded. Filled: label semibold, one line, light pill with dark
 * text in the dark theme. Inverted: no fill, 8 vertical padding so the label
 * can wrap, label regular in the secondary text colour. Disabled is 50%
 * opacity. While loading the label keeps its space but is hidden under a spinner;
 * with a [loadingTitle] the spinner sits 10 before that title instead.
 */
@Composable
fun RoundButton(
    title: String,
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
    size: RoundButtonSize = RoundButtonSize.Large,
    display: RoundButtonDisplay = RoundButtonDisplay.Default,
    enabled: Boolean = true,
    loading: Boolean = false,
    loadingTitle: String? = null,
) {
    val colors = HappyTheme.colors
    val interactionSource = remember { MutableInteractionSource() }
    val pressed by interactionSource.collectIsPressedAsState()
    val inverted = display == RoundButtonDisplay.Inverted

    val background: Color
    val pressedBackground: Color
    val textColor: Color
    if (inverted) {
        background = Color.Transparent
        pressedBackground = colors.surfacePressedOverlay
        textColor = colors.textSecondary
    } else {
        background = if (colors.dark) Color(0xFFF5F5F5) else colors.button.primaryBackground
        pressedBackground = if (colors.dark) Color(0xFFD9D9D9) else Color(0xFF333333)
        textColor = if (colors.dark) Color(0xFF111111) else colors.button.primaryTint
    }

    Box(
        modifier = modifier
            .fillMaxWidth()
            .alpha(if (enabled) 1f else 0.5f)
            .defaultMinSize(minWidth = 64.dp, minHeight = size.height)
            .testTag(RoundButtonTags.CONTAINER)
            .clip(RoundedCornerShape(percent = 50))
            .background(if (pressed) pressedBackground else background)
            .clickable(
                interactionSource = interactionSource,
                indication = null,
                enabled = enabled && !loading,
                role = Role.Button,
                onClick = onClick,
            )
            .padding(horizontal = size.paddingHorizontal, vertical = if (inverted) 8.dp else 0.dp),
        contentAlignment = Alignment.Center,
    ) {
        val label = @Composable { text: String, visible: Boolean ->
            Text(
                text = text,
                style = happyTextStyle(
                    fontSize = size.fontSize,
                    lineHeight = size.lineHeight,
                    weight = if (inverted) FontWeight.Medium else FontWeight.SemiBold,
                ),
                color = textColor,
                textAlign = TextAlign.Center,
                maxLines = if (inverted) Int.MAX_VALUE else 1,
                overflow = TextOverflow.Ellipsis,
                modifier = Modifier
                    .alpha(if (visible) 1f else 0f)
                    .testTag(RoundButtonTags.LABEL),
            )
        }
        if (loading && loadingTitle != null) {
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                CircularProgressIndicator(modifier = Modifier.size(20.dp), color = textColor, strokeWidth = 2.dp)
                label(loadingTitle, true)
            }
        } else {
            label(title, !loading)
            if (loading) {
                CircularProgressIndicator(modifier = Modifier.size(20.dp), color = textColor, strokeWidth = 2.dp)
            }
        }
    }
}
