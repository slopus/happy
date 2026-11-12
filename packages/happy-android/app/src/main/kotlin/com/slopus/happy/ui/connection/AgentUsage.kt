package com.slopus.happy.ui.connection

import android.text.format.DateFormat
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.gestures.detectTapGestures
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.IntrinsicSize
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.ScrollState
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.Immutable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.derivedStateOf
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.shadow
import androidx.compose.ui.geometry.CornerRadius
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.platform.LocalConfiguration
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.LocalLayoutDirection
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.text.withStyle
import androidx.compose.ui.unit.IntOffset
import androidx.compose.ui.unit.IntRect
import androidx.compose.ui.unit.IntSize
import androidx.compose.ui.unit.LayoutDirection
import androidx.compose.ui.unit.dp
import androidx.compose.ui.window.Popup
import androidx.compose.ui.window.PopupPositionProvider
import androidx.compose.ui.window.PopupProperties
import androidx.navigation.NavHostController
import com.slopus.happy.AppGraph
import com.slopus.happy.R
import com.slopus.happy.agent.ActivityDay
import com.slopus.happy.agent.DailyUsage
import com.slopus.happy.agent.DailyUsageSource
import com.slopus.happy.agent.LiveDailyUsageSource
import com.slopus.happy.agent.ModelTokens
import com.slopus.happy.agent.UsageAccount
import com.slopus.happy.agent.activityLevels
import com.slopus.happy.agent.decode
import com.slopus.happy.conversation.AccountUsage
import com.slopus.happy.conversation.ConversationApi
import com.slopus.happy.conversation.ModeCatalog
import com.slopus.happy.ui.components.Item
import com.slopus.happy.ui.components.ItemGroup
import com.slopus.happy.ui.components.ItemGroupSpec
import com.slopus.happy.ui.components.hairline
import com.slopus.happy.ui.layout.LocalWindowLayout
import com.slopus.happy.ui.layout.contentMaxWidth
import androidx.compose.ui.layout.Layout
import androidx.compose.ui.text.style.TextAlign
import com.slopus.happy.ui.conversation.UsageRing
import com.slopus.happy.ui.conversation.conversationRequest
import com.slopus.happy.ui.conversation.dayTime
import com.slopus.happy.ui.theme.HappyTheme
import com.slopus.happy.ui.theme.happyTextStyle
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.async
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.delay
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.JsonObject
import java.text.DecimalFormatSymbols
import java.time.DayOfWeek
import java.time.LocalDate
import java.time.ZoneId
import java.time.format.DateTimeFormatter
import java.time.format.TextStyle
import java.util.Locale
import kotlin.math.roundToLong

/** An agent connection's Usage: what its provider accounts spent, and what is left of their plans. */
@Serializable data class AgentUsageRoute(val connectionId: String)

object AgentUsageTags {
    const val ROW = "agentSettings.usage"
    const val ACTIVITY = "usage.activity"
    const val GRID = "usage.grid"
    const val CALLOUT = "usage.callout"
    const val MONTH = "usage.month"
    const val EMPTY = "usage.empty"
    fun vendor(type: String) = "usage.vendor.$type"
    fun account(id: String) = "usage.account.$id"
    fun strip(id: String) = "usage.strip.$id"
    fun limit(id: String, kind: AccountUsage.Window.Kind) = "usage.limit.$id.${kind.name}"
    fun model(id: String, model: String) = "usage.model.$id.$model"
}

/**
 * Desktop's UsageActivityGrid (C-342): a 10 cell on a 12 pitch with 2
 * corners; month labels 16 high and 4 over the cells, Mon, Wed and Fri 6
 * before them. Level 0 is the selected surface; 1–4 the link colour at
 * 25, 45, 70 and 100%, so the same shades read in light and dark.
 */
object UsageGridSpec {
    val cell = 10.dp
    val gap = 2.dp
    val step = 12.dp
    val radius = 2.dp
    val monthRow = 16.dp
    val monthGap = 4.dp
    val weekdayGap = 6.dp
    val weekday = happyTextStyle(fontSize = 9, lineHeight = 10)
    val month = happyTextStyle(fontSize = 11, lineHeight = 16)
    val levels = floatArrayOf(0.25f, 0.45f, 0.70f, 1f)
    val callout = happyTextStyle(fontSize = 12, lineHeight = 16)
    val calloutModel = happyTextStyle(fontSize = 11, lineHeight = 16, family = FontFamily.Monospace)
    val calloutMaxWidth = 280.dp
    val calloutGap = 6.dp
    val calloutMargin = 8.dp
}

/** The page's own rows: an account's name, its windows, its models. */
object UsagePageSpec {
    val padding = 16.dp
    val blockGap = 10.dp
    val ring = 14.dp
    val windowLabel = 64.dp
    val name = happyTextStyle(fontSize = 16, lineHeight = 24, letterSpacing = 0.15f, weight = FontWeight.Medium)
    val line = happyTextStyle(fontSize = 14, lineHeight = 20, letterSpacing = 0.1f)
    val small = happyTextStyle(fontSize = 13, lineHeight = 18)
    val model = happyTextStyle(fontSize = 13, lineHeight = 18, family = FontFamily.Monospace)
}

/** What Usage shows: nothing read yet, or the accounts and, where the server keeps one, the year of days. */
@Immutable
sealed interface AgentUsageState {
    data object Loading : AgentUsageState

    @Immutable
    data class Ready(
        val accounts: List<UsageAccount>,
        val history: DailyUsage? = null,
        /** The catalog's name for each account, where it has one. */
        val names: Map<String, String> = emptyMap(),
    ) : AgentUsageState
}

/** One service on the page and the accounts under it, the most used first. */
@Immutable
data class UsageVendor(val type: String, val name: String, val accounts: List<UsageAccount>)

/**
 * Desktop's `serviceGroups`: the accounts with anything to show (a plan
 * window, a model that spent, or days on the grid), grouped by service, both
 * the most used first by the year's tokens and otherwise as they came.
 */
fun usageVendors(accounts: List<UsageAccount>, history: DailyUsage?): List<UsageVendor> {
    val tokens = history?.accountTokens().orEmpty()
    fun used(account: UsageAccount) = tokens[account.providerId] ?: 0L
    val shown = accounts.filter { it.limits != null || it.models.isNotEmpty() || used(it) > 0 }
    val groups = LinkedHashMap<String, MutableList<UsageAccount>>()
    for (account in shown.sortedByDescending(::used)) groups.getOrPut(account.type ?: account.providerId) { ArrayList() } += account
    return groups.entries
        .sortedByDescending { (_, list) -> list.sumOf(::used) }
        .map { (type, list) -> UsageVendor(type, ModeCatalog.providerName(type), list) }
}

/**
 * Tokens as desktop's compact numbers read them: 950, 1.2K, 736.2M, 1.4B,
 * one decimal at most and none when it is .0, in the locale's separator.
 */
fun usageTokens(count: Long, locale: Locale = Locale.getDefault()): String {
    val n = count.coerceAtLeast(0)
    if (n < 1_000) return n.toString()
    val units = listOf("K" to 1_000L, "M" to 1_000_000L, "B" to 1_000_000_000L, "T" to 1_000_000_000_000L)
    var at = units.indexOfLast { n >= it.second }
    var tenths = (n * 10.0 / units[at].second).roundToLong()
    // 999.96K is 1M, not 1000K.
    if (tenths >= 10_000 && at < units.lastIndex) {
        at += 1
        tenths = (n * 10.0 / units[at].second).roundToLong()
    }
    val whole = tenths / 10
    val decimal = if (tenths % 10 == 0L) "" else "${DecimalFormatSymbols.getInstance(locale).decimalSeparator}${tenths % 10}"
    return "$whole$decimal${units[at].first}"
}

/** Agent connection [connectionId]'s Usage, read now and every minute it stays open. */
@Composable
internal fun AgentUsagePage(graph: AppGraph, nav: NavHostController, connectionId: String) {
    val session = remember(connectionId) { graph.agentSessions.session(connectionId) }
    val daily: DailyUsageSource? = remember(session) { session?.client?.let(::LiveDailyUsageSource) }
    var state by remember { mutableStateOf<AgentUsageState>(AgentUsageState.Loading) }
    var now by remember { mutableStateOf(System.currentTimeMillis()) }
    LaunchedEffect(session) {
        if (session == null) {
            state = AgentUsageState.Ready(emptyList())
            return@LaunchedEffect
        }
        // Names only: without the catalog an account reads by its id.
        val names = try {
            ConversationApi(bytesRequest = null, request = session.conversationRequest(), cloud = session.client.cloud).catalog()
                .providers.mapNotNull { provider -> provider.name?.let { provider.id to it } }.toMap()
        } catch (e: CancellationException) {
            throw e
        } catch (_: Exception) {
            emptyMap()
        }
        while (true) {
            val (accounts, history) = coroutineScope {
                val accounts = async {
                    try {
                        UsageAccount.parse(session.client.decode<JsonObject>("GET", "/v0/usage"))
                    } catch (e: CancellationException) {
                        throw e
                    } catch (_: Exception) {
                        null
                    }
                }
                val history = async { daily?.read(DailyUsage.DAYS, ZoneId.systemDefault()) }
                accounts.await() to history.await()
            }
            // A failed read keeps what was read before, and says nothing.
            val before = state as? AgentUsageState.Ready
            state = AgentUsageState.Ready(accounts ?: before?.accounts.orEmpty(), history ?: before?.history, names)
            now = System.currentTimeMillis()
            delay(REFRESH_MILLIS)
        }
    }
    AgentUsageScreen(state, onBack = { nav.popBackStack() }, now = now)
}

private const val REFRESH_MILLIS = 60_000L

/**
 * Settings › Usage, desktop's (HappyAgentUsageSettings): a year of days on
 * top, "N tokens in the last year" under it; then each service, the most
 * used first, and in it each account: its name and plan, its last 30 days
 * in one row, what is left of its week and session (a ring and when each
 * starts over), how current that is, and one line per model that spent.
 *
 * Only what exists is shown: no grid without a history, no account with
 * nothing to show, and no failure ever put into words.
 */
@Composable
fun AgentUsageScreen(
    state: AgentUsageState,
    onBack: () -> Unit,
    now: Long = System.currentTimeMillis(),
    today: LocalDate = LocalDate.now(),
) {
    AgentPage(stringResource(R.string.usage_title), onBack) {
        when (state) {
            AgentUsageState.Loading -> ItemGroup { Item(stringResource(R.string.common_loading), loading = true) }
            is AgentUsageState.Ready -> UsageContent(state, now, today)
        }
    }
}

@Composable
private fun UsageContent(state: AgentUsageState.Ready, now: Long, today: LocalDate) {
    val history = state.history
    val year = remember(history, today) { history?.activity(today.minusDays(DailyUsage.YEAR_DAYS), today).orEmpty() }
    val yearTokens = year.sumOf { it.tokens }
    val locale = LocalConfiguration.current.locales[0]
    if (history != null && yearTokens > 0) {
        val amount = usageTokens(yearTokens, locale)
        // A history shorter than the year says where it starts.
        val summary = if (year.first().date == history.since) {
            stringResource(R.string.usage_tokens_since, amount, history.since.format(DateTimeFormatter.ofPattern(DateFormat.getBestDateTimePattern(locale, "MMMd"), locale)))
        } else {
            stringResource(R.string.usage_tokens_year, amount)
        }
        Column(Modifier.testTag(AgentUsageTags.ACTIVITY)) {
            UsageSectionHeader(stringResource(R.string.usage_activity), summary)
            ItemGroup(noTitleSpacer = 0.dp) {
                Box(Modifier.padding(UsagePageSpec.padding)) {
                    UsageActivityGrid(year, UsageGridVariant.Year, stringResource(R.string.usage_grid_label), Modifier.testTag(AgentUsageTags.GRID))
                }
            }
        }
    }
    val vendors = remember(state.accounts, history) { usageVendors(state.accounts, history) }
    if (vendors.isEmpty() && yearTokens == 0L) {
        ItemGroup(Modifier.testTag(AgentUsageTags.EMPTY)) {
            Item(stringResource(R.string.usage_empty_title), subtitle = stringResource(R.string.usage_empty_detail), subtitleLines = 3)
        }
        return
    }
    for (vendor in vendors) {
        ItemGroup(Modifier.testTag(AgentUsageTags.vendor(vendor.type)), title = vendor.name) {
            for ((index, account) in vendor.accounts.withIndex()) {
                if (index > 0) Box(Modifier.padding(horizontal = UsagePageSpec.padding).fillMaxWidth().height(hairline()).background(HappyTheme.colors.divider))
                UsageAccountBlock(account, state.names[account.providerId], history, now, today)
            }
        }
    }
}

@Composable
private fun UsageAccountBlock(account: UsageAccount, catalogName: String?, history: DailyUsage?, now: Long, today: LocalDate) {
    val colors = HappyTheme.colors
    val name = catalogName ?: account.name ?: ModeCatalog.providerName(account.providerId)
    Column(
        Modifier
            .fillMaxWidth()
            .testTag(AgentUsageTags.account(account.providerId))
            .padding(start = UsagePageSpec.padding, end = UsagePageSpec.padding, top = UsagePageSpec.padding, bottom = UsagePageSpec.padding),
        verticalArrangement = Arrangement.spacedBy(UsagePageSpec.blockGap),
    ) {
        Row(verticalAlignment = Alignment.Bottom, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            Text(name, style = UsagePageSpec.name, color = colors.text, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f, fill = false))
            account.planName?.let { Text(it, style = UsagePageSpec.line, color = colors.textSecondary, maxLines = 1) }
        }
        val strip = remember(history, today, account.providerId) {
            history?.activity(today.minusDays(DailyUsage.STRIP_DAYS - 1), today, account.providerId).orEmpty()
        }
        if (strip.any { it.tokens > 0 }) {
            UsageActivityGrid(strip, UsageGridVariant.Strip, stringResource(R.string.usage_strip_label, name), Modifier.testTag(AgentUsageTags.strip(account.providerId)))
        }
        account.limits?.let { limits ->
            Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
                for (window in listOfNotNull(limits.week, limits.session)) LimitRow(account.providerId, window, now)
                val freshness = when {
                    limits.refreshing -> stringResource(R.string.conversation_usage_updating)
                    limits.updatedAt != null -> stringResource(R.string.conversation_usage_updated, usageAge(limits.updatedAt, now))
                    else -> null
                }
                freshness?.let { Text(it, style = UsagePageSpec.small, color = colors.textSecondary) }
            }
        }
        if (account.models.isNotEmpty()) {
            Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
                for (model in account.models) ModelLine(account.providerId, model)
            }
        }
    }
}

/** "Week   Resets Sat 4:00 AM   27% left ◔": both windows read alike, as desktop's Settings has them. */
@Composable
private fun LimitRow(providerId: String, window: AccountUsage.Window, now: Long) {
    val colors = HappyTheme.colors
    val tone = AccountUsage.tone(window.left, window.blocking)
    Row(
        Modifier.fillMaxWidth().testTag(AgentUsageTags.limit(providerId, window.kind)),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        Text(
            stringResource(if (window.kind == AccountUsage.Window.Kind.Week) R.string.agent_input_usage_popup_week else R.string.agent_input_usage_popup_session),
            style = UsagePageSpec.line,
            color = colors.text,
            modifier = Modifier.widthIn(min = UsagePageSpec.windowLabel),
        )
        Text(
            window.resetsAt?.let { stringResource(R.string.agent_input_usage_popup_resets, dayTime(it, now)) }.orEmpty(),
            style = UsagePageSpec.line,
            color = colors.textSecondary,
            maxLines = 1,
            overflow = TextOverflow.Ellipsis,
            modifier = Modifier.weight(1f),
        )
        Text(
            stringResource(R.string.usage_left, window.left),
            style = UsagePageSpec.line,
            color = if (tone == AccountUsage.Tone.Critical) colors.textDestructive else colors.textSecondary,
        )
        UsageRing(window.left, tone, diameter = UsagePageSpec.ring, tagged = false)
    }
}

/**
 * "anthropic/opus-5        5.7M day · 37.4M week · 134.7M month": the model on
 * the left, its windows on the right, leaving out windows with nothing in
 * them. Where both don't fit one line, the windows go under it, still right.
 */
@Composable
private fun ModelLine(providerId: String, model: ModelTokens) {
    val colors = HappyTheme.colors
    val locale = LocalConfiguration.current.locales[0]
    val windows = listOfNotNull(
        model.day?.total?.takeIf { it > 0 }?.let { stringResource(R.string.usage_window_day, usageTokens(it, locale)) },
        model.week?.total?.takeIf { it > 0 }?.let { stringResource(R.string.usage_window_week, usageTokens(it, locale)) },
        model.month?.total?.takeIf { it > 0 }?.let { stringResource(R.string.usage_window_month, usageTokens(it, locale)) },
    ).joinToString(" · ")
    val gap = with(LocalDensity.current) { 12.dp.roundToPx() }
    Layout(
        content = {
            Text(model.modelId, style = UsagePageSpec.model, color = colors.text)
            Text(windows, style = UsagePageSpec.small, color = colors.textSecondary, textAlign = TextAlign.End)
        },
        modifier = Modifier.fillMaxWidth().testTag(AgentUsageTags.model(providerId, model.modelId)),
    ) { measurables, constraints ->
        val loose = constraints.copy(minWidth = 0)
        val id = measurables[0].measure(loose)
        val tokens = measurables[1].measure(loose)
        val width = constraints.maxWidth
        if (id.width + gap + tokens.width <= width) {
            val height = maxOf(id.height, tokens.height)
            layout(width, height) {
                id.placeRelative(0, (height - id.height) / 2)
                tokens.placeRelative(width - tokens.width, (height - tokens.height) / 2)
            }
        } else {
            layout(width, id.height + tokens.height) {
                id.placeRelative(0, 0)
                tokens.placeRelative(width - tokens.width, id.height)
            }
        }
    }
}

/** A section's own header, as a titled group's, with a line under it in the page's grey (desktop's description). */
@Composable
private fun UsageSectionHeader(title: String, subtitle: String) {
    val colors = HappyTheme.colors
    val layout = LocalWindowLayout.current
    Column(
        Modifier
            .fillMaxWidth()
            .contentMaxWidth(layout)
            .padding(horizontal = ItemGroupSpec.paddingHorizontal + ItemGroupSpec.headerPaddingHorizontal)
            .padding(top = ItemGroupSpec.headerPaddingTop, bottom = ItemGroupSpec.headerPaddingBottom),
    ) {
        Text(title.uppercase(), style = ItemGroupSpec.header, color = colors.grouped.sectionTitle)
        Text(subtitle, style = ItemGroupSpec.footer, color = colors.grouped.sectionTitle)
    }
}

/** `usageAge`: how long ago, in a word. */
@Composable
private fun usageAge(ms: Long, now: Long): String {
    val minutes = ((now - ms) / 60_000).toInt()
    return when {
        minutes < 1 -> stringResource(R.string.conversation_usage_just_now)
        minutes < 60 -> stringResource(R.string.conversation_usage_minutes_ago, minutes)
        minutes / 60 < 20 -> stringResource(R.string.conversation_usage_hours_ago, minutes / 60)
        else -> stringResource(R.string.conversation_usage_at, dayTime(ms, now))
    }
}

enum class UsageGridVariant { Year, Strip }

/**
 * A GitHub-style grid of daily tokens, one cell a day, its shade the day's
 * tokens against the other days shown ([activityLevels]). [UsageGridVariant.Year]
 * lays the weeks out as columns, Monday on top, with month and weekday
 * labels, and starts on the first day's weekday: nothing is drawn before it.
 * [UsageGridVariant.Strip] is one row, no labels. Wider than its room, it
 * scrolls sideways and opens on today; the weekdays stay put.
 *
 * A tapped cell shows a callout over it, in its own window so the scroll
 * never clips it: the day, its tokens, and the three models that spent most,
 * or "No usage". A tap anywhere else closes it.
 */
@Composable
fun UsageActivityGrid(days: List<ActivityDay>, variant: UsageGridVariant, label: String, modifier: Modifier = Modifier) {
    val colors = HappyTheme.colors
    val locale = LocalConfiguration.current.locales[0]
    val level = remember(days) { activityLevels(days) }
    val year = variant == UsageGridVariant.Year
    val offset = if (year && days.isNotEmpty()) days.first().date.dayOfWeek.value - 1 else 0
    val rows = if (year) 7 else 1
    fun column(index: Int) = if (year) (index + offset) / 7 else index
    fun row(index: Int) = if (year) (index + offset) % 7 else 0
    val columns = if (days.isEmpty()) 0 else column(days.lastIndex) + 1
    val width = UsageGridSpec.step * columns - UsageGridSpec.gap
    val height = UsageGridSpec.step * rows - UsageGridSpec.gap
    var shown by remember(days) { mutableStateOf<Int?>(null) }
    val empty = colors.surfaceSelected
    val shades = UsageGridSpec.levels.map { colors.textLink.copy(alpha = it) }
    // Time runs left to right whatever the language.
    CompositionLocalProvider(LocalLayoutDirection provides LayoutDirection.Ltr) {
        Row(modifier) {
            if (year) {
                Column(Modifier.padding(top = UsageGridSpec.monthRow + UsageGridSpec.monthGap), verticalArrangement = Arrangement.spacedBy(UsageGridSpec.gap)) {
                    for (weekday in DayOfWeek.entries) {
                        Box(Modifier.height(UsageGridSpec.cell), contentAlignment = Alignment.CenterStart) {
                            if (weekday == DayOfWeek.MONDAY || weekday == DayOfWeek.WEDNESDAY || weekday == DayOfWeek.FRIDAY) {
                                Text(weekday.getDisplayName(TextStyle.SHORT, locale), style = UsageGridSpec.weekday, color = colors.textSecondary, maxLines = 1)
                            }
                        }
                    }
                }
                Spacer(Modifier.width(UsageGridSpec.weekdayGap))
            }
            // Reversed: at rest it shows the end, today.
            val scroll = rememberScrollState()
            Box(Modifier.horizontalScroll(scroll, reverseScrolling = true)) {
                Column(verticalArrangement = Arrangement.spacedBy(UsageGridSpec.monthGap)) {
                    if (year) MonthLabels(days, ::column, width, locale, scroll)
                    Box(Modifier.size(width, height)) {
                        Canvas(
                            Modifier
                                .size(width, height)
                                .semantics { contentDescription = label }
                                .pointerInput(days) {
                                    val step = UsageGridSpec.step.toPx()
                                    detectTapGestures { at ->
                                        val col = (at.x / step).toInt()
                                        val r = (at.y / step).toInt()
                                        val index = if (year) col * 7 + r - offset else col
                                        shown = index.takeIf { it in days.indices }
                                    }
                                },
                        ) {
                            val step = UsageGridSpec.step.toPx()
                            val cell = UsageGridSpec.cell.toPx()
                            val corner = CornerRadius(UsageGridSpec.radius.toPx())
                            for ((index, day) in days.withIndex()) {
                                val shade = level(day.tokens).let { if (it == 0) empty else shades[it - 1] }
                                drawRoundRect(shade, Offset(column(index) * step, row(index) * step), Size(cell, cell), corner)
                            }
                            shown?.let { index ->
                                val stroke = 1.dp.toPx()
                                drawRoundRect(
                                    colors.textSecondary,
                                    Offset(column(index) * step + stroke / 2, row(index) * step + stroke / 2),
                                    Size(cell - stroke, cell - stroke),
                                    corner,
                                    style = androidx.compose.ui.graphics.drawscope.Stroke(stroke),
                                )
                            }
                        }
                        shown?.let { index ->
                            val density = LocalDensity.current
                            val cellAt = with(density) { IntOffset((UsageGridSpec.step * column(index)).roundToPx(), (UsageGridSpec.step * row(index)).roundToPx()) }
                            val cellSize = with(density) { UsageGridSpec.cell.roundToPx() }
                            val gap = with(density) { UsageGridSpec.calloutGap.roundToPx() }
                            val margin = with(density) { UsageGridSpec.calloutMargin.roundToPx() }
                            Popup(
                                popupPositionProvider = remember(cellAt, cellSize) { CalloutPosition(cellAt, cellSize, gap, margin) },
                                onDismissRequest = { shown = null },
                                properties = PopupProperties(focusable = false, dismissOnClickOutside = true),
                            ) {
                                UsageCallout(days[index], locale)
                            }
                        }
                    }
                }
            }
        }
    }
}

/**
 * Month names over the weeks they start in: the first column, and each
 * column holding a 1st; one needs three columns of room, else the earlier
 * gives way (desktop's rule). Each starts at its column's left and may run
 * on to the right. A grid scrolled sideways shows no label cut at its left
 * edge: one whose start has scrolled out of view goes until it is back.
 */
@Composable
private fun MonthLabels(days: List<ActivityDay>, column: (Int) -> Int, width: androidx.compose.ui.unit.Dp, locale: Locale, scroll: ScrollState) {
    val colors = HappyTheme.colors
    val labels = remember(days, locale) { usageMonthLabels(days, column).map { (col, date) -> col to date.month.getDisplayName(TextStyle.SHORT, locale) } }
    val step = with(LocalDensity.current) { UsageGridSpec.step.toPx() }
    // Reversed: the scroll counts back from the end, so the left edge in view is how far it can go less how far it has.
    val hidden by remember(labels, step) {
        derivedStateOf {
            // Unmeasured yet, the scroll has no end: nothing is hidden.
            val left = if (scroll.maxValue == Int.MAX_VALUE) 0f else (scroll.maxValue - scroll.value).toFloat()
            labels.filter { (col, _) -> col * step < left - 0.5f }.map { it.first }.toSet()
        }
    }
    Box(Modifier.size(width, UsageGridSpec.monthRow)) {
        for ((col, name) in labels) {
            if (col in hidden) continue
            Text(
                name,
                style = UsageGridSpec.month,
                color = colors.textSecondary,
                maxLines = 1,
                softWrap = false,
                modifier = Modifier.offset(x = UsageGridSpec.step * col).testTag(AgentUsageTags.MONTH),
            )
        }
    }
}

/** Where [MonthLabels] puts its names: each month's first column and its date, less any with another under three columns after it. */
internal fun usageMonthLabels(days: List<ActivityDay>, column: (Int) -> Int): List<Pair<Int, LocalDate>> {
    val starts = days.withIndex().filter { (index, day) -> index == 0 || day.date.dayOfMonth == 1 }.map { (index, day) -> column(index) to day.date }
    return starts.filterIndexed { at, (col, _) -> at == starts.lastIndex || starts[at + 1].first - col >= 3 }
}

/** A day's callout: "Tue, Nov 11", "1.4M tokens", then its top three models; or "No usage". */
@Composable
private fun UsageCallout(day: ActivityDay, locale: Locale) {
    val colors = HappyTheme.colors
    val shape = RoundedCornerShape(8.dp)
    val date = day.date.format(DateTimeFormatter.ofPattern(DateFormat.getBestDateTimePattern(locale, "EEEMMMdy"), locale))
    Column(
        Modifier
            .testTag(AgentUsageTags.CALLOUT)
            .widthIn(max = UsageGridSpec.calloutMaxWidth)
            .width(IntrinsicSize.Max)
            .shadow(4.dp, shape)
            .background(colors.surface, shape)
            .border(1.dp, colors.divider, shape)
            .padding(horizontal = 8.dp, vertical = 6.dp),
        verticalArrangement = Arrangement.spacedBy(2.dp),
    ) {
        Text(date, style = UsageGridSpec.callout.copy(fontWeight = FontWeight.SemiBold), color = colors.text)
        Text(
            when {
                day.tokens <= 0 -> stringResource(R.string.usage_no_usage)
                day.tokens == 1L -> stringResource(R.string.usage_one_token)
                else -> stringResource(R.string.usage_tokens_count, usageTokens(day.tokens, locale))
            },
            style = UsageGridSpec.callout,
            color = colors.text,
        )
        for ((model, tokens) in day.models.take(3)) {
            // The model at the left, its tokens at the right, 12 apart at least.
            Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(12.dp), verticalAlignment = Alignment.CenterVertically) {
                Text(model, style = UsageGridSpec.calloutModel, color = colors.textSecondary, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f))
                Text(usageTokens(tokens, locale), style = UsageGridSpec.callout, color = colors.textSecondary)
            }
        }
    }
}

/** Over the cell at [cell] in the grid, centred, kept [margin] inside the window; under it where there is no room above. */
private class CalloutPosition(private val cell: IntOffset, private val size: Int, private val gap: Int, private val margin: Int) : PopupPositionProvider {
    override fun calculatePosition(anchorBounds: IntRect, windowSize: IntSize, layoutDirection: LayoutDirection, popupContentSize: IntSize): IntOffset {
        val left = anchorBounds.left + cell.x
        val top = anchorBounds.top + cell.y
        val x = (left + size / 2 - popupContentSize.width / 2).coerceIn(margin, maxOf(margin, windowSize.width - popupContentSize.width - margin))
        val above = top - gap - popupContentSize.height
        val y = if (above >= margin) above else top + size + gap
        return IntOffset(x, y)
    }
}
