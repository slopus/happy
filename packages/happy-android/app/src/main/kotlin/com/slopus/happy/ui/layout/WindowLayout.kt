package com.slopus.happy.ui.layout

import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.absolutePadding
import androidx.compose.foundation.layout.displayCutout
import androidx.compose.foundation.layout.systemBars
import androidx.compose.foundation.layout.union
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.layout.wrapContentWidth
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.Immutable
import androidx.compose.runtime.remember
import androidx.compose.runtime.staticCompositionLocalOf
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.unit.LayoutDirection
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import kotlin.math.sqrt

enum class DeviceType { Phone, Tablet }

/**
 * utils/deviceCalculations.ts on Android: a dp is 1/160 inch, and a window
 * 9 inches or more across is a tablet. Foldables (7–8 inches unfolded) stay
 * phones. It sets the header height only: content follows [ContentTokens],
 * the tablet shell [TabletBreakpoint].
 */
object DeviceCalculations {
    const val POINTS_PER_INCH = 160f
    const val TABLET_THRESHOLD_INCHES = 9f

    data class Dimensions(val widthInches: Float, val heightInches: Float, val diagonalInches: Float)

    /** `calculateDeviceDimensions`. */
    fun dimensions(widthPoints: Float, heightPoints: Float, pointsPerInch: Float = POINTS_PER_INCH): Dimensions {
        val width = widthPoints / pointsPerInch
        val height = heightPoints / pointsPerInch
        return Dimensions(width, height, sqrt(width * width + height * height))
    }

    /** `determineDeviceType` off iOS: tablets from the threshold up, inclusive. */
    fun deviceType(diagonalInches: Float, thresholdInches: Float = TABLET_THRESHOLD_INCHES): DeviceType =
        if (diagonalInches >= thresholdInches) DeviceType.Tablet else DeviceType.Phone

    /** `useDeviceType`: the window in dp. */
    fun deviceType(width: Dp, height: Dp): DeviceType = deviceType(dimensions(width.value, height.value).diagonalInches)

    /** `calculateHeaderHeight` on Android: a phone on its side gets the 48 bar, everything else 64. */
    fun headerHeight(deviceType: DeviceType, isLandscape: Boolean): Dp =
        if (deviceType == DeviceType.Phone && isLandscape) 48.dp else 64.dp
}

/**
 * responsive.ts `useIsTablet`: the tablet layout is a window rule, not a
 * device class. Width alone, so a keyboard shrinking the window never folds
 * the sidebar away. happy-app splits at 768; here the two-pane shell is
 * Material's expanded class ([WidthClass.expandedMin], 840), so a book
 * foldable unfolded (750 upright, 832 on its side) stays one pane with the
 * medium column either way.
 */
object TabletBreakpoint {
    val minWidth: Dp get() = WidthClass.expandedMin

    fun isTablet(windowWidth: Dp): Boolean = WidthClass.of(windowWidth) == WidthClass.Expanded

    /** `useIsLandscape`. */
    fun isLandscape(width: Dp, height: Dp): Boolean = width > height
}

/**
 * Material 3's window width classes (m3.material.io, Breakpoints): compact
 * under 600, medium to 839, expanded from 840. A phone upright is compact;
 * a book foldable unfolded (the Galaxy Z Fold7's inner screen is 750 dp
 * upright, 832 on its side) and a small tablet upright are medium.
 * Expanded is also where the two-pane tablet shell starts ([TabletBreakpoint]).
 */
enum class WidthClass {
    Compact, Medium, Expanded;

    companion object {
        val mediumMin = 600.dp
        val expandedMin = 840.dp

        fun of(width: Dp): WidthClass = when {
            width < mediumMin -> Compact
            width < expandedMin -> Medium
            else -> Expanded
        }
    }
}

/**
 * The one set of horizontal layout tokens every screen follows
 * (research/foldable-layout.md). Content lies in a column centred in its
 * pane; cards, rows, message text and the top bars' glyphs sit [inset] in
 * from the column's edges, on one keyline per side. The column is held
 * [gutter] in from the pane and to [columnMaxWidth] at most, so the keyline
 * is never nearer the pane's edge than [margin], and keyline to keyline is
 * never wider than [maxContentWidth]. It answers to the width the window
 * has, not the kind of device: a 900 dp window is a long line to read
 * whether it is a tablet, a phone on its side or half a desktop.
 *
 * | class    | margin | content max | column max | keyline at   |
 * |----------|--------|-------------|------------|--------------|
 * | compact  | 16     | none        | none       | 16 (411)     |
 * | medium   | 24     | 640         | 672        | 55 (750)     |
 * | expanded | 24     | 768         | 800        | 240 (1280)   |
 *
 * Compact is the phone exactly as it was. Medium is Material's 24 margin
 * with a 640 measure (about 70 characters of 16 sp body text), so an
 * unfolded foldable reads as a centred column rather than a stretched
 * phone. Expanded keeps happy-app's layout.ts 800 column. Android has no
 * Mac branch, so `maxWidth` and `headerMaxWidth` agree.
 */
@Immutable
data class ContentTokens(
    /** The least room between the pane's edge and the keyline: Material's margin. */
    val margin: Dp,
    /** Keyline to keyline at most: the readable measure. */
    val maxContentWidth: Dp,
) {
    /** Between the pane's edge and the column, at the least. */
    val gutter: Dp get() = margin - inset

    /** The column with its own [inset] on each side. */
    val columnMaxWidth: Dp get() = if (maxContentWidth == Dp.Infinity) Dp.Infinity else maxContentWidth + inset * 2

    /** How wide the column comes out in a pane [paneWidth] wide. */
    fun columnWidth(paneWidth: Dp): Dp = minOf(paneWidth - gutter * 2, columnMaxWidth)

    /** From the pane's edge to the keyline, either side. */
    fun keyline(paneWidth: Dp): Dp = (paneWidth - columnWidth(paneWidth)) / 2 + inset

    companion object {
        /** Where content sits in the column: cards' edges, rows' and messages' text, the bars' glyphs. */
        val inset = 16.dp

        val Compact = ContentTokens(margin = 16.dp, maxContentWidth = Dp.Infinity)
        val Medium = ContentTokens(margin = 24.dp, maxContentWidth = 640.dp)
        val Expanded = ContentTokens(margin = 24.dp, maxContentWidth = 768.dp)

        fun of(widthClass: WidthClass): ContentTokens = when (widthClass) {
            WidthClass.Compact -> Compact
            WidthClass.Medium -> Medium
            WidthClass.Expanded -> Expanded
        }

        /** Material 3's basic dialog: 560 wide at most. */
        val dialogMaxWidth = 560.dp
        /** Material 3's bottom sheet: 640 wide at most, centred. */
        val sheetMaxWidth = 640.dp
    }
}

/**
 * The window's answers to every responsive.ts and layout.ts question, read
 * through [LocalWindowLayout]. [ProvideWindowLayout] measures the window at
 * the root; without it (component tests, previews) a screen lays out as a
 * phone with no width limit.
 */
@Immutable
data class WindowLayout(
    val width: Dp,
    val height: Dp,
    val isTablet: Boolean,
    val isLandscape: Boolean,
    val deviceType: DeviceType,
    /** The window's Material width class. */
    val widthClass: WidthClass,
    /** [widthClass]'s horizontal tokens, which [Modifier.contentMaxWidth] lays out. */
    val content: ContentTokens,
    /** `useHeaderHeight`; on Android it takes the device type from [isTablet]. */
    val headerHeight: Dp,
    /**
     * The window's unsafe sides, absolute (not start and end): the display
     * cutout and a navigation bar on the side, which a phone on its side
     * has (iOS's b73b1accd). [Modifier.contentMaxWidth] keeps the column
     * inside them; backgrounds still run under them.
     */
    val safeLeft: Dp = 0.dp,
    val safeRight: Dp = 0.dp,
) {
    /** `layout.maxWidth`, the content column at its widest: the chat, the composer, item groups, the bars. */
    val contentMaxWidth: Dp get() = content.columnMaxWidth

    /** `layout.headerMaxWidth`: the same as [contentMaxWidth] off the Mac. */
    val headerMaxWidth: Dp get() = contentMaxWidth

    companion object {
        fun of(width: Dp, height: Dp, safeLeft: Dp = 0.dp, safeRight: Dp = 0.dp): WindowLayout {
            val isTablet = TabletBreakpoint.isTablet(width)
            val isLandscape = TabletBreakpoint.isLandscape(width, height)
            val deviceType = DeviceCalculations.deviceType(width, height)
            val widthClass = WidthClass.of(width)
            return WindowLayout(
                width = width,
                height = height,
                isTablet = isTablet,
                isLandscape = isLandscape,
                deviceType = deviceType,
                widthClass = widthClass,
                content = ContentTokens.of(widthClass),
                headerHeight = DeviceCalculations.headerHeight(if (isTablet) DeviceType.Tablet else DeviceType.Phone, isLandscape),
                safeLeft = safeLeft,
                safeRight = safeRight,
            )
        }

        /** A portrait phone with no width limit. */
        val Unmeasured = WindowLayout(Dp.Infinity, Dp.Infinity, false, false, DeviceType.Phone, WidthClass.Compact, ContentTokens.Compact, 64.dp)
    }
}

val LocalWindowLayout = staticCompositionLocalOf { WindowLayout.Unmeasured }

/**
 * Measures the window (the app draws edge to edge, so the root is the window) and provides it.
 * The sides come from the system bars and the cutout, never the keyboard, whose every frame
 * would otherwise recompose this.
 */
@Composable
fun ProvideWindowLayout(modifier: Modifier = Modifier, content: @Composable () -> Unit) {
    BoxWithConstraints(modifier) {
        val density = LocalDensity.current
        val sides = WindowInsets.systemBars.union(WindowInsets.displayCutout)
        val left = with(density) { sides.getLeft(this, LayoutDirection.Ltr).toDp() }
        val right = with(density) { sides.getRight(this, LayoutDirection.Ltr).toDp() }
        val layout = remember(maxWidth, maxHeight, left, right) { WindowLayout.of(maxWidth, maxHeight, left, right) }
        CompositionLocalProvider(LocalWindowLayout provides layout, content = content)
    }
}

/**
 * The content column ([ContentTokens]): [ContentTokens.gutter] in from the
 * pane on each side, or the window's unsafe side ([WindowLayout.safeLeft],
 * [WindowLayout.safeRight]) where that is more, held to
 * [ContentTokens.columnMaxWidth] and centred (layout.ts `maxWidth` under
 * `alignItems: 'center'`). On a compact window upright, a no-op. Put the
 * content's own inset after it, never before, so its keyline is the one
 * the bars' glyphs sit on at every width.
 */
fun Modifier.contentMaxWidth(layout: WindowLayout): Modifier =
    fillMaxWidth()
        .absolutePadding(
            left = maxOf(layout.content.gutter, layout.safeLeft, 0.dp),
            right = maxOf(layout.content.gutter, layout.safeRight, 0.dp),
        )
        .wrapContentWidth(Alignment.CenterHorizontally)
        .widthIn(max = layout.contentMaxWidth)
        .fillMaxWidth()

/**
 * SessionView.tsx `CenteredInputWidth`: the content column, then
 * [horizontalPadding] on each side inside it, so the bars over the composer
 * line up with the messages above them at every width.
 */
@Composable
fun CenteredInputWidth(horizontalPadding: Dp, modifier: Modifier = Modifier, content: @Composable () -> Unit) {
    val layout = LocalWindowLayout.current
    Box(modifier.contentMaxWidth(layout).padding(horizontal = horizontalPadding)) { content() }
}
