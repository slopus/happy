package com.slopus.happy.ui.todos

import androidx.compose.animation.core.Animatable
import androidx.compose.animation.core.CubicBezierEasing
import androidx.compose.animation.core.spring
import androidx.compose.animation.core.tween
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.selection.toggleable
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.drawWithCache
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.focus.onFocusChanged
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.Path
import androidx.compose.ui.graphics.PathMeasure
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.StrokeJoin
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.layout.Layout
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.style.TextDecoration
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.Constraints
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.slopus.happy.R
import com.slopus.happy.ui.cards.CardBlock
import com.slopus.happy.ui.components.HomeCardPlace
import com.slopus.happy.ui.components.Icon
import com.slopus.happy.ui.components.Ionicon
import com.slopus.happy.ui.components.rememberReduceMotion
import com.slopus.happy.ui.connection.RowTile
import com.slopus.happy.ui.theme.HappyTheme
import com.slopus.happy.ui.theme.happyTextStyle
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch

/**
 * iOS TodoRowLayout: 44 dp minimum, 10 above/below the text, a 22 dp ring
 * 16 in and a 12 dp gap to 16/20 sp text (eight lines). The ring and author
 * stand on the first line of a wrapping row; the whole 50 dp leading slot
 * checks it. Only content/width/font changes measure; check motion draws.
 */
@Composable
internal fun TodoLine(
    id: String,
    place: HomeCardPlace,
    modifier: Modifier = Modifier,
    author: String? = null,
    authorSeed: String? = author,
    onCheck: (() -> Unit)? = null,
    checked: Boolean = false,
    checkLabel: String = "",
    checkRole: Role = Role.Checkbox,
    mark: @Composable () -> Unit,
    text: @Composable () -> Unit,
) {
    val colors = HappyTheme.colors
    val lineHeight = with(LocalDensity.current) { 20.sp.roundToPx() }
    CardBlock(place, modifier, dividerStart = 50.dp, tag = "todo.row.$id") {
        Layout(content = {
            Box(Modifier.testTag("todo.text.$id")) { text() }
            Box(Modifier.size(22.dp).testTag("todo.check.$id")) { mark() }
            if (author != null) {
                val initials = remember(author) { author.trim().split(Regex("\\s+")).filter(String::isNotEmpty).take(2).joinToString("") { it.take(1) }.uppercase() }
                val tile = remember(authorSeed) {
                    val hash = authorSeed.orEmpty().toByteArray(Charsets.UTF_8).fold(0) { hash, byte -> (hash * 31 + (byte.toInt() and 255)) and 0xffff }
                    listOf(RowTile.Blue, RowTile.Green, RowTile.Orange, RowTile.Indigo, RowTile.Purple, RowTile.Teal)[hash % 6]
                }
                Box(Modifier.size(22.dp).clip(CircleShape).background(tile.fill(colors.dark)).testTag("todo.author.$id"), contentAlignment = Alignment.Center) {
                    Text(initials, style = happyTextStyle(fontSize = 10, lineHeight = 12, weight = FontWeight.SemiBold), color = tile.ink(colors.dark), maxLines = 1, modifier = Modifier.clearAndSetSemantics {})
                }
            }
            Box(Modifier.testTag("todo.hit.$id").then(if (onCheck != null) {
                (if (checkRole == Role.Checkbox) Modifier.toggleable(checked, role = checkRole) { onCheck() }
                else Modifier.clickable(role = checkRole, onClick = onCheck)).semantics { contentDescription = checkLabel }
            } else Modifier))
        }) { measurables, constraints ->
            val width = constraints.maxWidth
            val side = 16.dp.roundToPx()
            val start = 50.dp.roundToPx()
            val square = 22.dp.roundToPx()
            val faceWidth = if (author == null) 0 else square + 8.dp.roundToPx()
            val label = measurables[0].measure(Constraints(maxWidth = (width - start - side - faceWidth).coerceAtLeast(0)))
            val markBox = measurables[1].measure(Constraints.fixed(square, square))
            val height = maxOf(44.dp.roundToPx(), label.height + 20.dp.roundToPx())
            val face = if (author != null) measurables[2].measure(Constraints.fixed(square, square)) else null
            val hit = measurables.last().measure(Constraints.fixed(start, height))
            val textY = (height - label.height) / 2
            val markY = (textY + (minOf(lineHeight, label.height) - square) / 2).coerceAtLeast(0)
            layout(width, height) {
                label.placeRelative(start, textY)
                markBox.placeRelative(side, markY)
                face?.placeRelative(width - side - square, markY)
                hit.placeRelative(0, 0)
            }
        }
    }
}

/** The fill spring (mass 1, stiffness 100, damping 12, velocity 4) and 80+200 ms check from iOS TodoCheckPop. */
@Composable
internal fun TodoCheck(done: Boolean) {
    val colors = HappyTheme.colors
    val reduceMotion = rememberReduceMotion()
    val fill = remember { Animatable(if (done) 1f else 0f) }
    val draw = remember { Animatable(if (done) 1f else 0f) }
    var before by remember { mutableStateOf(done) }
    LaunchedEffect(done, reduceMotion) {
        val pop = done && !before && !reduceMotion
        before = done
        if (!pop) {
            fill.snapTo(if (done) 1f else 0f)
            draw.snapTo(if (done) 1f else 0f)
        } else {
            fill.snapTo(.3f)
            draw.snapTo(0f)
            launch { fill.animateTo(1f, spring(dampingRatio = .6f, stiffness = 100f), initialVelocity = 4f) }
            delay(80)
            draw.animateTo(1f, tween(200, easing = CubicBezierEasing(0f, 0f, .58f, 1f)))
        }
    }
    Box(Modifier.size(22.dp)) {
        Canvas(Modifier.size(22.dp)) {
            drawCircle(if (colors.dark) Color(0xff545458) else Color(0xffc7c7cc), style = Stroke(1.5.dp.toPx()))
        }
        Box(Modifier.size(22.dp).graphicsLayer { scaleX = fill.value; scaleY = fill.value }.drawWithCache {
                val full = Path().apply {
                    moveTo(size.width * .28f, size.height * .52f)
                    lineTo(size.width * .44f, size.height * .67f)
                    lineTo(size.width * .73f, size.height * .36f)
                }
                val measure = PathMeasure().apply { setPath(full, false) }
                val segment = Path()
                val stroke = Stroke(2.dp.toPx(), cap = StrokeCap.Round, join = StrokeJoin.Round)
                onDrawBehind {
                    if (fill.value > 0f) {
                        drawCircle(colors.textLink)
                        segment.reset()
                        measure.getSegment(0f, measure.length * draw.value, segment, true)
                        drawPath(segment, Color.White, style = stroke)
                    }
                }
        })
    }
}

@Composable
internal fun TodoTextLabel(text: String, done: Boolean, onClick: () -> Unit) {
    val colors = HappyTheme.colors
    Text(text, style = happyTextStyle(fontSize = 16, lineHeight = 20).copy(textDecoration = if (done) TextDecoration.LineThrough else null),
        color = if (done) colors.textSecondary else colors.text, maxLines = 8, overflow = TextOverflow.Ellipsis,
        modifier = Modifier.fillMaxWidth().clickable(onClick = onClick))
}

/** Deleted todos are plain quiet rows; tapping anywhere restores one. */
@Composable
internal fun TodoDeletedLine(id: String, text: String, place: HomeCardPlace, modifier: Modifier, onRestore: () -> Unit) {
    CardBlock(place, modifier, tag = "todo.row.$id") {
        Box(Modifier.fillMaxWidth().clickable(role = Role.Button, onClick = onRestore).testTag("todo.hit.$id").padding(horizontal = 16.dp, vertical = 10.dp).heightIn(min = 24.dp), contentAlignment = Alignment.CenterStart) {
            Text(text, style = happyTextStyle(fontSize = 16, lineHeight = 20), color = HappyTheme.colors.textSecondary, maxLines = 8, overflow = TextOverflow.Ellipsis)
        }
    }
}

/** One in-place field; Return saves, blur saves once, and Add can keep it focused for the next todo. */
@Composable
internal fun TodoEditor(
    text: String,
    onText: (String) -> Unit,
    onCommit: () -> Unit,
    modifier: Modifier = Modifier,
    heading: Boolean = false,
    onBlur: () -> Unit = onCommit,
) {
    val colors = HappyTheme.colors
    val focus = remember { FocusRequester() }
    val label = stringResource(R.string.todo_text)
    var focused by remember { mutableStateOf(false) }
    BasicTextField(
        value = text,
        onValueChange = { onText(it.take(10_000)) },
        modifier = modifier.focusRequester(focus).onFocusChanged {
            val blurred = focused && !it.isFocused
            focused = it.isFocused
            if (blurred) onBlur()
        }.semantics { contentDescription = label }.testTag("todo.editor"),
        textStyle = happyTextStyle(fontSize = if (heading) 20 else 16, lineHeight = if (heading) 24 else 20).copy(color = colors.text),
        cursorBrush = SolidColor(colors.textLink), singleLine = true,
        keyboardOptions = KeyboardOptions(imeAction = ImeAction.Done),
        keyboardActions = KeyboardActions(onDone = { onCommit() }),
        decorationBox = { field -> Box { field() } },
    )
    LaunchedEffect(Unit) { focus.requestFocus() }
}

@Composable
internal fun TodoAddMark() { Icon(Ionicon.Add, 22.dp, HappyTheme.colors.textLink) }