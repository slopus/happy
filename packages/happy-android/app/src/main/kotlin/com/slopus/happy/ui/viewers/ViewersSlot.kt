package com.slopus.happy.ui.viewers

import androidx.compose.animation.core.Animatable
import androidx.compose.animation.core.Spring
import androidx.compose.animation.core.spring
import androidx.compose.animation.core.tween
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxScope
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.layout.wrapContentSize
import androidx.compose.foundation.layout.wrapContentWidth
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.Immutable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.key
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.produceState
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.drawWithContent
import androidx.compose.ui.geometry.Rect
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.ColorFilter
import androidx.compose.ui.graphics.ColorMatrix
import androidx.compose.ui.graphics.Paint
import androidx.compose.ui.graphics.drawscope.drawIntoCanvas
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.LocalLayoutDirection
import androidx.compose.ui.platform.LocalResources
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextDirection
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.LayoutDirection
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.ui.zIndex
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.compose.LocalLifecycleOwner
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.compose.currentStateAsState
import androidx.lifecycle.repeatOnLifecycle
import com.slopus.happy.R
import com.slopus.happy.agent.AgentPictures
import com.slopus.happy.agent.AgentSession
import com.slopus.happy.agent.TeamUser
import com.slopus.happy.ui.chat.formatLastSeen
import com.slopus.happy.ui.components.HappyDropdownMenu
import com.slopus.happy.ui.components.HappyMenuItem
import com.slopus.happy.ui.components.HappyMenuSection
import com.slopus.happy.ui.components.RenderThreadBreath
import com.slopus.happy.ui.components.rememberReduceMotion
import com.slopus.happy.ui.components.renderThreadMotion
import com.slopus.happy.ui.connection.LocalAgentPictures
import com.slopus.happy.ui.connection.PersonMark
import com.slopus.happy.ui.documents.peersHere
import com.slopus.happy.ui.theme.HappyTheme
import com.slopus.happy.viewers.Viewer
import com.slopus.happy.viewers.ViewerTarget
import com.slopus.happy.viewers.ViewerTier
import com.slopus.happy.viewers.Viewers
import com.slopus.happy.viewers.ViewersAvailability
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.StateFlow
import kotlin.math.abs

/**
 * The header's viewers. A [width] slot, the same with 0 or 50 people, so
 * the title never moves: up to [SHOWN] faces at the end, [step] apart, each
 * on a [gap] of the bar's ground,
 * then a `+N`. Here: the face in a ring of the person's colour that
 * breathes on the RenderThread, a green dot, popping in on a spring as they
 * arrive and the ring fading as they go. Recent (10 minutes): the face
 * and its minutes. Seen: [seenFace], grey, behind the rest.
 */
object ViewersSpec {
    const val SHOWN = 4
    val cell = 32.dp
    val face = 24.dp
    /** The header's ground around each face, so overlapping faces and their rings stay apart. */
    val gap = 1.5.dp
    val seenFace = 20.dp
    val step = 18.dp
    val width: Dp = step * SHOWN + cell
    val target = 48.dp
    val dot = 8.dp
    val menuFace = 28.dp
    const val FADE_MILLIS = 300

    private val ringColors = listOf(0xFFFF5A5F, 0xFFFF9F1C, 0xFFF7B32B, 0xFF2EC4B6, 0xFF3A86FF, 0xFF8338EC, 0xFFFF006E, 0xFF06D6A0, 0xFF00B4D8, 0xFFFB5607).map(::Color)

    /** A person's ring colour, the same on every screen for one [userId]. */
    fun color(userId: String): Color = ringColors[abs(userId.hashCode() % ringColors.size)]
}

object ViewersTags {
    const val SLOT = "viewers.slot"
    const val FACE = "viewers.face"
    const val RING = "viewers.ring"
    const val BADGE = "viewers.badge"
    const val MORE = "viewers.more"
    const val MENU = "viewers.menu"
    const val EDITOR = "viewers.editor"
}

/**
 * Holds [target] as viewed while its page is resumed, and, once the computer
 * serves viewers, shows who else is on it. Put it in the header's actions.
 */
@Composable
fun ViewersSlot(session: AgentSession, target: ViewerTarget, editors: List<ViewersEditor> = emptyList()) =
    ViewersSlot(session.viewers, session.team.users, session.pictures, target, editors)

@Composable
internal fun ViewersSlot(viewers: Viewers, users: StateFlow<Map<String, TeamUser>>, pictures: AgentPictures?, target: ViewerTarget, editors: List<ViewersEditor> = emptyList()) {
    val lifecycle = LocalLifecycleOwner.current.lifecycle
    LaunchedEffect(viewers, target, lifecycle) {
        lifecycle.repeatOnLifecycle(Lifecycle.State.RESUMED) { viewers.view(target) }
    }
    val availability by viewers.availability.collectAsStateWithLifecycle()
    if (availability != ViewersAvailability.Served) return
    val lists by viewers.lists.collectAsStateWithLifecycle()
    val people by users.collectAsStateWithLifecycle()
    CompositionLocalProvider(LocalAgentPictures provides pictures) {
        ViewersRow(lists[target], people, editors = editors)
    }
}

/** Someone with a document open in an editor, in their cursor's colour (`DocumentPeer`); listed when the slot is tapped. */
@Immutable
data class ViewersEditor(val name: String, val color: Color)

/**
 * [ViewersSlot]'s drawing: [viewers] in the route's order, null until the
 * first answer; [editors] join the tapped list; [clock] is epoch ms.
 */
@Composable
fun ViewersRow(
    viewers: List<Viewer>?,
    people: Map<String, TeamUser>,
    modifier: Modifier = Modifier,
    editors: List<ViewersEditor> = emptyList(),
    clock: () -> Long = System::currentTimeMillis,
) {
    // Tiers move with time alone: redrawn when the next badge or tier changes and on coming back, not on a tick.
    val resumed by LocalLifecycleOwner.current.lifecycle.currentStateAsState()
    val now by produceState(clock(), viewers, resumed.isAtLeast(Lifecycle.State.RESUMED)) {
        while (true) {
            value = clock()
            val next = viewers?.let { ViewerTier.nextChange(it, value) } ?: break
            delay(next - value)
        }
    }
    // Who was there when the list first came only appears; whoever comes after arrives.
    val first = remember { FirstList() }
    if (first.here == null && viewers != null) first.here = viewers.filter { it.here }.map { it.userId }.toSet()
    var open by remember { mutableStateOf(false) }
    val list = viewers.orEmpty()
    val shown = list.take(ViewersSpec.SHOWN)
    val more = list.size - shown.size
    val cells = shown.size + if (more > 0) 1 else 0
    val density = LocalDensity.current
    val step = with(density) { ViewersSpec.step.toPx() }
    // Every cell sits at the slot's start and moves by its translation alone, so the slot's layout never changes.
    fun x(index: Int) = (ViewersSpec.SHOWN - cells + 1 + index) * step
    val someone = stringResource(R.string.viewers_someone)
    val heard = peersHere(list.filter { it.here }.map { people[it.userId]?.name?.takeIf(String::isNotEmpty) ?: someone }).ifEmpty { stringResource(R.string.viewers_title) }
    Box(
        modifier
            .size(ViewersSpec.width, ViewersSpec.target)
            .testTag(ViewersTags.SLOT)
            .then(
                if (list.isEmpty() && editors.isEmpty()) Modifier
                else Modifier
                    .clickable(role = Role.Button, onClickLabel = stringResource(R.string.viewers_show)) { open = true }
                    .semantics(mergeDescendants = true) { contentDescription = heard },
            ),
        contentAlignment = Alignment.CenterStart,
    ) {
        shown.forEachIndexed { index, viewer ->
            key(viewer.userId) {
                ViewerCell(viewer, ViewerTier.of(viewer, now), people[viewer.userId], x(index), arrives = first.here?.contains(viewer.userId) == false, Modifier.zIndex(-index.toFloat()))
            }
        }
        // Over every face, so a badge wider than its face at large text is never covered by the one before it.
        shown.forEachIndexed { index, viewer ->
            if (ViewerTier.of(viewer, now) == ViewerTier.Recent) {
                key(viewer.userId, "minutes") {
                    Slide(x(index), Modifier.zIndex(1f)) { MinutesBadge(ViewerTier.minutesAway(viewer, now)) }
                }
            }
        }
        if (more > 0) {
            key("+") {
                // Over the faces, so the count is never covered, whichever way the row runs and however wide large text makes it.
                Slide(x(shown.size), Modifier.zIndex(1f)) {
                    // Large text widens the chip past its cell rather than being cut.
                    Box(
                        Modifier
                            .wrapContentSize(unbounded = true)
                            .heightIn(min = ViewersSpec.face)
                            .widthIn(min = ViewersSpec.face)
                            .testTag(ViewersTags.MORE)
                            .background(HappyTheme.colors.surfaceHigh, CircleShape)
                            .padding(horizontal = 4.dp),
                        contentAlignment = Alignment.Center,
                    ) {
                        Text(stringResource(R.string.viewers_more, more), style = ViewersText.more, color = HappyTheme.colors.text, maxLines = 1, softWrap = false, overflow = TextOverflow.Visible)
                    }
                }
            }
        }
        ViewersMenu(open, list, people, editors, now, onDismiss = { open = false })
    }
}

private class FirstList { var here: Set<String>? = null }

private object ViewersText {
    val badge = TextStyle(fontSize = 9.sp, lineHeight = 11.sp, fontWeight = FontWeight.SemiBold)
    /** Left to right in either direction, so it reads "+6" and not "6+". */
    val more = TextStyle(fontSize = 10.sp, lineHeight = 12.sp, fontWeight = FontWeight.SemiBold, textDirection = TextDirection.Ltr)
    val initial = TextStyle(fontSize = 13.sp, lineHeight = 16.sp, fontWeight = FontWeight.SemiBold)
}

/** A [ViewersSpec.cell] at [x] px from the slot's start, sliding there on a spring when it changes, by translation alone. */
@Composable
private fun Slide(x: Float, modifier: Modifier = Modifier, content: @Composable BoxScope.() -> Unit) {
    val reduce = rememberReduceMotion()
    val at = remember { Animatable(x) }
    // Measured from the slot's start, so right to left it runs the other way.
    val toEnd = if (LocalLayoutDirection.current == LayoutDirection.Rtl) -1f else 1f
    LaunchedEffect(x) { if (reduce) at.snapTo(x) else at.animateTo(x, spring(stiffness = Spring.StiffnessMediumLow)) }
    Box(Modifier.graphicsLayer { translationX = toEnd * at.value }.then(modifier).size(ViewersSpec.cell), contentAlignment = Alignment.Center) { content() }
}

@Composable
private fun ViewerCell(viewer: Viewer, tier: ViewerTier, person: TeamUser?, x: Float, arrives: Boolean, modifier: Modifier) {
    val reduce = rememberReduceMotion()
    val here = tier == ViewerTier.Here
    val pop = remember { Animatable(if (here && arrives && !reduce) 0.4f else 1f) }
    val ring = remember { Animatable(if (here) 1f else 0f) }
    var ringShown by remember { mutableStateOf(here) }
    LaunchedEffect(here) {
        if (here) {
            ringShown = true
            if (reduce) { ring.snapTo(1f); return@LaunchedEffect }
            ring.animateTo(1f, tween(ViewersSpec.FADE_MILLIS))
        } else {
            if (!reduce) ring.animateTo(0f, tween(ViewersSpec.FADE_MILLIS))
            ringShown = false
        }
    }
    // Arriving, or coming back while the page is open: a pop on a spring.
    var wasHere by remember { mutableStateOf(here && !arrives) }
    LaunchedEffect(here) {
        if (here && !wasHere && !reduce) {
            pop.snapTo(0.4f)
            pop.animateTo(1f, spring(dampingRatio = 0.42f, stiffness = Spring.StiffnessMedium))
        }
        wasHere = here
    }
    val color = ViewersSpec.color(viewer.userId)
    Slide(x, modifier.testTag(ViewersTags.FACE)) {
        Box(Modifier.size(ViewersSpec.cell).graphicsLayer { scaleX = pop.value; scaleY = pop.value }, contentAlignment = Alignment.Center) {
            if (ringShown) {
                val ringModifier = Modifier.size(ViewersSpec.cell).graphicsLayer { alpha = ring.value }.testTag(ViewersTags.RING)
                if (renderThreadMotion()) RenderThreadBreath(color, ringModifier)
                else Box(ringModifier.padding(0.5.dp).border(2.dp, color, CircleShape))
            }
            val size = if (tier == ViewerTier.Seen) ViewersSpec.seenFace else ViewersSpec.face
            Box(Modifier.size(size + ViewersSpec.gap * 2).background(HappyTheme.colors.surface, CircleShape), contentAlignment = Alignment.Center) {
                Box(if (tier == ViewerTier.Seen) Modifier.greyed() else Modifier) { PersonMark(viewer.userId, person?.photo, size) }
            }
            if (ringShown) {
                Box(
                    Modifier
                        .align(Alignment.BottomEnd)
                        .offset((-1).dp, (-1).dp)
                        .size(ViewersSpec.dot)
                        .graphicsLayer { alpha = ring.value }
                        .background(HappyTheme.colors.surface, CircleShape)
                        .padding(1.5.dp)
                        .background(HappyTheme.colors.status.connected, CircleShape),
                )
            }
        }
    }
}

/** A Recent face's minutes, under it. */
@Composable
private fun BoxScope.MinutesBadge(minutes: Int) {
    Text(
        stringResource(R.string.viewers_minutes_short, minutes),
        style = ViewersText.badge,
        color = HappyTheme.colors.text,
        maxLines = 1,
        softWrap = false,
        overflow = TextOverflow.Visible,
        modifier = Modifier
            .align(Alignment.BottomCenter)
            .offset(y = 6.dp)
            // Wider than the face at large text, centred under it rather than cut.
            .wrapContentWidth(unbounded = true)
            .background(HappyTheme.colors.surfaceHigh, RoundedCornerShape(6.dp))
            .padding(horizontal = 3.dp)
            .testTag(ViewersTags.BADGE),
    )
}

private val greyscale = Paint().apply { colorFilter = ColorFilter.colorMatrix(ColorMatrix().apply { setToSaturation(0f) }); alpha = 0.8f }

/** A Seen face: drawn without colour, a little faded. */
private fun Modifier.greyed() = drawWithContent {
    drawIntoCanvas { canvas ->
        canvas.saveLayer(Rect(0f, 0f, size.width, size.height), greyscale)
        drawContent()
        canvas.restore()
    }
}

/**
 * Everyone on the target, as the slot orders them: "Kirill · here now",
 * "Anna · 6 minutes ago", "Max · Nov 12". Editors are marked in their
 * cursor's colour; one the viewers don't name (an older client) is listed
 * after them.
 */
@Composable
private fun ViewersMenu(open: Boolean, viewers: List<Viewer>, people: Map<String, TeamUser>, editors: List<ViewersEditor>, now: Long, onDismiss: () -> Unit) {
    val resources = LocalResources.current
    HappyDropdownMenu(expanded = open, onDismissRequest = onDismiss, modifier = Modifier.testTag(ViewersTags.MENU)) {
        HappyMenuSection(stringResource(R.string.viewers_title))
        val someone = stringResource(R.string.viewers_someone)
        val hereNow = stringResource(R.string.viewers_here_now)
        val editing = stringResource(R.string.viewers_editing)
        val unmatched = editors.toMutableList()
        for (viewer in viewers) {
            val person = people[viewer.userId]
            val name = person?.name?.takeIf(String::isNotEmpty) ?: someone
            val editor = unmatched.firstOrNull { viewer.here && it.name.equals(name, ignoreCase = true) }?.also(unmatched::remove)
            val seen = if (viewer.here) hereNow else formatLastSeen(resources, viewer.lastSeenAt, now)
            HappyMenuItem(
                label = name,
                supporting = if (editor != null) "$seen · $editing" else seen,
                leading = { PersonMark(viewer.userId, person?.photo, ViewersSpec.menuFace) },
                trailing = editor?.let { { EditorDot(it.color) } },
                onClick = onDismiss,
            )
        }
        for (editor in unmatched) {
            HappyMenuItem(
                label = editor.name.ifEmpty { someone },
                supporting = editing,
                leading = { EditorFace(editor, ViewersSpec.menuFace) },
                trailing = { EditorDot(editor.color) },
                onClick = onDismiss,
            )
        }
    }
}

/** An editor's cursor colour. */
@Composable
private fun EditorDot(color: Color) {
    Box(Modifier.size(10.dp).background(color, CircleShape).testTag(ViewersTags.EDITOR))
}

/** An editor no viewer names: their initial on their cursor's colour, as the document's own peers draw them. */
@Composable
private fun EditorFace(editor: ViewersEditor, size: Dp) {
    Box(Modifier.size(size).background(editor.color, CircleShape), contentAlignment = Alignment.Center) {
        Text(editor.name.take(1).uppercase().ifEmpty { "?" }, style = ViewersText.initial, color = Color.White)
    }
}
