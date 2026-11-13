package com.slopus.happy.ui.attach

import androidx.compose.animation.animateColorAsState
import androidx.compose.animation.core.Animatable
import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.animation.core.snap
import androidx.compose.animation.core.tween
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import com.slopus.happy.ui.components.PageProgressIndicator as CircularProgressIndicator
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.material3.ripple
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.ui.text.TextRange
import androidx.compose.ui.text.input.TextFieldValue
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.pluralStringResource
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.role
import androidx.compose.ui.semantics.selected
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.stateDescription
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.slopus.happy.R
import com.slopus.happy.attachments.AttachTabKind
import com.slopus.happy.ui.components.GlassColors
import com.slopus.happy.ui.components.GlassSource
import com.slopus.happy.ui.components.MaterialSymbols
import com.slopus.happy.ui.components.glass
import com.slopus.happy.ui.components.rememberGlassBlur
import com.slopus.happy.ui.components.rememberReduceMotion
import com.slopus.happy.ui.theme.HappyTheme
import com.slopus.happy.ui.theme.happyTextStyle

/**
 * The tab bar along the sheet's foot: a 56 glass pill, 7 in from a 70 bar,
 * tabs 48 tall inside 11. With few tabs Telegram narrows it to 80 a tab and
 * 36 more, centred. The selected tab sits on a stadium of its colour at 9%
 * that grows from 0.6 in 320 ms; each tab pops in on the open's clock
 * ([openElapsed], ms) as Telegram's `ATTACH_ALERT_PROGRESS` does.
 */
@Composable
internal fun AttachTabBar(
    tabs: List<AttachTabKind>,
    selected: AttachTabKind,
    onSelect: (AttachTabKind) -> Unit,
    openElapsed: () -> Float,
    backdrop: GlassSource?,
    colors: AttachColors,
    modifier: Modifier = Modifier,
) {
    val theme = HappyTheme.colors
    val blurs = rememberGlassBlur()
    BoxWithConstraints(modifier.fillMaxWidth().height(AttachSpec.tabBar).testTag(AttachTags.TAB_BAR), contentAlignment = Alignment.Center) {
        val width = AttachSpec.tabBarWidth(tabs.size, maxWidth)
        val shape = RoundedCornerShape(AttachSpec.tabBarCorner)
        Box(Modifier.width(width).fillMaxHeight()) {
            Box(
                Modifier
                    .fillMaxSize()
                    .padding(AttachSpec.tabBarInset)
                    .glass(backdrop, shape, GlassColors.of(theme.dark), blurs),
            )
            Row(Modifier.fillMaxSize().padding(AttachSpec.tabPadding)) {
                tabs.forEachIndexed { index, tab ->
                    AttachTab(
                        tab,
                        tab == selected,
                        colors,
                        onClick = { onSelect(tab) },
                        modifier = Modifier
                            .weight(1f)
                            .fillMaxHeight()
                            .graphicsLayer {
                                val elapsed = openElapsed()
                                val scale = AttachMotion.tabScale(index, elapsed)
                                scaleX = scale
                                scaleY = scale
                                alpha = AttachMotion.tabAlpha(index, elapsed)
                            },
                    )
                }
            }
        }
    }
}

@Composable
private fun AttachTab(tab: AttachTabKind, selected: Boolean, colors: AttachColors, onClick: () -> Unit, modifier: Modifier) {
    val reduceMotion = rememberReduceMotion()
    val spec = if (reduceMotion) snap<Float>() else tween(AttachMotion.TAB_SELECT_MS, easing = AttachMotion.decelerate)
    val progress by animateFloatAsState(if (selected) 1f else 0f, spec, label = "tab selected")
    val colorSpec = if (reduceMotion) snap<Color>() else tween(AttachMotion.TAB_SELECT_MS, easing = AttachMotion.decelerate)
    val icon by animateColorAsState(if (selected) colors.tabSelected else colors.tab, colorSpec, label = "tab icon")
    val label by animateColorAsState(if (selected) colors.tabSelectedText else colors.tab, colorSpec, label = "tab label")
    val title = stringResource(tabTitle(tab))
    Box(
        modifier
            .clip(RoundedCornerShape(50))
            .clickable(
                interactionSource = remember { MutableInteractionSource() },
                indication = ripple(color = colors.tabSelected),
                onClick = onClick,
            )
            .semantics {
                role = Role.Tab
                this.selected = selected
            }
            .testTag(AttachTags.tab(tab)),
    ) {
        Box(
            Modifier
                .fillMaxSize()
                .graphicsLayer {
                    val scale = AttachSpec.TAB_SELECTED_FROM + (1 - AttachSpec.TAB_SELECTED_FROM) * progress
                    scaleX = scale
                    scaleY = scale
                    alpha = progress
                }
                .clip(RoundedCornerShape(50))
                .background(colors.tabSelected.copy(alpha = AttachSpec.TAB_SELECTED_ALPHA)),
        )
        Icon(
            if (selected) tab.selectedIcon else tab.icon,
            contentDescription = null,
            tint = icon,
            modifier = Modifier.align(Alignment.TopCenter).padding(top = AttachSpec.tabIconTop).size(AttachSpec.tabIcon),
        )
        Text(
            title,
            style = happyTextStyle(11, weight = if (selected) FontWeight.ExtraBold else FontWeight.Bold).copy(fontSize = AttachSpec.tabLabel, lineHeight = 13.sp),
            color = label,
            maxLines = 1,
            modifier = Modifier.align(Alignment.TopCenter).padding(top = AttachSpec.tabLabelTop),
        )
    }
}

private val AttachTabKind.icon
    get() = when (this) {
        AttachTabKind.Gallery -> MaterialSymbols.PhotoLibraryOutlined
        AttachTabKind.Files -> MaterialSymbols.InsertDriveFileOutlined
    }

private val AttachTabKind.selectedIcon
    get() = when (this) {
        AttachTabKind.Gallery -> MaterialSymbols.PhotoLibrary
        AttachTabKind.Files -> MaterialSymbols.InsertDriveFile
    }

/**
 * The caption bar that takes the tab bar's place once something is picked:
 * a glass field of 22 corners, 7 in, at most five lines and then it
 * scrolls, and at the far end the confirm pill (a check and the count, in
 * Telegram's blue), whose count bounces 0.9 → 1 in 180 ms at each change.
 * The pill puts the picks in the composer ([onConfirm]); nothing is sent
 * from here. [shown] is the 180 ms decelerated progress the bar comes in
 * on: the field fades, the pill grows from 0.2.
 */
@Composable
internal fun AttachCaptionBar(
    caption: String,
    onCaptionChange: (String) -> Unit,
    count: Int,
    onConfirm: () -> Unit,
    busy: Boolean,
    shown: () -> Float,
    backdrop: GlassSource?,
    colors: AttachColors,
    modifier: Modifier = Modifier,
) {
    val theme = HappyTheme.colors
    val blurs = rememberGlassBlur()
    val shape = RoundedCornerShape(AttachSpec.captionCorner)
    val label = stringResource(R.string.attach_title)
    val picked = pluralStringResource(R.plurals.attach_selected, count, count)
    // Its own selection, as the composer keeps one; words set from outside put the caret at their end.
    var field by remember { mutableStateOf(TextFieldValue(caption, TextRange(caption.length))) }
    if (field.text != caption) field = TextFieldValue(caption, TextRange(caption.length))
    Row(
        modifier
            .fillMaxWidth()
            .heightIn(min = AttachSpec.captionBar)
            .padding(start = AttachSpec.captionInset, end = AttachSpec.confirmEnd, top = AttachSpec.captionPadding, bottom = AttachSpec.captionPadding)
            .testTag(AttachTags.CAPTION_BAR),
        verticalAlignment = Alignment.Bottom,
    ) {
        BasicTextField(
            value = field,
            onValueChange = {
                field = it
                if (it.text != caption) onCaptionChange(it.text)
            },
            textStyle = happyTextStyle(16).copy(color = theme.text),
            cursorBrush = SolidColor(colors.accent),
            maxLines = AttachSpec.CAPTION_LINES,
            decorationBox = { inner ->
                Box(Modifier.padding(horizontal = 16.dp, vertical = 11.dp)) {
                    if (caption.isEmpty()) {
                        Text(stringResource(R.string.attach_caption_hint), style = happyTextStyle(16), color = theme.textSecondary, maxLines = 1)
                    }
                    inner()
                }
            },
            modifier = Modifier
                .weight(1f)
                .heightIn(min = AttachSpec.captionField)
                .graphicsLayer { alpha = shown() }
                .glass(backdrop, shape, GlassColors.of(theme.dark), blurs)
                .testTag(AttachTags.CAPTION),
        )
        Box(
            Modifier
                .padding(start = AttachSpec.confirmGap)
                .height(AttachSpec.captionField)
                .graphicsLayer {
                    val p = shown()
                    val scale = AttachSpec.CONFIRM_FROM + (1 - AttachSpec.CONFIRM_FROM) * p
                    scaleX = scale
                    scaleY = scale
                    alpha = p
                },
            contentAlignment = Alignment.Center,
        ) {
            ConfirmPill(
                count,
                busy,
                colors,
                Modifier
                    .clip(RoundedCornerShape(AttachSpec.confirmHeight / 2))
                    .clickable(enabled = !busy, onClick = onConfirm)
                    .semantics {
                        contentDescription = label
                        stateDescription = picked
                        role = Role.Button
                    }
                    .testTag(AttachTags.CONFIRM),
            )
        }
    }
}

/** The pill: a check and the count, or a spinner while the picks are read into the composer. */
@Composable
private fun ConfirmPill(count: Int, busy: Boolean, colors: AttachColors, modifier: Modifier) {
    val reduceMotion = rememberReduceMotion()
    val bounce = remember { Animatable(1f) }
    var seen by remember { mutableIntStateOf(count) }
    LaunchedEffect(count) {
        if (count == seen) return@LaunchedEffect
        seen = count
        if (reduceMotion) return@LaunchedEffect
        bounce.snapTo(AttachMotion.COUNTER_FROM)
        bounce.animateTo(1f, tween(AttachMotion.COUNTER_MS, easing = AttachMotion.counter))
    }
    Box(
        modifier
            .height(AttachSpec.confirmHeight)
            .widthIn(min = AttachSpec.confirmMinWidth)
            .background(colors.accent),
        contentAlignment = Alignment.Center,
    ) {
        Row(
            Modifier
                .padding(start = AttachSpec.confirmStart, end = AttachSpec.confirmTrailing)
                .graphicsLayer { alpha = if (busy) 0f else 1f },
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Icon(MaterialSymbols.Check, contentDescription = null, tint = colors.onAccent, modifier = Modifier.size(AttachSpec.confirmIcon))
            Text(
                count.toString(),
                style = happyTextStyle(16, weight = FontWeight.SemiBold).copy(fontSize = AttachSpec.confirmText),
                color = colors.onAccent,
                maxLines = 1,
                modifier = Modifier
                    .padding(start = AttachSpec.confirmSpacing)
                    .graphicsLayer {
                        scaleX = bounce.value
                        scaleY = bounce.value
                    }
                    .testTag(AttachTags.COUNTER),
            )
        }
        if (busy) CircularProgressIndicator(Modifier.size(18.dp), color = colors.onAccent, strokeWidth = 2.dp)
    }
}

/** "N selected", where the grabber was. */
@Composable
internal fun SelectedHeader(count: Int, modifier: Modifier = Modifier) {
    val theme = HappyTheme.colors
    Text(
        pluralStringResource(R.plurals.attach_selected, count, count),
        style = happyTextStyle(16, weight = FontWeight.Bold).copy(fontSize = AttachSpec.headerText),
        color = theme.text,
        maxLines = 1,
        modifier = modifier.testTag(AttachTags.HEADER),
    )
}
