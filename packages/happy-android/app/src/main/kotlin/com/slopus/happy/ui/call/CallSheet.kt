package com.slopus.happy.ui.call

import android.app.Activity
import android.content.Context
import android.content.ContextWrapper
import android.text.format.DateFormat
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.interaction.collectIsPressedAsState
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.defaultMinSize
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.Text
import androidx.compose.material3.rememberModalBottomSheetState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.SideEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalView
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.window.DialogWindowProvider
import androidx.core.view.WindowCompat
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.role
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.LineBreak
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.airbnb.lottie.compose.LottieAnimation
import com.airbnb.lottie.compose.LottieCompositionSpec
import com.airbnb.lottie.compose.LottieConstants
import com.airbnb.lottie.compose.animateLottieCompositionAsState
import com.airbnb.lottie.compose.rememberLottieComposition
import com.slopus.happy.R
import com.slopus.happy.payments.Offer
import com.slopus.happy.payments.Offers
import com.slopus.happy.payments.RestoreResult
import com.slopus.happy.payments.OfferSheet
import com.slopus.happy.ui.connection.SupportSheet
import com.slopus.happy.ui.components.Alert
import com.slopus.happy.ui.components.AlertButton
import com.slopus.happy.ui.components.HappyAlert
import com.slopus.happy.ui.components.Icon
import com.slopus.happy.ui.components.Ionicon
import com.slopus.happy.ui.components.RoundButton
import com.slopus.happy.ui.components.RoundButtonSize
import com.slopus.happy.ui.components.rememberReduceMotion
import com.slopus.happy.ui.start.GrainGradient
import com.slopus.happy.ui.start.StartGallerySpec
import com.slopus.happy.ui.start.StartSpec
import com.slopus.happy.ui.theme.HappyTheme
import com.slopus.happy.ui.theme.happyTextStyle
import kotlinx.coroutines.launch
import java.text.SimpleDateFormat
import java.util.Calendar
import java.util.Date
import java.util.Locale

object CallSheetTags {
    const val WELCOME = "call-welcome"
    const val PAYWALL = "call-paywall"
    const val SUBSCRIBE = "call-sheet-subscribe"
    const val SESSION = "call-sheet-session"
    const val CLOSE = "call-sheet-close"
    const val RESTORE = "call-sheet-restore"
    const val WARNING = "call-sheet-warning"
}

/** iOS `CallSheetViewController`'s measures and styles. */
object CallSheetSpec {
    val mic = 120.dp
    val column = 440.dp
    val side = 28.dp
    val button = 300.dp
    val title = StartGallerySpec.title
    val row = happyTextStyle(fontSize = 17, lineHeight = 22, weight = FontWeight.SemiBold)
    val offer = happyTextStyle(fontSize = 20, lineHeight = 26, weight = FontWeight.SemiBold)
    val detail = happyTextStyle(fontSize = 15, lineHeight = 20)
    val note = happyTextStyle(fontSize = 13, lineHeight = 18)
    /** iOS `Palette.warningText`: the app's warning colour, on the gradient as on iOS. */
    val lightWarning = Color(0xFFFF9500)
    val darkWarning = Color(0xFFFFAB00)
}

/**
 * The app's one offer host ([Offers.sheet]), wherever the sheet was asked
 * for: voice's sheets ([CallSheet]) or Support us ([SupportSheet]), each
 * offering what is on offer now, bought and restored through [offers].
 */
@Composable
fun OfferHost(offers: Offers) {
    val sheet by offers.sheet.collectAsStateWithLifecycle()
    val offer by offers.offers.collectAsStateWithLifecycle()
    val unconfirmed by offers.unconfirmed.collectAsStateWithLifecycle()
    val activity = LocalContext.current.activity()
    val scope = rememberCoroutineScope()
    val onSubscribe = { activity?.let { activity -> scope.launch { offers.subscribe(activity) } }; Unit }
    when (val shown = sheet?.offering(offer)) {
        null -> Unit
        is OfferSheet.Support -> SupportSheet(shown.offer, onDismiss = offers::dismiss, onSubscribe = onSubscribe, onRestore = offers::restore, unconfirmed = unconfirmed)
        else -> CallSheet(shown, onStart = offers::start, onDismiss = offers::dismiss, onSubscribe = onSubscribe, onRestore = offers::restore, unconfirmed = unconfirmed)
    }
}

/**
 * Voice's full-height sheets (iOS `CallSheetViewController`), in the
 * first screen's style: its Grain Gradient behind, its words and pill on it.
 * The welcome a device sees before its first call, and the same screen once
 * its free time is used or the relay's voice needs the subscription, its
 * start greyed out. The podcast mic, a headline
 * and what voice does; at the bottom the subscription where one is on
 * offer, then "Start Voice Session". Closed by its ✕, back or a swipe down,
 * which starts nothing.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun CallSheet(
    sheet: OfferSheet,
    onStart: () -> Unit,
    onDismiss: () -> Unit,
    onSubscribe: () -> Unit = {},
    onRestore: (suspend () -> RestoreResult)? = null,
    unconfirmed: Boolean = false,
) {
    val dark = HappyTheme.colors.dark
    val ink = if (dark) StartSpec.darkText else StartSpec.lightText
    val palette = if (dark) StartSpec.darkPalette else StartSpec.lightPalette
    val state = rememberModalBottomSheetState(skipPartiallyExpanded = true)
    val scope = rememberCoroutineScope()
    val context = LocalContext.current
    val subscribed = sheet.offer == Offer.Subscribed
    val used = when (sheet) {
        is OfferSheet.Used -> if (subscribed) paidNote(sheet.freeAgain) else usedNote(context, sheet.freeAgain)
        is OfferSheet.Required -> if (subscribed) null else usedNote(context, null)
        else -> null
    }
    ModalBottomSheet(
        onDismissRequest = onDismiss,
        sheetState = state,
        shape = RoundedCornerShape(topStart = 28.dp, topEnd = 28.dp),
        containerColor = palette.back,
        dragHandle = null,
        contentWindowInsets = { WindowInsets(0) },
        modifier = Modifier.testTag(if (sheet is OfferSheet.Welcome) CallSheetTags.WELCOME else CallSheetTags.PAYWALL),
    ) {
        SheetIcons(dark)
        Box(Modifier.fillMaxSize()) {
            GrainGradient(palette, Modifier.matchParentSize())
            BoxWithConstraints(Modifier.fillMaxSize()) {
                val viewport = maxHeight
                Column(
                    Modifier.fillMaxWidth().verticalScroll(rememberScrollState()).heightIn(min = viewport)
                        .statusBarsPadding().navigationBarsPadding().padding(horizontal = CallSheetSpec.side).padding(bottom = 16.dp),
                    horizontalAlignment = Alignment.CenterHorizontally,
                ) {
                    // The mic, the headline and what voice does, in the middle of the space above the actions.
                    Spacer(Modifier.height(48.dp))
                    Spacer(Modifier.weight(1f))
                    Column(Modifier.widthIn(max = CallSheetSpec.column), horizontalAlignment = Alignment.CenterHorizontally) {
                        Mic()
                        Spacer(Modifier.height(12.dp))
                        Text(
                            stringResource(R.string.call_welcome_title),
                            style = CallSheetSpec.title.copy(lineBreak = LineBreak.Heading),
                            color = ink,
                            textAlign = TextAlign.Center,
                            modifier = Modifier.semantics { heading() },
                        )
                        Spacer(Modifier.height(28.dp))
                        Column(verticalArrangement = Arrangement.spacedBy(16.dp)) {
                            Benefit(Ionicon.ChatbubbleEllipsesOutline, stringResource(R.string.call_welcome_ask), ink)
                            Benefit(Ionicon.PaperPlaneOutline, stringResource(R.string.call_welcome_act), ink)
                            // Once the free time is used, that under its line, in the app's warning colour.
                            Benefit(
                                Ionicon.GiftOutline,
                                stringResource(if (subscribed) R.string.call_subscribe_allowance else R.string.call_welcome_free),
                                ink,
                                used,
                                if (dark) CallSheetSpec.darkWarning else CallSheetSpec.lightWarning,
                            )
                        }
                    }
                    Spacer(Modifier.weight(1f))
                    Spacer(Modifier.height(32.dp))
                    // The subscription, what it gives and what it is for, its button, then the free call under it.
                    Column(Modifier.widthIn(max = CallSheetSpec.column), horizontalAlignment = Alignment.CenterHorizontally) {
                        val offer = sheet.offer
                        OfferActions(
                            offer,
                            onSubscribe,
                            onRestore,
                            unconfirmed,
                            ink,
                            details = {
                                Text(stringResource(R.string.call_subscribe_allowance), style = CallSheetSpec.detail, color = ink, textAlign = TextAlign.Center)
                                Spacer(Modifier.height(6.dp))
                                Text(
                                    stringResource(R.string.call_subscribe_support),
                                    style = CallSheetSpec.detail.copy(lineBreak = LineBreak.Paragraph),
                                    color = ink.copy(alpha = StartSpec.SECONDARY_ALPHA),
                                    textAlign = TextAlign.Center,
                                )
                            },
                        ) {
                            SessionButton(
                                title = stringResource(R.string.call_start_session),
                                prominent = !offer.onSale,
                                enabled = sheet is OfferSheet.Welcome,
                                ink = ink,
                                onClick = {
                                    // The free call, once the sheet has gone.
                                    scope.launch { state.hide() }.invokeOnCompletion { onStart() }
                                },
                                modifier = Modifier.width(CallSheetSpec.button).testTag(CallSheetTags.SESSION),
                            )
                        }
                    }
                }
            }
            Close(ink, Modifier.align(Alignment.TopEnd).statusBarsPadding().padding(10.dp)) {
                scope.launch { state.hide() }.invokeOnCompletion { onDismiss() }
            }
        }
    }
}

/**
 * What every offer sheet ends with: the subscription at the store's price
 * ([details] under it, what it gives), its Subscribe, then [content] (voice's
 * "Start Voice Session"), "Restore Purchases" wherever it could have been
 * bought, and the notes: the debug preview's, and a purchase RevenueCat
 * hasn't confirmed yet. With nothing on sale, only [content] and the notes.
 */
@Composable
internal fun OfferActions(
    offer: Offer,
    onSubscribe: () -> Unit,
    onRestore: (suspend () -> RestoreResult)?,
    unconfirmed: Boolean,
    ink: Color,
    details: @Composable () -> Unit = {},
    content: @Composable () -> Unit = {},
) {
    val dark = HappyTheme.colors.dark
    val scope = rememberCoroutineScope()
    var preview by remember { mutableStateOf(false) }
    var restoring by remember { mutableStateOf(false) }
    var restored by remember { mutableStateOf<RestoreResult?>(null) }
    val price = offer.price
    if (price != null) {
        Text(stringResource(R.string.call_support_for, price), style = CallSheetSpec.offer, color = ink, textAlign = TextAlign.Center)
        Spacer(Modifier.height(2.dp))
        details()
        Spacer(Modifier.height(20.dp))
        RoundButton(
            title = stringResource(R.string.call_subscribe),
            onClick = { if (offer is Offer.Preview) preview = true else onSubscribe() },
            modifier = Modifier.width(CallSheetSpec.button).testTag(CallSheetTags.SUBSCRIBE),
        )
        Spacer(Modifier.height(12.dp))
    }
    content()
    // Restore, wherever the subscription could be bought: a reinstall, another phone.
    if (price != null && onRestore != null) {
        Spacer(Modifier.height(4.dp))
        Text(
            stringResource(R.string.call_restore),
            style = CallSheetSpec.note,
            color = ink.copy(alpha = StartSpec.SECONDARY_ALPHA),
            modifier = Modifier
                .alpha(if (restoring) 0.4f else 1f)
                .clickable(enabled = !restoring, role = Role.Button) {
                    restoring = true
                    scope.launch { restored = onRestore().also { restoring = false } }
                }
                .padding(horizontal = 12.dp, vertical = 12.dp)
                .testTag(CallSheetTags.RESTORE),
        )
    }
    if (offer is Offer.Preview) {
        Spacer(Modifier.height(12.dp))
        Text(stringResource(R.string.call_preview_note), style = CallSheetSpec.note, color = ink.copy(alpha = StartSpec.SECONDARY_ALPHA), textAlign = TextAlign.Center)
    }
    // Bought, and RevenueCat hasn't confirmed it: said, never granted.
    if (unconfirmed) {
        Spacer(Modifier.height(12.dp))
        Text(
            stringResource(R.string.call_purchase_unconfirmed),
            style = CallSheetSpec.note,
            color = if (dark) CallSheetSpec.darkWarning else CallSheetSpec.lightWarning,
            textAlign = TextAlign.Center,
        )
    }
    restored?.let { outcome ->
        HappyAlert(
            Alert(
                title = stringResource(R.string.call_restore),
                message = stringResource(
                    when (outcome) {
                        RestoreResult.Restored -> R.string.call_restore_done
                        RestoreResult.NothingFound -> R.string.call_restore_none
                        RestoreResult.Failed -> R.string.call_restore_failed
                    },
                ),
                buttons = listOf(AlertButton(stringResource(R.string.common_ok))),
            ),
            onDismiss = { restored = null },
        )
    }
    // Debug builds' test preview: what subscribing would say, said plainly as nothing. No product, charge, grant or change to the free time.
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

/** The podcast mic, looping; still mid-way with animations removed. */
@Composable
private fun Mic() {
    val reduceMotion = rememberReduceMotion()
    val composition by rememberLottieComposition(LottieCompositionSpec.RawRes(R.raw.call_podcast_mic))
    val progress by animateLottieCompositionAsState(composition, iterations = LottieConstants.IterateForever, isPlaying = !reduceMotion)
    Box(Modifier.size(CallSheetSpec.mic).clearAndSetSemantics {}) {
        if (composition != null) LottieAnimation(composition, { if (reduceMotion) 0.5f else progress }, Modifier.fillMaxSize())
    }
}

/** One thing voice does: its glyph and a few words, and a warning under them if there is one. */
@Composable
private fun Benefit(icon: Ionicon, title: String, ink: Color, warning: String? = null, warningColor: Color = ink) {
    Row(Modifier.semantics(mergeDescendants = true) {}) {
        Box(Modifier.width(28.dp).height(22.dp), contentAlignment = Alignment.Center) {
            Icon(icon = icon, size = 20.dp, color = ink, contentDescription = null)
        }
        Spacer(Modifier.width(14.dp))
        Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
            Text(title, style = CallSheetSpec.row, color = ink)
            warning?.let { Text(it, style = CallSheetSpec.detail, color = warningColor, modifier = Modifier.testTag(CallSheetTags.WARNING)) }
        }
    }
}

/**
 * "Start Voice Session" with the voice button's bars after it (iOS
 * `SessionButton`): the splash's pill when it is the main action, a quiet
 * one under the subscription otherwise; faded once the free time is used.
 */
@Composable
private fun SessionButton(title: String, prominent: Boolean, enabled: Boolean, ink: Color, onClick: () -> Unit, modifier: Modifier = Modifier) {
    val colors = HappyTheme.colors
    val interaction = remember { MutableInteractionSource() }
    val pressed by interaction.collectIsPressedAsState()
    val fill = if (prominent) (if (colors.dark) Color(0xFFF5F5F5) else colors.button.primaryBackground) else ink.copy(alpha = 0.1f)
    val text = if (prominent) (if (colors.dark) Color(0xFF111111) else colors.button.primaryTint) else ink
    Box(
        modifier
            .alpha(if (enabled) 1f else 0.4f)
            .defaultMinSize(minHeight = RoundButtonSize.Large.height)
            .clip(RoundedCornerShape(percent = 50))
            .background(fill.copy(alpha = fill.alpha * if (pressed) 0.7f else 1f))
            .clickable(interaction, indication = null, enabled = enabled, role = Role.Button, onClick = onClick)
            .padding(horizontal = 24.dp, vertical = 12.dp),
        contentAlignment = Alignment.Center,
    ) {
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            Text(
                title,
                style = happyTextStyle(fontSize = RoundButtonSize.Large.fontSize, lineHeight = RoundButtonSize.Large.lineHeight, weight = FontWeight.SemiBold),
                color = text,
                textAlign = TextAlign.Center,
                modifier = Modifier.weight(1f, fill = false),
            )
            VoiceGlyph(20.dp, text)
        }
    }
}

/** The sheet is under the status and navigation bars, so their icons are the sheet's, whatever the system's theme. */
@Composable
private fun SheetIcons(dark: Boolean) {
    val window = (LocalView.current.parent as? DialogWindowProvider)?.window ?: return
    SideEffect {
        WindowCompat.getInsetsController(window, window.decorView).run {
            isAppearanceLightStatusBars = !dark
            isAppearanceLightNavigationBars = !dark
        }
    }
}

/** The ✕: 44 to touch, its circle drawn inside. */
@Composable
private fun Close(ink: Color, modifier: Modifier, onClick: () -> Unit) {
    val label = stringResource(R.string.call_close)
    Box(
        modifier
            .size(44.dp)
            .clickable(remember { MutableInteractionSource() }, indication = null, role = Role.Button, onClick = onClick)
            .semantics { contentDescription = label; role = Role.Button }
            .testTag(CallSheetTags.CLOSE),
        contentAlignment = Alignment.Center,
    ) {
        Box(Modifier.size(32.dp).clip(CircleShape).background(ink.copy(alpha = 0.1f)), contentAlignment = Alignment.Center) {
            Icon(icon = Ionicon.Close, size = 18.dp, color = ink, contentDescription = null)
        }
    }
}

/**
 * The used-up line: when free time is back, as a sentence ends it ("at
 * 5:19 PM" today, "on Thu at 5:19 PM" this week, "on Dec 3" after; iOS
 * `CallSheetViewController.when`), or that it comes back as calls age.
 */
@Composable
private fun usedNote(context: Context, freeAgain: Long?): String {
    if (freeAgain == null) return stringResource(R.string.call_used_later)
    val date = Date(freeAgain)
    val time = DateFormat.getTimeFormat(context).format(date)
    val days = CallSheetDays.between(System.currentTimeMillis(), freeAgain)
    return when {
        days == 0 -> stringResource(R.string.call_used_today, time)
        days < 7 -> stringResource(R.string.call_used_week, SimpleDateFormat("EEE", Locale.getDefault()).format(date), time)
        else -> stringResource(R.string.call_used_date, DateFormat.format(DateFormat.getBestDateTimePattern(Locale.getDefault(), "MMMd"), date).toString())
    }
}

/** The subscriber's used-up line: this month's hours are used, and when the next month's begin. */
@Composable
private fun paidNote(next: Long?): String {
    val date = next?.let { DateFormat.format(DateFormat.getBestDateTimePattern(Locale.getDefault(), "MMMd"), Date(it)).toString() }
    return if (date != null) stringResource(R.string.call_paid_used, date) else stringResource(R.string.call_paid_used_later)
}

internal tailrec fun Context.activity(): Activity? = when (this) {
    is Activity -> this
    is ContextWrapper -> baseContext.activity()
    else -> null
}

/** Calendar days from [from] to [to] on the phone's clock. */
internal object CallSheetDays {
    fun between(from: Long, to: Long): Int {
        fun day(millis: Long) = Calendar.getInstance().apply {
            timeInMillis = millis
            set(Calendar.HOUR_OF_DAY, 0); set(Calendar.MINUTE, 0); set(Calendar.SECOND, 0); set(Calendar.MILLISECOND, 0)
        }.timeInMillis
        return Math.round((day(to) - day(from)) / 86_400_000.0).toInt()
    }
}
