package com.slopus.happy.ui.attach

import androidx.compose.animation.animateColorAsState
import androidx.compose.animation.core.Animatable
import androidx.compose.animation.core.animateDpAsState
import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.animation.core.snap
import androidx.compose.animation.core.spring
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
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import com.slopus.happy.ui.components.PageProgressIndicator as CircularProgressIndicator
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.material3.ripple
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.ui.focus.onFocusChanged
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
import com.slopus.happy.ui.conversation.ConversationComposerSpec
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
 * The caption bar that takes the tab bar's place once something is picked,
 * drawn as the chat's composer is ([ConversationComposer]) without its [+]
 * and model chips: a glass pill in the composer's margins, 24 corners on one
 * line and 28 in use, the field in the body type with 16 in and 12 above and
 * below, "Type a message ...", and send's 36 circle in the text colour, 6 in
 * from the end at the foot. The words grow to five lines, then scroll.
 * [shown] is the 180 ms decelerated progress the bar comes in on: the pill
 * fades, send grows from 0.2.
 */
@Composable
internal fun AttachCaptionBar(
    caption: String,
    onCaptionChange: (String) -> Unit,
    count: Int,
    onSend: () -> Unit,
    sending: Boolean,
    shown: () -> Float,
    backdrop: GlassSource?,
    colors: AttachColors,
    modifier: Modifier = Modifier,
) {
    val theme = HappyTheme.colors
    val blurs = rememberGlassBlur()
    val reduceMotion = rememberReduceMotion()
    val sendLabel = stringResource(R.string.attach_send)
    var focused by remember { mutableStateOf(false) }
    val open = focused || caption.isNotEmpty()
    val corner by animateDpAsState(
        if (open) ConversationComposerSpec.openCorner else ConversationComposerSpec.restCorner,
        if (reduceMotion) snap() else spring(stiffness = 700f),
        label = "caption corner",
    )
    val shape = RoundedCornerShape(corner)
    val body = MaterialTheme.typography.bodyLarge
    // Its own selection, as the composer keeps one; words set from outside put the caret at their end.
    var field by remember { mutableStateOf(TextFieldValue(caption, TextRange(caption.length))) }
    if (field.text != caption) field = TextFieldValue(caption, TextRange(caption.length))
    Row(
        modifier
            .fillMaxWidth()
            .padding(ConversationComposerSpec.margin)
            .graphicsLayer { alpha = shown() }
            .glass(backdrop, shape, GlassColors.of(theme.dark), blurs)
            .clip(shape)
            .heightIn(min = ConversationComposerSpec.rest)
            .testTag(AttachTags.CAPTION_BAR),
        verticalAlignment = Alignment.Bottom,
    ) {
        BasicTextField(
            value = field,
            onValueChange = {
                field = it
                if (it.text != caption) onCaptionChange(it.text)
            },
            textStyle = body.copy(color = theme.text),
            cursorBrush = SolidColor(theme.text),
            maxLines = AttachSpec.CAPTION_LINES,
            decorationBox = { inner ->
                Box(Modifier.padding(vertical = ConversationComposerSpec.fieldVertical)) {
                    if (caption.isEmpty()) {
                        Text(stringResource(R.string.session_input_placeholder), style = body, color = theme.textSecondary, maxLines = 1)
                    }
                    inner()
                }
            },
            modifier = Modifier
                .weight(1f)
                .padding(start = ConversationComposerSpec.fieldPadding, end = 8.dp)
                .onFocusChanged { focused = it.isFocused }
                .testTag(AttachTags.CAPTION),
        )
        Box(
            Modifier
                .padding(end = 6.dp, bottom = (ConversationComposerSpec.rest - ConversationComposerSpec.primary) / 2)
                .size(ConversationComposerSpec.primary)
                .graphicsLayer {
                    val scale = AttachSpec.SEND_FROM + (1 - AttachSpec.SEND_FROM) * shown()
                    scaleX = scale
                    scaleY = scale
                }
                .clip(CircleShape)
                .background(theme.text)
                .clickable(enabled = !sending && count > 0, onClick = onSend)
                .semantics {
                    contentDescription = sendLabel
                    role = Role.Button
                }
                .testTag(AttachTags.SEND),
            contentAlignment = Alignment.Center,
        ) {
            if (sending) CircularProgressIndicator(Modifier.size(16.dp), color = theme.surface, strokeWidth = 2.dp)
            else Icon(MaterialSymbols.ArrowUpward, contentDescription = null, tint = theme.surface, modifier = Modifier.size(20.dp))
        }
    }
}

/**
 * The confirm pill at the header's far end: a check and the count in the
 * composer send button's colours ([AttachColors.accent]), the count
 * bouncing 0.9 → 1 in 180 ms at each change, or a spinner while the picks
 * are read. It puts the picks in the composer ([onConfirm]); nothing is
 * sent.
 */
@Composable
internal fun ConfirmPill(count: Int, busy: Boolean, enabled: Boolean, colors: AttachColors, onConfirm: () -> Unit, modifier: Modifier = Modifier) {
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
    val label = stringResource(R.string.attach_title)
    val picked = pluralStringResource(R.plurals.attach_selected, count, count)
    Box(
        modifier
            .height(AttachSpec.confirmHeight)
            .widthIn(min = AttachSpec.confirmMinWidth)
            .clip(RoundedCornerShape(AttachSpec.confirmHeight / 2))
            .background(colors.accent)
            .clickable(enabled = enabled && !busy, onClick = onConfirm)
            .semantics {
                contentDescription = label
                stateDescription = picked
                role = Role.Button
            }
            .testTag(AttachTags.CONFIRM),
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
