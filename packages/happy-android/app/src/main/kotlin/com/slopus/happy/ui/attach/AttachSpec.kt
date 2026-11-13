package com.slopus.happy.ui.attach

import androidx.compose.animation.core.CubicBezierEasing
import androidx.compose.animation.core.Easing
import androidx.compose.animation.core.SpringSpec
import androidx.compose.animation.core.spring
import androidx.compose.runtime.Immutable
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.slopus.happy.ui.theme.DarkColors
import com.slopus.happy.ui.theme.LightColors
import kotlin.math.PI
import kotlin.math.cos
import kotlin.math.min

/**
 * Telegram's attachment sheet, measured (research/attachment-menu.md):
 * every size the port draws with. `AttachSpecTest` pins them.
 */
object AttachSpec {
    /** `BottomSheet.dimBehindAlpha`, 51 of 255. */
    const val SCRIM_ALPHA = 51f / 255f
    val corner = 24.dp
    val grabberWidth = 36.dp
    val grabberHeight = 4.dp
    val grabberTop = 10.dp

    /** The sheet's top over the grid's first row; [header] more while something is picked. */
    val sheetOverRow = 24.dp
    val header = 26.dp
    val headerText = 16.sp

    /** The first row rests at this share of the height under the status bar, [restingNudge] lower. */
    const val RESTING = 2f / 5f
    const val RESTING_LANDSCAPE = 1f / 3.5f
    val restingNudge = 4.dp

    /** Pulled this far and let go, the sheet goes. */
    const val DISMISS_CM = 0.8f

    /** A close moves the sheet down by its height and this. */
    val closeExtra = 10.dp

    /** The top bar that fades in once the grid reaches the top, and how near it counts. */
    val topBar = 56.dp
    val topBarReach = 12.dp

    /** `bottomFadeView`: the list fades out over this under the bars. */
    val bottomFade = 72.dp

    // The grid
    val gridPadding = 2.dp
    val gridGap = 2.dp
    const val COLUMNS = 3
    const val WIDE_COLUMNS = 4
    /** Telegram's 4 columns on a tablet or a phone on its side, from this sheet width. */
    val wideFrom = 600.dp

    fun columns(width: Dp): Int = if (width >= wideFrom) WIDE_COLUMNS else COLUMNS

    /** A cell's side: what the padding and the gaps between columns leave, shared. */
    fun cell(width: Dp, columns: Int): Dp = (width - gridPadding * 2 - gridGap * (columns - 1)) / columns

    val badgeInset = 4.dp
    val badgeHeight = 17.dp
    val badgeCorner = 4.dp
    val badgePadding = 5.dp
    val badgeText = 12.sp

    /**
     * `CheckBox2` of 24 in a 26 box, 5 from the cell's top and end. Telegram's touch is the
     * 42 corner (`checkFrame`); ours is the 48 corner, Android's least target, Telegram's within it.
     */
    val check = 24.dp
    val checkBox = 26.dp
    val checkInset = 5.dp
    val checkTouch = 48.dp
    val checkFill = 11.5.dp
    val checkRing = 10.5.dp
    val checkRingShade = 11.dp
    val checkStroke = 1.5.dp
    val checkSweep = 11.8.dp

    /** The number in the check: 14 bold on an 18 baseline, smaller and higher for three digits or more. */
    fun checkText(number: Int) = when (number.toString().length) {
        1, 2 -> 14.sp
        3 -> 10.sp
        else -> 8.sp
    }

    fun checkBaseline(number: Int) = when (number.toString().length) {
        1, 2 -> 18.dp
        3 -> 16.5.dp
        else -> 15.75.dp
    }

    /** A picked picture shrinks to this, a ring of the sheet round it. */
    const val PICKED_SCALE = 0.787f

    // The tab bar
    val tabBar = 70.dp
    val tabBarInset = 7.dp
    val tabBarCorner = 28.dp
    val tabPadding = 11.dp
    val tabIcon = 24.dp
    val tabIconTop = 4.dp
    val tabLabelTop = 28.33.dp
    val tabLabel = 11.sp
    const val TAB_SELECTED_ALPHA = 0.09f
    const val TAB_SELECTED_FROM = 0.6f

    /** With a few tabs Telegram narrows the bar to 80 a tab and 36 more, centred (its poll rule). */
    fun tabBarWidth(tabs: Int, available: Dp): Dp = min(available.value, (tabs * 80 + 36).toFloat()).dp

    // The caption bar: drawn as the chat's composer (ConversationComposerSpec)
    /** The caption grows to this many lines, then scrolls inside the field. */
    const val CAPTION_LINES = 5
    const val SEND_FROM = 0.2f

    /**
     * The confirm pill at the header's far end (iOS `SelectedButtonNode`'s shape): 38 tall,
     * [confirmEnd] from the sheet's edge, its middle on the "N selected" line; a 22 check 8 in,
     * the count 4 after it and 12 from the end, never narrower than 52.
     */
    val confirmHeight = 38.dp
    val confirmMinWidth = 52.dp
    val confirmEnd = 12.dp
    val confirmTop = 6.dp
    val confirmIcon = 22.dp
    val confirmStart = 8.dp
    val confirmSpacing = 4.dp
    val confirmTrailing = 12.dp
    val confirmText = 16.sp
    const val CONFIRM_FROM = 0.2f

    // The File tab
    val fileRow = 64.dp
    val fileIcon = 42.dp
    val fileIconTop = 12.dp
    val fileIconStart = 15.dp
    val fileText = 72.dp
    val fileName = 16.sp
    val fileDetails = 13.sp

    /** Switching tabs, the old page goes down this far and the new one starts there. */
    val switchShift = 78.dp
}

/**
 * The sheet's colours from our theme. Where Telegram puts its blue (the
 * checks, the confirm pill, the selected tab) we use the chat composer's
 * send button: the text colour filled, the surface's glyph on it.
 */
@Immutable
data class AttachColors(
    /** `chat_attachCheckBoxBackground` and the confirm pill: the composer's send fill. */
    val accent: Color,
    /** The check's number and the pill's glyph: the composer's send glyph. */
    val onAccent: Color,
    /** `glass_tabUnselected`. */
    val tab: Color,
    /** `glass_tabSelected`. */
    val tabSelected: Color,
    /** `glass_tabSelectedText`. */
    val tabSelectedText: Color,
    /** `sheet_scrollUp`. */
    val grabber: Color,
    /** `chat_attachPhotoBackground`, behind a cell while it loads. */
    val cell: Color,
    /** `chat_mediaTimeBackground`. */
    val badge: Color,
) {
    companion object {
        fun of(dark: Boolean): AttachColors {
            val theme = if (dark) DarkColors else LightColors
            return AttachColors(
                accent = theme.text,
                onAccent = theme.surface,
                tab = theme.textSecondary,
                tabSelected = theme.text,
                tabSelectedText = theme.text,
                grabber = if (dark) Color(0x25FFFFFF) else Color(0xFFE1E4E8),
                cell = if (dark) Color(0x0CFFFFFF) else Color(0x0C000000),
                badge = Color(0x66000000),
            )
        }
    }
}

/** Telegram's attachment sheet timing (research/attachment-menu.md). */
object AttachMotion {
    /** `CubicBezierInterpolator.EASE_OUT`. */
    val easeOut = CubicBezierEasing(0f, 0f, 0.58f, 1f)
    /** `EASE_IN`. */
    val easeIn = CubicBezierEasing(0.42f, 0f, 1f, 1f)
    /** `EASE_BOTH`. */
    val easeBoth = CubicBezierEasing(0.42f, 0f, 0.58f, 1f)
    /** `DEFAULT`. */
    val default = CubicBezierEasing(0.25f, 0.1f, 0.25f, 1f)
    /** `DecelerateInterpolator()`. */
    val decelerate = Easing { t -> 1 - (1 - t) * (1 - t) }
    /** `AccelerateDecelerateInterpolator`, an `AnimatorSet`'s default. */
    val accelerateDecelerate = Easing { t -> (cos((t + 1) * PI) / 2 + 0.5).toFloat() }

    /** `OvershootInterpolator(tension)`. */
    fun overshoot(tension: Float): Easing = Easing { t ->
        val s = t - 1
        s * s * ((tension + 1) * s + tension) + 1
    }

    /** The sheet coming up: `appearSpringAnimation`. */
    const val OPEN_DAMPING = 0.75f
    const val OPEN_STIFFNESS = 350f
    fun <T> open(): SpringSpec<T> = spring(dampingRatio = OPEN_DAMPING, stiffness = OPEN_STIFFNESS)

    const val CLOSE_MS = 250
    const val SCRIM_MS = 400
    const val SCRIM_DELAY_MS = 20
    val scrim = overshoot(0.7f)

    /** A tab's scale [elapsed] ms into the open (`ATTACH_ALERT_PROGRESS`): 0, up to 1.1, back to 1. */
    fun tabScale(index: Int, elapsed: Float): Float {
        val t = elapsed - tabStart(index)
        return when {
            t <= 0 -> 0f
            t <= 200 -> 1.1f * easeOut.transform(t / 200)
            t <= 300 -> 1.1f - 0.1f * easeIn.transform((t - 200) / 100)
            else -> 1f
        }
    }

    fun tabAlpha(index: Int, elapsed: Float): Float {
        val t = elapsed - tabStart(index)
        return when {
            t <= 0 -> 0f
            t <= 200 -> easeBoth.transform(t / 200)
            else -> 1f
        }
    }

    private fun tabStart(index: Int) = 32f * (3 - index)

    /** The open clock the tabs pop on: 400 ms after a 20 ms delay. */
    const val TABS_MS = 400

    /** Not pulled far enough: back in 250 ms for a full 0.8 cm, less for less. */
    fun springBackMs(pulled: Float, threshold: Float): Int = (250 * (pulled / threshold).coerceIn(0f, 1f)).toInt()

    const val CHECK_MS = 200
    const val PICK_SCALE_MS = 200
    /**
     * The tab bar's glass becoming the caption's pill and back, as iOS's
     * attach menu morphs it: 400 ms on its curve both ways. The tabs are
     * gone by [BAR_SWAP] of it; the caption's words and send come in after.
     */
    const val BAR_MORPH_MS = 400
    val barMorph = CubicBezierEasing(0.38f, 0.7f, 0.125f, 1f)
    const val BAR_SWAP = 0.4f

    fun tabsShown(morph: Float): Float = 1 - (morph / BAR_SWAP).coerceIn(0f, 1f)

    fun captionShown(morph: Float): Float = ((morph - BAR_SWAP) / (1 - BAR_SWAP)).coerceIn(0f, 1f)

    const val COUNTER_MS = 180
    const val COUNTER_FROM = 0.9f
    val counter = overshoot(2f)
    const val TAB_SELECT_MS = 320
    const val TOP_BAR_MS = 180
    const val HEADER_MS = 180

    /** Switching tabs: phase one 180 ms DEFAULT, then the new page springs home. */
    const val SWITCH_MS = 180
    const val SWITCH_FADE = 0.7f
    const val SWITCH_DAMPING = 0.75f
    const val SWITCH_STIFFNESS = 500f
}

/**
 * The sheet growing out of the + and back into it (iOS `AttachMenuMotion.Morph`,
 * after Telegram's glass `AttachmentController.animateIn`/`animateOut`). iOS
 * runs Display's spring of mass 5 and stiffness 900 at a damping, sped up to
 * a duration; here that is the same damping ratio (110 → 0.82, 124 → 0.92)
 * at the stiffness that settles it in that duration (4 / (ζω) seconds).
 *
 * In: the centre over 0.4 s, the size over 0.45, the corners to the sheet's
 * in 0.2; the page and the sheet's ground fade in over 0.2 while the + on
 * the growing glass fades in 0.15. Out: the centre 0.4, the size 0.3, the
 * corners 0.2; the page fades in 0.12, the + comes back in 0.22, and the
 * ground goes after 0.2 over 0.15, so the + alone lands on the button.
 */
object AttachMorph {
    const val POSITION_RATIO = 0.82f
    const val POSITION_STIFFNESS = 149f
    const val SIZE_STIFFNESS = 117f
    const val OUT_SIZE_RATIO = 0.92f
    const val OUT_SIZE_STIFFNESS = 210f
    const val CORNERS_MS = 200
    const val CONTENT_IN_MS = 200
    const val GLYPH_IN_MS = 150
    const val CONTENT_OUT_MS = 120
    const val GLYPH_OUT_MS = 220
    const val GROUND_OUT_DELAY_MS = 200
    const val GROUND_OUT_MS = 150

    /** Only a phone held upright grows its sheet out of the + (iOS: the `.sheet` style). */
    const val MAX_WIDTH_DP = 600

    fun <T> position(): SpringSpec<T> = spring(dampingRatio = POSITION_RATIO, stiffness = POSITION_STIFFNESS)
    fun <T> size(): SpringSpec<T> = spring(dampingRatio = POSITION_RATIO, stiffness = SIZE_STIFFNESS)
    fun <T> outSize(): SpringSpec<T> = spring(dampingRatio = OUT_SIZE_RATIO, stiffness = OUT_SIZE_STIFFNESS)
}
