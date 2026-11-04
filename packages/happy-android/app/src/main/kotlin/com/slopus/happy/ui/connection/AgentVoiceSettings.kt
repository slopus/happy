package com.slopus.happy.ui.connection

import android.content.Context
import androidx.compose.foundation.ExperimentalFoundationApi
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.displayCutout
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.systemBars
import androidx.compose.foundation.layout.union
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.layout.windowInsetsPadding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.runtime.getValue
import androidx.compose.ui.draw.clip
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.window.DialogProperties
import com.airbnb.lottie.compose.LottieAnimation
import com.airbnb.lottie.compose.LottieCompositionSpec
import com.airbnb.lottie.compose.LottieConstants
import com.airbnb.lottie.compose.animateLottieCompositionAsState
import com.airbnb.lottie.compose.rememberLottieComposition
import com.slopus.happy.ui.components.PageDialog
import com.slopus.happy.ui.components.rememberReduceMotion
import com.slopus.happy.ui.start.GrainGradient
import com.slopus.happy.ui.start.StartGallerySpec
import com.slopus.happy.ui.start.StartSpec
import com.slopus.happy.ui.theme.happyTextStyle
import com.slopus.happy.payments.Offer
import com.slopus.happy.payments.Offers
import com.slopus.happy.payments.ProMonth
import com.slopus.happy.payments.Subscription
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.slopus.happy.payments.OfferSheet
import com.slopus.happy.payments.RestoreResult
import com.slopus.happy.ui.call.OfferActions
import androidx.compose.foundation.combinedClickable
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.defaultMinSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.material3.Text
import androidx.compose.material3.ripple
import androidx.compose.runtime.Composable
import androidx.compose.runtime.Immutable
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.dp
import com.slopus.happy.R
import com.slopus.happy.call.CallAllowance
import com.slopus.happy.call.PreferencesCallUsageStore
import com.slopus.happy.ui.components.Icon
import com.slopus.happy.ui.components.Ionicon
import com.slopus.happy.ui.components.ItemGroup
import com.slopus.happy.ui.components.ItemSpec
import com.slopus.happy.ui.components.SceneAnimation
import com.slopus.happy.ui.components.revealRow
import com.slopus.happy.ui.settings.SettingsCard
import com.slopus.happy.ui.settings.SettingsEntry
import com.slopus.happy.ui.settings.SettingsSection
import com.slopus.happy.ui.settings.SettingsTile
import com.slopus.happy.ui.settings.SettingsTiles
import com.slopus.happy.ui.theme.HappyTheme
import kotlinx.serialization.Serializable
import java.text.DateFormat
import java.util.Date

/** An agent connection's Voice page (iOS's `AgentVoiceViewController`); [reveal] as on settings. */
@Serializable data class AgentVoiceRoute(val connectionId: String, val reveal: String? = null)

object AgentVoiceTags {
    const val SUPPORT = "agentVoice.support"
    const val ROW = "agentVoice.row"
    const val PLAN = "agentVoice.plan"
    const val FREE = "agentVoice.free"
    const val LEFT = "agentVoice.left"
    const val BACK = "agentVoice.back"
    const val SUBSCRIBE = "agentVoice.subscribe"
    const val RESTORE = "agentVoice.restore"
    const val SHEET = "agentVoice.supportSheet"
    const val SHEET_CLOSE = "agentVoice.supportSheet.close"
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

/** The boba's square and the row's insets: 16 from the card's edge, top and bottom, as a tile is from its edge, so the row is two rows tall. */
object SupportBobaSpec {
    val art = 80.dp
    val inset = 16.dp
    val gap = 14.dp
    val minHeight = ItemSpec.minHeight * 2
}

/**
 * Support Happy, under Profile (iOS's `supportRow`): the boba at its one
 * size leading a row two rows tall, the words beside it wrapping at the
 * person's font size, then a chevron. The boba stays still here, the pose
 * it was drawn to rest in; it moves only in [SupportSheet], which the row
 * opens. TalkBack reads it as one button.
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
                .defaultMinSize(minHeight = SupportBobaSpec.minHeight)
                .padding(SupportBobaSpec.inset),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            // Never asked to play: the held last frame.
            SceneAnimation(R.raw.state_boba, requested = 0, onReplay = null, size = SupportBobaSpec.art)
            Spacer(Modifier.width(SupportBobaSpec.gap))
            Column(Modifier.weight(1f), verticalArrangement = Arrangement.Center) {
                Text(stringResource(R.string.agent_voice_support_title), style = ItemSpec.title, color = colors.text)
            }
            Icon(icon = Ionicon.ChevronForward, size = ItemSpec.chevronSize, color = colors.grouped.chevron, modifier = Modifier.padding(start = ItemSpec.rightSectionGap))
        }
    }
}

/** Support Happy as search finds it: it opens [SupportSheet]. */
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

/**
 * Support us, the app's offer sheet opened from Settings
 * ([OfferSheet.Support]; iOS's `SupportSheetViewController`): over the first
 * screen's grain, the boba playing where voice's sheet has its mic, a
 * headline and what sending boba is for and comes with (5 hours of voice
 * a month). No voice session. Then "Pledge <the store's price>/month" with
 * Subscribe and Restore ([OfferActions]); a thank-you once [offer] is
 * [Offer.Subscribed]; that pledges aren't open when nothing is on sale. With animations removed the boba holds still. Closed
 * by its ✕ or back.
 */
@Composable
fun SupportSheet(
    offer: Offer,
    onDismiss: () -> Unit,
    onSubscribe: () -> Unit = {},
    onRestore: (suspend () -> RestoreResult)? = null,
    unconfirmed: Boolean = false,
) {
    PageDialog(onDismiss, DialogProperties(usePlatformDefaultWidth = false, decorFitsSystemWindows = false)) {
        val dark = HappyTheme.colors.dark
        val text = if (dark) StartSpec.darkText else StartSpec.lightText
        val secondary = text.copy(alpha = StartSpec.SECONDARY_ALPHA)
        val reduceMotion = rememberReduceMotion()
        val closeLabel = stringResource(R.string.call_close)
        val composition by rememberLottieComposition(LottieCompositionSpec.RawRes(R.raw.state_boba))
        val progress by animateLottieCompositionAsState(composition, iterations = LottieConstants.IterateForever, isPlaying = !reduceMotion)
        Box(Modifier.fillMaxSize().testTag(AgentVoiceTags.SHEET)) {
            GrainGradient(palette = if (dark) StartSpec.darkPalette else StartSpec.lightPalette, modifier = Modifier.fillMaxSize())
            Column(
                Modifier
                    .fillMaxSize()
                    .windowInsetsPadding(WindowInsets.systemBars.union(WindowInsets.displayCutout))
                    .verticalScroll(rememberScrollState())
                    .padding(horizontal = 28.dp, vertical = 16.dp),
                horizontalAlignment = Alignment.CenterHorizontally,
            ) {
                Spacer(Modifier.weight(1f))
                Box(Modifier.size(120.dp)) {
                    if (composition != null) LottieAnimation(composition, { if (reduceMotion) 1f else progress }, Modifier.fillMaxSize())
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
                    OfferActions(offer, onSubscribe, onRestore, unconfirmed, text, headline = { stringResource(R.string.agent_voice_sheet_pledge, it) }) {
                        when {
                            offer == Offer.Subscribed -> Text(stringResource(R.string.settings_support_us_subtitle_pro), style = StartGallerySpec.body, color = text, textAlign = TextAlign.Center)
                            offer.price == null -> Text(stringResource(R.string.agent_voice_sheet_not_yet), style = happyTextStyle(fontSize = 13, lineHeight = 18), color = secondary, textAlign = TextAlign.Center)
                        }
                    }
                }
            }
            Box(
                Modifier
                    .align(Alignment.TopEnd)
                    .windowInsetsPadding(WindowInsets.systemBars.union(WindowInsets.displayCutout))
                    .padding(10.dp)
                    .size(44.dp)
                    .clip(CircleShape)
                    .clickable(role = Role.Button, onClick = onDismiss)
                    .semantics { contentDescription = closeLabel }
                    .testTag(AgentVoiceTags.SHEET_CLOSE),
                contentAlignment = Alignment.Center,
            ) {
                Box(Modifier.size(32.dp).clip(CircleShape).background(text.copy(alpha = 0.1f)), contentAlignment = Alignment.Center) {
                    Icon(icon = Ionicon.Close, size = 18.dp, color = text)
                }
            }
        }
    }
}
