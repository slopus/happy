package com.slopus.happy.ui.connection

import android.content.Context
import androidx.compose.foundation.ExperimentalFoundationApi
import androidx.compose.foundation.clickable
import androidx.compose.foundation.combinedClickable
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.WindowInsetsSides
import androidx.compose.foundation.layout.defaultMinSize
import androidx.compose.foundation.layout.displayCutout
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.only
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.systemBars
import androidx.compose.foundation.layout.union
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.layout.windowInsetsPadding
import androidx.compose.foundation.layout.wrapContentHeight
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Text
import androidx.compose.material3.ripple
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.Immutable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.slopus.happy.R
import com.slopus.happy.call.CallAllowance
import com.slopus.happy.call.PreferencesCallUsageStore
import com.slopus.happy.payments.Offer
import com.slopus.happy.payments.Offers
import com.slopus.happy.payments.ProMonth
import com.slopus.happy.payments.RestoreResult
import com.slopus.happy.payments.Subscription
import com.slopus.happy.ui.call.CallSheetSpec
import com.slopus.happy.ui.call.RestoreAlert
import com.slopus.happy.ui.components.Alert
import com.slopus.happy.ui.components.AlertButton
import com.slopus.happy.ui.components.HappyAlert
import com.slopus.happy.ui.components.Icon
import com.slopus.happy.ui.components.Ionicon
import com.slopus.happy.ui.components.ItemGroup
import com.slopus.happy.ui.components.ItemSpec
import com.slopus.happy.ui.components.LocalBarOnGlass
import com.slopus.happy.ui.components.RoundButton
import com.slopus.happy.ui.components.SceneAnimation
import com.slopus.happy.ui.components.StackHeader
import com.slopus.happy.ui.components.revealRow
import com.slopus.happy.ui.settings.SettingsCard
import com.slopus.happy.ui.settings.SettingsEntry
import com.slopus.happy.ui.settings.SettingsPageSpec
import com.slopus.happy.ui.settings.SettingsSection
import com.slopus.happy.ui.settings.SettingsTile
import com.slopus.happy.ui.settings.SettingsTiles
import com.slopus.happy.ui.start.GrainGradient
import com.slopus.happy.ui.start.StartGallerySpec
import com.slopus.happy.ui.start.StartSpec
import com.slopus.happy.ui.theme.HappyTheme
import java.text.DateFormat
import java.util.Date
import kotlinx.coroutines.launch
import kotlinx.serialization.Serializable


/** An agent connection's Voice page (iOS's `AgentVoiceViewController`); [reveal] as on settings. */
@Serializable data class AgentVoiceRoute(val connectionId: String, val reveal: String? = null)

object AgentVoiceTags {
    const val SUPPORT = "agentVoice.support"
    const val SUPPORT_ART = "agentVoice.support.art"
    const val SUPPORT_TITLE = "agentVoice.support.title"
    const val SUPPORT_LINE = "agentVoice.support.line"
    const val ROW = "agentVoice.row"
    const val PLAN = "agentVoice.plan"
    const val FREE = "agentVoice.free"
    const val LEFT = "agentVoice.left"
    const val BACK = "agentVoice.back"
    const val SUBSCRIBE = "agentVoice.subscribe"
    const val RESTORE = "agentVoice.restore"
    const val PAGE = "agentVoice.supportPage"
    const val PAGE_ART = "agentVoice.supportPage.art"
    const val PAGE_NOT_YET = "agentVoice.supportPage.notYet"
    const val SUBSCRIBE_BUTTON = "agentVoice.supportPage.subscribe"
    const val PAGE_RESTORE = "agentVoice.supportPage.restore"
    const val PAGE_MANAGE = "agentVoice.supportPage.manage"
}

/**
 * What an agent connection's Settings say about voice (iOS's
 * `AgentVoiceStatus`), read and never changed: this phone's voice time
 * ([CallAllowance], read from its store: the free time, or the
 * subscription's month of hours) and what the subscription offers now
 * ([offer]).
 */
@Immutable
data class AgentVoiceSummary(val remainingMillis: Long, val freeAgainMillis: Long? = null, val offer: Offer = Offer.Unavailable) {
    val minutesLeft: Int get() = if (remainingMillis > 0) maxOf(1, (remainingMillis / 60_000).toInt()) else 0

    companion object {
        fun read(context: Context, offer: Offer = Offer.Unavailable, period: () -> ProMonth? = { null }, now: Long = System.currentTimeMillis()): AgentVoiceSummary {
            val allowance = CallAllowance(PreferencesCallUsageStore(context.getSharedPreferences(PreferencesCallUsageStore.PREFS_NAME, Context.MODE_PRIVATE)), period = period)
            val remaining = allowance.remaining(now)
            return AgentVoiceSummary(remaining, if (remaining > 0) null else allowance.freeAgain(now)?.takeIf { it > now }, offer)
        }
    }
}

/** This phone's voice summary, read as the page is composed and again as the offer changes. */
@Composable
fun rememberAgentVoiceSummary(offers: Offers, subscription: Subscription): AgentVoiceSummary {
    val context = LocalContext.current
    val offer by offers.offers.collectAsStateWithLifecycle()
    return remember(context, offer) { AgentVoiceSummary.read(context, offer, subscription::period) }
}

/**
 * The boba row's places: the boba a tile's square ([SettingsPageSpec.tile])
 * in the 32 icon box every row has, where the other rows' tiles are, held at
 * the top. The row's top inset is 4 less than [ItemSpec]'s 16 and the
 * title's line 4 lower, so the boba and the title's first line share a
 * middle 28 from the top, as a one-line row's tile and title do.
 */
object SupportBobaSpec {
    val art = SettingsPageSpec.tile
    val top = ItemSpec.paddingVertical - 4.dp
    val titleTop = 4.dp
}

/**
 * Support Happy, under Profile (iOS's `supportRow`): the boba at a tile's
 * size where the other rows' tiles are, held at the top; "Happy is open
 * source", and under it at the same size in the page's quieter grey what
 * sending boba is for, wrapping at the person's font size, the row growing
 * for them; then a chevron. The boba stays still here, the pose it was
 * drawn to rest in; it moves only on [SupportScreen], which the row opens.
 * TalkBack reads it as one button.
 */
@OptIn(ExperimentalFoundationApi::class)
@Composable
fun SupportBobaCard(onClick: () -> Unit) {
    val colors = HappyTheme.colors
    val spoken = stringResource(R.string.agent_voice_support_spoken)
    ItemGroup {
        Row(
            modifier = Modifier
                .revealRow(AgentVoiceTags.SUPPORT)
                .fillMaxWidth()
                .combinedClickable(interactionSource = remember { MutableInteractionSource() }, indication = ripple(color = colors.text), role = Role.Button, onClick = onClick)
                .semantics(mergeDescendants = true) { contentDescription = spoken }
                .defaultMinSize(minHeight = ItemSpec.minHeight)
                .padding(start = ItemSpec.paddingHorizontal, end = ItemSpec.paddingHorizontal, top = SupportBobaSpec.top, bottom = ItemSpec.paddingVertical),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Box(Modifier.align(Alignment.Top).padding(end = ItemSpec.iconGap).size(ItemSpec.iconSize).testTag(AgentVoiceTags.SUPPORT_ART), contentAlignment = Alignment.Center) {
                // Never asked to play: the held last frame.
                SceneAnimation(R.raw.state_boba, requested = 0, onReplay = null, size = SupportBobaSpec.art)
            }
            Column(Modifier.weight(1f).padding(top = SupportBobaSpec.titleTop)) {
                Text(stringResource(R.string.agent_voice_support_title), style = ItemSpec.title, color = colors.text, modifier = Modifier.testTag(AgentVoiceTags.SUPPORT_TITLE))
                Text(stringResource(R.string.agent_voice_support_line), style = ItemSpec.title, color = colors.textSecondary, modifier = Modifier.testTag(AgentVoiceTags.SUPPORT_LINE))
            }
            Icon(icon = Ionicon.ChevronForward, size = ItemSpec.chevronSize, color = colors.grouped.chevron, modifier = Modifier.padding(start = ItemSpec.rightSectionGap))
        }
    }
}

/** Support Happy as search finds it: it opens [SupportScreen]. */
@Composable
fun supportBobaEntry(onClick: () -> Unit) = SettingsEntry(
    id = AgentVoiceTags.SUPPORT,
    title = stringResource(R.string.agent_voice_support_title),
    icon = { SettingsTile(Ionicon.Heart, SettingsTiles.red) },
    onClick = onClick,
)

/** Settings' Voice row: the free time left on this phone. */
@Composable
fun agentVoiceEntry(summary: AgentVoiceSummary, onClick: () -> Unit) = SettingsEntry(
    id = AgentVoiceTags.ROW,
    title = stringResource(R.string.agent_voice_title),
    icon = { SettingsTile(Ionicon.MicOutline, SettingsTiles.orange) },
    detail = if (summary.minutesLeft > 0) stringResource(R.string.agent_voice_minutes_left, summary.minutesLeft) else stringResource(R.string.agent_voice_used_up),
    onClick = onClick,
)

/**
 * The Voice page's cards, which the page draws and Settings' search finds:
 * what voice is and the time left, then the subscription ([onSubscribe]
 * opens its sheet) at the store's price and restore ([onRestore]), or why
 * they can't be used. Nothing here changes voice.
 */
@Composable
fun agentVoiceSections(summary: AgentVoiceSummary, onSubscribe: () -> Unit = {}, onRestore: () -> Unit = {}): List<SettingsSection> {
    val left = summary.minutesLeft
    val offer = summary.offer
    val subscribed = offer == Offer.Subscribed
    val price = offer.price
    val allowance = listOfNotNull(
        if (subscribed) {
            SettingsEntry(AgentVoiceTags.PLAN, stringResource(R.string.agent_voice_plan), icon = { SettingsTile(Ionicon.MicOutline, SettingsTiles.orange) }, subtitle = stringResource(R.string.call_subscribe_allowance), chevron = false)
        } else {
            SettingsEntry(AgentVoiceTags.PLAN, stringResource(R.string.agent_voice_plan), icon = { SettingsTile(Ionicon.MicOutline, SettingsTiles.orange) }, detail = stringResource(R.string.agent_voice_free), chevron = false)
        },
        if (subscribed) null else SettingsEntry(AgentVoiceTags.FREE, stringResource(R.string.agent_voice_free_time), icon = { SettingsTile(Ionicon.TimeOutline, SettingsTiles.blue) }, detail = stringResource(R.string.agent_voice_free_time_value), chevron = false),
        SettingsEntry(AgentVoiceTags.LEFT, stringResource(R.string.agent_voice_left), icon = { SettingsTile(Ionicon.HourglassOutline, SettingsTiles.green) }, detail = if (left > 0) stringResource(R.string.agent_voice_minutes, left) else stringResource(R.string.agent_voice_used_up), chevron = false),
        summary.freeAgainMillis?.takeIf { left == 0 }?.let { back ->
            SettingsEntry(AgentVoiceTags.BACK, stringResource(R.string.agent_voice_back), icon = { SettingsTile(Ionicon.CalendarOutline, SettingsTiles.gray) }, detail = DateFormat.getDateTimeInstance(DateFormat.MEDIUM, DateFormat.SHORT).format(Date(back)), chevron = false)
        },
    )
    val selling = price != null || subscribed
    val subscription = listOf(
        when {
            subscribed -> SettingsEntry(AgentVoiceTags.SUBSCRIBE, stringResource(R.string.settings_support_us_subtitle_pro), icon = { SettingsTile(Ionicon.Heart, SettingsTiles.red) }, chevron = false, enabled = false)
            price != null -> SettingsEntry(AgentVoiceTags.SUBSCRIBE, stringResource(R.string.agent_voice_subscribe), icon = { SettingsTile(Ionicon.Heart, SettingsTiles.red) }, detail = stringResource(R.string.agent_voice_sheet_pledge, price), onClick = onSubscribe)
            else -> SettingsEntry(AgentVoiceTags.SUBSCRIBE, stringResource(R.string.agent_voice_subscribe), icon = { SettingsTile(Ionicon.Heart, SettingsTiles.red) }, detail = stringResource(R.string.agent_voice_not_yet), chevron = false, enabled = false)
        },
        if (selling) {
            SettingsEntry(AgentVoiceTags.RESTORE, stringResource(R.string.agent_voice_restore), icon = { SettingsTile(Ionicon.RefreshOutline, SettingsTiles.gray) }, chevron = false, onClick = onRestore)
        } else {
            SettingsEntry(AgentVoiceTags.RESTORE, stringResource(R.string.agent_voice_restore), icon = { SettingsTile(Ionicon.RefreshOutline, SettingsTiles.gray) }, detail = stringResource(R.string.agent_voice_restore_unavailable), chevron = false, enabled = false)
        },
    )
    return listOf(
        SettingsSection(allowance, footer = stringResource(R.string.agent_voice_about)),
        SettingsSection(subscription, footer = if (selling) null else stringResource(R.string.agent_voice_coming_footer)),
    )
}

/** An agent connection's Voice page: [agentVoiceSections] under the bar. */
@Composable
fun AgentVoiceScreen(summary: AgentVoiceSummary, onSubscribe: () -> Unit = {}, onRestore: () -> Unit = {}, onBack: () -> Unit) {
    val sections = agentVoiceSections(summary, onSubscribe, onRestore)
    AgentPage(stringResource(R.string.agent_voice_title), onBack) {
        for (section in sections) SettingsCard(section)
        Spacer(Modifier.height(16.dp))
    }
}

/** Support Happy's page, pushed from an agent connection's boba row and Support us' Subscribe (iOS's `SupportViewController`). */
@Serializable data object SupportRoute

/**
 * Support Happy's page (iOS's `SupportViewController`), pushed: over the
 * first screen's grain under the standard bar, clear over it, the boba
 * where voice's sheet has its mic, played once as the page appears and
 * again on a tap ([SceneAnimation]; never looped), a headline and what
 * sending boba is for and comes with (5 hours of voice a month). No voice
 * session. Then "Pledge <the store's price>/month" over Subscribe, which
 * is always there and greyed out, under "Pledges aren't open yet.", while
 * nothing is on sale; a thank-you once [offer] is [Offer.Subscribed]; and
 * under them Restore Purchases and Manage Subscriptions as quiet links in
 * the gradient's secondary ink. With animations removed the boba holds
 * still.
 */
@Composable
fun SupportScreen(
    offer: Offer,
    onBack: () -> Unit,
    onSubscribe: () -> Unit = {},
    onRestore: (suspend () -> RestoreResult)? = null,
    onManage: () -> Unit = {},
    unconfirmed: Boolean = false,
) {
    val dark = HappyTheme.colors.dark
    val text = if (dark) StartSpec.darkText else StartSpec.lightText
    val secondary = text.copy(alpha = StartSpec.SECONDARY_ALPHA)
    val scope = rememberCoroutineScope()
    var plays by rememberSaveable { mutableIntStateOf(1) }
    var preview by remember { mutableStateOf(false) }
    var restoring by remember { mutableStateOf(false) }
    var restored by remember { mutableStateOf<RestoreResult?>(null) }
    val price = offer.price
    val subscribed = offer == Offer.Subscribed
    Box(Modifier.fillMaxSize().testTag(AgentVoiceTags.PAGE)) {
        GrainGradient(palette = if (dark) StartSpec.darkPalette else StartSpec.lightPalette, modifier = Modifier.fillMaxSize())
        Column(
            Modifier
                .fillMaxSize()
                .windowInsetsPadding(WindowInsets.systemBars.union(WindowInsets.displayCutout))
                .verticalScroll(rememberScrollState())
                .padding(horizontal = 28.dp, vertical = 16.dp),
            horizontalAlignment = Alignment.CenterHorizontally,
        ) {
            // Under the bar.
            Spacer(Modifier.height(64.dp))
            Spacer(Modifier.weight(1f))
            Box(Modifier.testTag(AgentVoiceTags.PAGE_ART)) {
                SceneAnimation(R.raw.state_boba, plays, { plays = it + 1 }, size = CallSheetSpec.mic)
            }
            Spacer(Modifier.height(12.dp))
            Text(
                stringResource(R.string.agent_voice_sheet_title),
                style = StartGallerySpec.title,
                color = text,
                textAlign = TextAlign.Center,
                modifier = Modifier.widthIn(max = 440.dp).semantics { heading() },
            )
            Spacer(Modifier.height(12.dp))
            Text(stringResource(R.string.agent_voice_sheet_body), style = StartGallerySpec.body, color = secondary, textAlign = TextAlign.Center, modifier = Modifier.widthIn(max = 440.dp))
            Spacer(Modifier.weight(1f))
            Spacer(Modifier.height(32.dp))
            Column(Modifier.widthIn(max = 440.dp), horizontalAlignment = Alignment.CenterHorizontally) {
                if (subscribed) {
                    Text(stringResource(R.string.settings_support_us_subtitle_pro), style = CallSheetSpec.offer, color = text, textAlign = TextAlign.Center)
                } else {
                    when {
                        price != null -> Text(stringResource(R.string.agent_voice_sheet_pledge, price), style = CallSheetSpec.offer, color = text, textAlign = TextAlign.Center)
                        // A purchase waiting on RevenueCat says that instead.
                        !unconfirmed -> Text(stringResource(R.string.agent_voice_sheet_not_yet), style = CallSheetSpec.detail, color = secondary, textAlign = TextAlign.Center, modifier = Modifier.testTag(AgentVoiceTags.PAGE_NOT_YET))
                    }
                    Spacer(Modifier.height(if (price != null) 20.dp else 12.dp))
                    RoundButton(
                        title = stringResource(R.string.call_subscribe),
                        onClick = { if (offer is Offer.Preview) preview = true else onSubscribe() },
                        enabled = price != null,
                        modifier = Modifier.width(CallSheetSpec.button).testTag(AgentVoiceTags.SUBSCRIBE_BUTTON),
                    )
                }
                Spacer(Modifier.height(4.dp))
                Row(horizontalArrangement = Arrangement.Center, verticalAlignment = Alignment.CenterVertically) {
                    QuietLink(
                        stringResource(R.string.agent_voice_restore),
                        secondary,
                        enabled = onRestore != null && !subscribed && !restoring,
                        tag = AgentVoiceTags.PAGE_RESTORE,
                    ) {
                        val restore = onRestore ?: return@QuietLink
                        restoring = true
                        scope.launch { restored = restore().also { restoring = false } }
                    }
                    QuietLink(stringResource(R.string.settings_manage_subscriptions), secondary, enabled = true, tag = AgentVoiceTags.PAGE_MANAGE, onClick = onManage)
                }
                if (offer is Offer.Preview) {
                    Text(stringResource(R.string.call_preview_note), style = CallSheetSpec.note, color = secondary, textAlign = TextAlign.Center)
                }
                // Bought, and RevenueCat hasn't confirmed it: said, never granted.
                if (unconfirmed) {
                    Text(stringResource(R.string.call_purchase_unconfirmed), style = CallSheetSpec.note, color = if (dark) CallSheetSpec.darkWarning else CallSheetSpec.lightWarning, textAlign = TextAlign.Center)
                }
            }
        }
        // Clear: the gradient shows through the bar.
        Box(Modifier.windowInsetsPadding(WindowInsets.displayCutout.only(WindowInsetsSides.Horizontal))) {
            CompositionLocalProvider(LocalBarOnGlass provides true) {
                StackHeader(title = "", onBack = onBack, fullWidth = true)
            }
        }
    }
    restored?.let { RestoreAlert(it) { restored = null } }
    // Debug builds' test preview: what subscribing would say, said plainly as nothing.
    if (preview) {
        HappyAlert(
            Alert(
                title = stringResource(R.string.call_preview_title),
                message = stringResource(R.string.call_preview_message),
                buttons = listOf(AlertButton(stringResource(R.string.common_ok))),
            ),
            onDismiss = { preview = false },
        )
    }
}

/** A quiet text action on the gradient (Restore Purchases, Manage Subscriptions): 44 tall to touch, faded while it can't be used. */
@Composable
private fun QuietLink(title: String, ink: Color, enabled: Boolean, tag: String, onClick: () -> Unit) {
    Text(
        title,
        style = CallSheetSpec.detail,
        color = ink,
        textAlign = TextAlign.Center,
        modifier = Modifier
            .alpha(if (enabled) 1f else 0.4f)
            .clickable(enabled = enabled, role = Role.Button, onClick = onClick)
            .heightIn(min = 44.dp)
            .wrapContentHeight()
            .padding(horizontal = 12.dp, vertical = 10.dp)
            .testTag(tag),
    )
}
