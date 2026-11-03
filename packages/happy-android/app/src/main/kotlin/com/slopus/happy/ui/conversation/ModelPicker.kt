package com.slopus.happy.ui.conversation

import android.view.WindowManager
import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.gestures.detectTapGestures
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.IntrinsicSize
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.statusBars
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Icon
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.TransformOrigin
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.layout.IntrinsicMeasurable
import androidx.compose.ui.layout.IntrinsicMeasureScope
import androidx.compose.ui.layout.LayoutModifier
import androidx.compose.ui.layout.Measurable
import androidx.compose.ui.layout.MeasureResult
import androidx.compose.ui.layout.MeasureScope
import androidx.compose.ui.layout.onPlaced
import androidx.compose.ui.layout.positionInParent
import androidx.compose.ui.platform.LocalConfiguration
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.paneTitle
import androidx.compose.ui.semantics.selected
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.Constraints
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.IntOffset
import androidx.compose.ui.unit.IntRect
import androidx.compose.ui.unit.IntSize
import androidx.compose.ui.unit.LayoutDirection
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.ui.window.PopupPositionProvider
import androidx.compose.ui.window.PopupProperties
import com.slopus.happy.R
import com.slopus.happy.conversation.AccountUsage
import com.slopus.happy.conversation.ModeCatalog
import com.slopus.happy.conversation.Mode
import com.slopus.happy.conversation.ModelMenus
import com.slopus.happy.model.settings.ModeOptions
import com.slopus.happy.ui.components.MaterialSymbols
import com.slopus.happy.ui.components.MenuSpec
import com.slopus.happy.ui.components.PagePopup
import com.slopus.happy.ui.components.hairline
import com.slopus.happy.ui.components.onScreen
import com.slopus.happy.ui.components.popupMotion
import com.slopus.happy.ui.components.rememberLastShown
import com.slopus.happy.ui.components.rememberPopupProgress
import com.slopus.happy.ui.components.rememberPopupState
import com.slopus.happy.ui.theme.HappyTheme
import java.text.SimpleDateFormat
import java.util.Date
import kotlinx.coroutines.flow.first

/** Which chip's list is open. */
internal enum class PickerList { Model, Effort }

object ModelPickerTags {
    /** The open list, and a service's accounts stacked over it. */
    const val PANEL = "conversation.picker.panel"
    const val ACCOUNTS = "conversation.picker.accounts"
    /** A line: `option:<key>` or `heading:<service>`. */
    fun option(key: String) = "conversation.picker.option:$key"
    fun heading(service: String) = "conversation.picker.heading:$service"
    const val NOTICE = "conversation.picker.notice"
    const val WINDOWS = "conversation.picker.windows"
}

/**
 * The model control panels' measures, iOS's (`PickerMetrics`, from desktop's
 * `composer-model-control.css`) in Android's menu card ([MenuSpec]): lines
 * 44 tall with the check in a column before the names, headings 32, blocks
 * 5 apart, the panel 8 in, 10 over its chip.
 */
object ModelPickerSpec {
    val inset = 8.dp
    val gap = 5.dp
    val row = 44.dp
    val heading = 32.dp
    val padding = 12.dp
    val highlightInset = 2.dp
    val highlightRadius = 14.dp
    val check = 15.dp
    val checkColumn = 23.dp
    val checkGap = 8.dp
    val headingGap = 5.dp
    val accountMax = 110.dp
    val usageGap = 8.dp
    val chevron = 13.dp
    val ring = 13.dp
    val ringGap = 4.dp
    val detailsInsetY = 7.dp
    val detailsLine = 18.dp
    val detailsPrimaryLine = 22.dp
    val detailsLabelMin = 48.dp
    val detailsGap = 8.dp
    val anchorGap = 10.dp
    val margin = 8.dp
    val maxHeight = 560.dp
    val modelsMinWidth = 200.dp
    val modelsMaxWidth = 250.dp
    val effortsMinWidth = 160.dp
    val accountsMinWidth = 250.dp
    val accountsMaxWidth = 280.dp
    val headingSize = 13.sp
    val linkSize = 15.sp
}

/** A gauge at a line's end: what is left and a ring that drains, or words alone ("Signed out"). */
internal data class PickerGauge(val text: String, val left: Int, val tone: AccountUsage.Tone, val ring: Boolean = true)

/** One of an account's windows, or a quiet line about how current they are. */
internal data class PickerWindow(val label: String, val resets: String? = null, val gauge: PickerGauge? = null, val primary: Boolean = false, val critical: Boolean = false)

/** What a panel lists (iOS `PickerContent.Line`). */
internal sealed interface PickerLine {
    data class Notice(val text: String, val warning: Boolean) : PickerLine
    /** A service: its name, its account, the window it runs low on, and the service whose accounts it opens. */
    data class Heading(val service: String, val account: String?, val gauges: List<PickerGauge>, val opens: String?, val label: String) : PickerLine
    data class Option(val key: String, val label: String, val checked: Boolean, val disabled: Boolean, val gauge: PickerGauge? = null) : PickerLine
    data object Separator : PickerLine
    data class Windows(val windows: List<PickerWindow>) : PickerLine
}

/** A pick's key: what it changes, then which. */
internal object PickerKeys {
    fun model(providerId: String, modelId: String) = "model\t$providerId\n$modelId"
    fun account(providerId: String) = "provider\t$providerId"
    fun effort(level: String) = "effort\t$level"

    /** What a pick makes the mode; null leaves it as it is. */
    fun pick(key: String, menus: ModelMenus, catalog: ModeCatalog): Mode? {
        val (kind, id) = key.split('\t', limit = 2).takeIf { it.size == 2 } ?: return null
        val current = menus.selection
        return when (kind) {
            "model" -> id.split('\n', limit = 2).takeIf { it.size == 2 }?.let { (provider, model) -> catalog.pick(current, provider, model) }
            "provider" -> {
                val account = menus.services.flatMap { it.accounts }.firstOrNull { it.id == id } ?: return null
                val model = menus.model(account) ?: return null
                catalog.pick(current, account.id, model.id, effort = current.effort)
            }
            "effort" -> current.copy(effort = id)
            else -> null
        }
    }
}

/** The chips' words for the selection: the model, and its effort when it has any. */
@Composable
internal fun modelChipLabels(menus: ModelMenus?): Pair<String, String?> {
    if (menus == null || menus.isEmpty) return stringResource(R.string.conversation_models_not_configured) to null
    val effort = menus.current?.takeIf { it.efforts.isNotEmpty() }?.let { menus.effort?.let(ModeOptions::effortDisplayName) }
    return (menus.current?.name ?: menus.selection.modelId) to effort
}

/** `usageAge`: how long ago, in a word. */
@Composable
private fun usageAge(ms: Long, now: Long): String {
    val minutes = ((now - ms) / 60_000).toInt()
    return when {
        minutes < 1 -> stringResource(R.string.conversation_usage_just_now)
        minutes < 60 -> stringResource(R.string.conversation_usage_minutes_ago, minutes)
        minutes / 60 < 20 -> stringResource(R.string.conversation_usage_hours_ago, minutes / 60)
        else -> stringResource(R.string.conversation_usage_at, clockTime(ms, now))
    }
}

/** `clockTime`: the time, with its weekday when it isn't within twenty hours. */
@Composable
private fun clockTime(ms: Long, now: Long): String {
    val context = LocalContext.current
    val locale = LocalConfiguration.current.locales[0]
    val time = android.text.format.DateFormat.getBestDateTimePattern(locale, if (android.text.format.DateFormat.is24HourFormat(context)) "Hm" else "hma")
    val pattern = if (kotlin.math.abs(now - ms) < 20 * 3_600_000L) time else "EEE " + time
    return SimpleDateFormat(pattern, locale).format(Date(ms))
}

@Composable
private fun windowName(kind: AccountUsage.Window.Kind) =
    stringResource(if (kind == AccountUsage.Window.Kind.Week) R.string.agent_input_usage_popup_week else R.string.agent_input_usage_popup_session)

private fun gauge(window: AccountUsage.Window, blocked: Boolean) = PickerGauge("${window.left}%", window.left, AccountUsage.tone(window.left, blocked))

/**
 * The model list: a notice about the account first, then each service under
 * its heading (its name, the account it lists, the window it runs low on,
 * and a chevron to its accounts), a hairline between them, the selected
 * model checked.
 */
@Composable
internal fun modelLines(menus: ModelMenus, usage: Map<String, AccountUsage>, now: Long = System.currentTimeMillis()): List<PickerLine> {
    val lines = ArrayList<PickerLine>()
    fun block() { if (lines.isNotEmpty()) lines += PickerLine.Separator }
    when (val notice = menus.notice) {
        ModelMenus.Notice.Hidden -> lines += PickerLine.Notice(stringResource(R.string.conversation_model_hidden_account), warning = false)
        is ModelMenus.Notice.Removed -> lines += PickerLine.Notice(stringResource(R.string.conversation_model_account_removed, notice.name), warning = true)
        is ModelMenus.Notice.Off -> lines += PickerLine.Notice(stringResource(R.string.conversation_model_account_off, notice.name), warning = true)
        null -> Unit
    }
    // A selection the lists don't offer still names its model, under the notice that says why.
    val current = menus.current
    if (current != null && !menus.listsSelection) {
        block()
        val provider = menus.selectedService?.let { service ->
            if (service.accounts.size > 1) "${service.label} · ${menus.selectedAccount?.label ?: service.label}" else service.label
        } ?: menus.selection.providerId
        lines += PickerLine.Heading(provider, null, emptyList(), null, provider)
        lines += PickerLine.Option(PickerKeys.model(menus.selection.providerId, current.modelId), current.name, checked = true, disabled = true)
    }
    for (service in menus.services) {
        block()
        val account = service.shown
        // `HeaderUsage`: the one window running low, as the chip warns of it; nothing while there is room.
        val warning = account?.let { usage[it.id]?.warning }
        val spoken = listOfNotNull(stringResource(R.string.conversation_heading_label, service.label, account?.label ?: service.account), warning?.let { usageWarningText(it, now) }).joinToString(", ")
        lines += PickerLine.Heading(
            service.label, account?.label,
            listOfNotNull(warning?.let { gauge(it.window, it.window.blocking) }),
            opens = service.id.takeIf { service.accounts.isNotEmpty() },
            label = spoken,
        )
        for (model in account?.models.orEmpty()) {
            lines += PickerLine.Option(
                PickerKeys.model(account?.id ?: service.account, model.id), model.model.name,
                checked = account?.id == menus.selection.providerId && model.id == menus.selection.modelId,
                disabled = model.disabled,
            )
        }
    }
    return lines
}

/** The selected model's efforts, least to most, the current one checked. */
internal fun effortLines(menus: ModelMenus): List<PickerLine> =
    menus.current?.efforts.orEmpty().map { level ->
        PickerLine.Option(PickerKeys.effort(level), ModeOptions.effortDisplayName(level), checked = level == menus.effort, disabled = false)
    }

/**
 * A service's accounts, the one it lists checked, each with what is left of
 * its week (`ComposerModelAccountGauge`) or that it is signed out; under
 * them, that account's windows.
 */
@Composable
internal fun accountLines(service: ModelMenus.Service, menus: ModelMenus, usage: Map<String, AccountUsage>, now: Long = System.currentTimeMillis()): List<PickerLine> {
    val signedOut = stringResource(R.string.conversation_usage_signed_out)
    val lines = ArrayList<PickerLine>()
    for (account in service.accounts) {
        val reading = usage[account.id]
        lines += PickerLine.Option(
            PickerKeys.account(account.id), account.label,
            checked = account.id == service.shown?.id, disabled = menus.model(account) == null,
            gauge = reading?.let { r ->
                if (r.signedOut) PickerGauge(signedOut, 0, AccountUsage.Tone.Critical, ring = false)
                else (r.week ?: r.session)?.let { gauge(it, r.limited) }
            },
        )
    }
    service.shown?.let { shown ->
        lines += PickerLine.Separator
        lines += PickerLine.Windows(usageDetails(usage[shown.id], now))
    }
    return lines
}

/**
 * `ComposerModelAccountUsageDetails`: the week (leading), then the session,
 * each with when it starts over and what is left; then how current the
 * numbers are, and a window measured well before the rest says when.
 */
@Composable
private fun usageDetails(usage: AccountUsage?, now: Long): List<PickerWindow> {
    val lines = ArrayList<PickerWindow>()
    val windows = listOfNotNull(usage?.week, usage?.session)
    for (window in windows) {
        lines += PickerWindow(
            windowName(window.kind),
            window.resetsAt?.let { stringResource(R.string.agent_input_usage_popup_resets, dayTime(it, now)) },
            gauge(window, window.blocking),
            primary = window.kind == AccountUsage.Window.Kind.Week,
        )
    }
    if (windows.isEmpty()) lines += PickerWindow(stringResource(R.string.conversation_usage_unknown))
    usage ?: return lines
    if (usage.signedOut) {
        lines += PickerWindow(stringResource(R.string.conversation_usage_signed_out), critical = true)
    } else if (usage.limited) {
        lines += PickerWindow(usage.limitResets?.let { stringResource(R.string.conversation_limit_resets, dayTime(it, now)) } ?: stringResource(R.string.conversation_limit_reached), critical = true)
    }
    when {
        usage.refreshing -> lines += PickerWindow(stringResource(R.string.conversation_usage_updating))
        usage.refreshError != null -> lines += PickerWindow(
            usage.updatedAt?.let { stringResource(R.string.conversation_usage_updated_failed, clockTime(it, now)) } ?: stringResource(R.string.conversation_usage_couldnt_refresh),
        )
        usage.updatedAt != null -> lines += PickerWindow(stringResource(R.string.conversation_usage_updated, usageAge(usage.updatedAt, now)))
    }
    val newest = maxOf(usage.updatedAt ?: 0L, windows.mapNotNull { it.capturedAt }.maxOrNull() ?: 0L)
    for (window in windows) {
        val captured = window.capturedAt ?: continue
        if (newest - captured > 600_000) lines += PickerWindow(stringResource(R.string.conversation_usage_as_of, windowName(window.kind), clockTime(captured, now)))
    }
    return lines
}

/**
 * One chip's list open over the screen, and a service's accounts stacked
 * over it in place (iOS `PickerPresenter`): its trailing edge on the chip's,
 * 10 above it, opened on the picked line, redrawn as the selection and the
 * readings change. A pick closes it, but an account switched keeps the
 * models up, open on the model it switched to. A touch outside closes the
 * accounts alone when they are up. The readings of the accounts it lists
 * are asked for again as it opens ([onOpened]), as desktop asks.
 */
@Composable
internal fun ModelPicker(
    open: PickerList?,
    catalog: ModeCatalog?,
    mode: Mode?,
    usage: Map<String, AccountUsage>,
    anchor: (PickerList) -> IntRect?,
    onModeChange: (Mode) -> Unit,
    onClose: () -> Unit,
    onOpened: (List<String>) -> Unit = {},
) {
    val list = rememberLastShown(open) ?: return
    val selection = mode ?: catalog?.defaults ?: return
    catalog ?: return
    val menus = remember(catalog, selection) { ModelMenus.of(catalog, selection) }
    var accounts by rememberSaveable(open) { mutableStateOf<String?>(null) }
    LaunchedEffect(open) { if (open != null) onOpened(menus.listedAccounts) }
    val state = rememberPopupState(open != null)
    if (!state.onScreen) return
    val progress by rememberPopupProgress(state)
    val density = LocalDensity.current
    val margin = with(density) { ModelPickerSpec.margin.roundToPx() }
    val gap = with(density) { ModelPickerSpec.anchorGap.roundToPx() }
    val top = WindowInsets.statusBars.getTop(density)
    val rect = remember(list, open) { anchor(list) } ?: return
    val room = with(density) { (rect.top - gap - top - margin).coerceAtLeast(0).toDp() }.coerceAtMost(ModelPickerSpec.maxHeight)
    val position = remember(rect, margin, gap, top) { PickerPanelPosition(rect, margin, gap, top) }
    fun choose(key: String, stacked: Boolean) {
        val next = PickerKeys.pick(key, menus, catalog)
        if (next != null && next != selection) onModeChange(next)
        if (stacked) accounts = null else onClose()
    }
    PagePopup(
        popupPositionProvider = position,
        onDismissRequest = { if (accounts != null) accounts = null else onClose() },
        properties = PopupProperties(
            flags = WindowManager.LayoutParams.FLAG_ALT_FOCUSABLE_IM or WindowManager.LayoutParams.FLAG_WATCH_OUTSIDE_TOUCH or WindowManager.LayoutParams.FLAG_LAYOUT_NO_LIMITS,
            inheritSecurePolicy = true,
            excludeFromSystemGesture = false,
        ),
    ) {
        Box(Modifier.popupMotion({ progress }, { TransformOrigin(1f, 1f) }), contentAlignment = Alignment.BottomEnd) {
            val base = when (list) {
                PickerList.Model -> modelLines(menus, usage)
                PickerList.Effort -> effortLines(menus)
            }
            val stacked = accounts?.let { id -> menus.services.firstOrNull { it.id == id } }
            PickerPanel(
                lines = base,
                title = stringResource(if (list == PickerList.Model) R.string.conversation_select_model else R.string.conversation_select_effort),
                minWidth = if (list == PickerList.Model) ModelPickerSpec.modelsMinWidth else ModelPickerSpec.effortsMinWidth,
                maxWidth = ModelPickerSpec.modelsMaxWidth,
                maxHeight = room,
                // Opened again on the picked line once an account is switched.
                opensOn = selection,
                covered = stacked != null,
                onCovered = { accounts = null },
                onTap = { line ->
                    when (line) {
                        is PickerLine.Heading -> line.opens?.let { accounts = if (accounts == it) null else it }
                        is PickerLine.Option -> choose(line.key, stacked = false)
                        else -> Unit
                    }
                },
                modifier = Modifier.testTag(ModelPickerTags.PANEL),
            )
            if (stacked != null) {
                PickerPanel(
                    lines = accountLines(stacked, menus, usage),
                    title = stringResource(R.string.conversation_accounts_of, stacked.label),
                    minWidth = ModelPickerSpec.accountsMinWidth,
                    maxWidth = ModelPickerSpec.accountsMaxWidth,
                    maxHeight = room,
                    opensOn = stacked.id,
                    onTap = { line -> if (line is PickerLine.Option) choose(line.key, stacked = true) },
                    modifier = Modifier.testTag(ModelPickerTags.ACCOUNTS),
                )
            }
        }
    }
}

/** Above its chip, trailing edges together, 10 over it and 8 inside the window. */
private class PickerPanelPosition(private val anchor: IntRect, private val margin: Int, private val gap: Int, private val top: Int) : PopupPositionProvider {
    override fun calculatePosition(anchorBounds: IntRect, windowSize: IntSize, layoutDirection: LayoutDirection, popupContentSize: IntSize): IntOffset {
        val x = (anchor.right - popupContentSize.width).coerceIn(margin, (windowSize.width - popupContentSize.width - margin).coerceAtLeast(margin))
        val y = (anchor.top - gap - popupContentSize.height).coerceAtLeast(top + margin)
        return IntOffset(x, y)
    }
}

/** A child that asks nothing of its column's width: a notice wraps to the width the other lines set. */
private object NoIntrinsicWidth : LayoutModifier {
    override fun MeasureScope.measure(measurable: Measurable, constraints: Constraints): MeasureResult {
        val placeable = measurable.measure(constraints)
        return layout(placeable.width, placeable.height) { placeable.place(0, 0) }
    }

    override fun IntrinsicMeasureScope.minIntrinsicWidth(measurable: IntrinsicMeasurable, height: Int) = 0
    override fun IntrinsicMeasureScope.maxIntrinsicWidth(measurable: IntrinsicMeasurable, height: Int) = 0
}

/**
 * One panel in Android's menu card: its lines down it 8 in, a block 5 after
 * the one before, scrolling when they don't fit, opened with the checked
 * line in view (centred, clamped to the list). [covered] by the accounts, a
 * touch on it closes them and TalkBack skips it.
 */
@Composable
private fun PickerPanel(
    lines: List<PickerLine>,
    title: String,
    minWidth: Dp,
    maxWidth: Dp,
    maxHeight: Dp,
    opensOn: Any?,
    onTap: (PickerLine) -> Unit,
    modifier: Modifier = Modifier,
    covered: Boolean = false,
    onCovered: () -> Unit = {},
) {
    val colors = HappyTheme.colors
    val scroll = rememberScrollState()
    var checkedTop by remember { mutableIntStateOf(-1) }
    var checkedHeight by remember { mutableIntStateOf(-1) }
    // Opened (and opened again on another pick), the checked line stands in the middle when it can.
    LaunchedEffect(opensOn) {
        val (top, height) = androidx.compose.runtime.snapshotFlow { Triple(checkedTop, checkedHeight, scroll.viewportSize) }
            .first { (_, height, viewport) -> height >= 0 && viewport > 0 }
            .let { it.first to it.second }
        scroll.scrollTo((top + height / 2 - scroll.viewportSize / 2).coerceIn(0, scroll.maxValue))
    }
    Surface(
        modifier = modifier.semantics { paneTitle = title },
        shape = MenuSpec.shape,
        color = MenuSpec.container(colors),
        shadowElevation = MenuSpec.shadow,
        border = if (colors.dark) BorderStroke(hairline(), MenuSpec.edge(colors)) else null,
    ) {
        Box {
            Column(
                Modifier
                    .width(IntrinsicSize.Max)
                    .widthIn(min = minWidth, max = maxWidth)
                    .heightIn(max = maxHeight)
                    .verticalScroll(scroll)
                    .padding(ModelPickerSpec.inset)
                    .then(if (covered) Modifier.clearAndSetSemantics {} else Modifier),
            ) {
                lines.forEachIndexed { index, line ->
                    val startsBlock = index > 0 && line !is PickerLine.Option
                    if (startsBlock) Spacer(Modifier.height(ModelPickerSpec.gap))
                    val placed = if (line is PickerLine.Option && line.checked) {
                        Modifier.onPlaced { checkedTop = it.positionInParent().y.toInt(); checkedHeight = it.size.height }
                    } else Modifier
                    PickerLineView(line, placed) { onTap(line) }
                }
            }
            if (covered) Box(Modifier.matchParentSize().pointerInput(Unit) { detectTapGestures { onCovered() } })
        }
    }
}

@Composable
private fun PickerLineView(line: PickerLine, modifier: Modifier, onTap: () -> Unit) {
    val colors = HappyTheme.colors
    val secondary = colors.textSecondary
    val critical = if (colors.dark) Color(0xFFFF453A) else Color(0xFFFF3B30)
    val small = TextStyle(fontSize = ModelPickerSpec.headingSize, lineHeight = 18.sp)
    val press = Modifier
        .fillMaxWidth()
        .padding(vertical = ModelPickerSpec.highlightInset)
        .clip(RoundedCornerShape(ModelPickerSpec.highlightRadius))
    when (line) {
        is PickerLine.Option -> Box(
            modifier
                .fillMaxWidth()
                .height(ModelPickerSpec.row)
                .alpha(if (line.disabled) 0.48f else 1f)
                .testTag(ModelPickerTags.option(line.key)),
        ) {
            Row(
                press.height(ModelPickerSpec.row - ModelPickerSpec.highlightInset * 2)
                    .clickable(enabled = !line.disabled, role = Role.Button, onClick = onTap)
                    .semantics(mergeDescendants = true) {
                        contentDescription = listOfNotNull(line.label, line.gauge?.let { "${it.left}%" }).joinToString(", ")
                        selected = line.checked
                    }
                    .padding(horizontal = ModelPickerSpec.padding),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Box(Modifier.width(ModelPickerSpec.checkColumn)) {
                    if (line.checked) Icon(MaterialSymbols.Check, null, Modifier.size(ModelPickerSpec.check), tint = colors.text)
                }
                Text(line.label, style = MenuSpec.label, color = colors.text, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f))
                line.gauge?.let {
                    Spacer(Modifier.width(ModelPickerSpec.checkGap))
                    GaugeView(it)
                }
            }
        }
        is PickerLine.Heading -> Row(
            modifier
                .then(press)
                .height(ModelPickerSpec.heading)
                .clickable(enabled = line.opens != null, role = Role.Button, onClick = onTap)
                .semantics(mergeDescendants = true) {
                    contentDescription = line.label
                    if (line.opens == null) heading()
                }
                .padding(horizontal = ModelPickerSpec.padding)
                .testTag(ModelPickerTags.heading(line.opens ?: line.service)),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(ModelPickerSpec.headingGap),
        ) {
            // The names take what the gauges leave, the service's shrinking last.
            Row(Modifier.weight(1f), horizontalArrangement = Arrangement.spacedBy(ModelPickerSpec.headingGap), verticalAlignment = Alignment.CenterVertically) {
                Text(line.service, style = small.copy(fontWeight = FontWeight.SemiBold), color = secondary, maxLines = 1, overflow = TextOverflow.Ellipsis)
                line.account?.let { Text(it, style = small, color = secondary, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f, fill = false).widthIn(max = ModelPickerSpec.accountMax)) }
            }
            line.gauges.forEach { GaugeView(it) }
            if (line.opens != null) Icon(MaterialSymbols.ChevronRight, null, Modifier.size(ModelPickerSpec.chevron), tint = secondary)
        }
        is PickerLine.Notice -> Text(
            line.text,
            style = TextStyle(fontSize = ModelPickerSpec.linkSize, lineHeight = 20.sp),
            color = if (line.warning) critical else secondary,
            modifier = modifier
                .then(NoIntrinsicWidth)
                .fillMaxWidth()
                .padding(start = ModelPickerSpec.padding + ModelPickerSpec.checkColumn, end = ModelPickerSpec.padding, top = ModelPickerSpec.detailsInsetY, bottom = ModelPickerSpec.detailsInsetY)
                .testTag(ModelPickerTags.NOTICE),
        )
        PickerLine.Separator -> Box(
            modifier
                .fillMaxWidth()
                .padding(horizontal = ModelPickerSpec.padding)
                .height(hairline())
                .background(MenuSpec.divider(colors)),
        )
        is PickerLine.Windows -> Column(
            modifier
                .fillMaxWidth()
                .padding(horizontal = ModelPickerSpec.padding, vertical = ModelPickerSpec.detailsInsetY)
                .semantics(mergeDescendants = true) {}
                .testTag(ModelPickerTags.WINDOWS),
            verticalArrangement = Arrangement.spacedBy(ModelPickerSpec.gap),
        ) {
            line.windows.forEach { window ->
                Row(Modifier.height(if (window.primary) ModelPickerSpec.detailsPrimaryLine else ModelPickerSpec.detailsLine), verticalAlignment = Alignment.CenterVertically) {
                    val labelStyle = if (window.primary) TextStyle(fontSize = ModelPickerSpec.linkSize, fontWeight = FontWeight.SemiBold) else small
                    Text(
                        window.label, style = labelStyle, maxLines = 1, overflow = TextOverflow.Ellipsis,
                        color = if (window.critical) critical else if (window.primary) colors.text else secondary,
                        modifier = if (window.resets != null) Modifier.widthIn(min = ModelPickerSpec.detailsLabelMin) else Modifier.weight(1f),
                    )
                    window.resets?.let {
                        Spacer(Modifier.width(ModelPickerSpec.detailsGap))
                        Text(it, style = small, color = secondary, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f))
                    }
                    window.gauge?.let {
                        Spacer(Modifier.width(ModelPickerSpec.detailsGap))
                        GaugeView(it, strong = window.primary)
                    }
                }
            }
        }
    }
}

/** What is left, then a ring that drains as the window is spent; red text when critical. */
@Composable
private fun GaugeView(gauge: PickerGauge, strong: Boolean = false) {
    val colors = HappyTheme.colors
    val critical = if (colors.dark) Color(0xFFFF453A) else Color(0xFFFF3B30)
    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(ModelPickerSpec.ringGap)) {
        Text(
            gauge.text,
            style = TextStyle(fontSize = ModelPickerSpec.headingSize, fontFeatureSettings = "tnum"),
            color = if (gauge.tone == AccountUsage.Tone.Critical) critical else if (strong) colors.text else colors.textSecondary,
            maxLines = 1,
        )
        if (gauge.ring) UsageRing(gauge.left, gauge.tone, diameter = ModelPickerSpec.ring, tagged = false)
    }
}
