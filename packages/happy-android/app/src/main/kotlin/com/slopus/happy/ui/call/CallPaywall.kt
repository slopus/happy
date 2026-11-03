package com.slopus.happy.ui.call

import android.content.Context
import android.text.format.DateFormat
import android.text.format.DateUtils
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.Text
import androidx.compose.material3.rememberModalBottomSheetState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.slopus.happy.R
import com.slopus.happy.call.CallController
import com.slopus.happy.call.CallOffer
import com.slopus.happy.ui.components.Ionicon
import com.slopus.happy.ui.components.Item
import com.slopus.happy.ui.components.ItemGroup
import com.slopus.happy.ui.settings.ItemIcon
import com.slopus.happy.ui.settings.SettingsSpec
import com.slopus.happy.ui.settings.SettingsTiles
import com.slopus.happy.ui.theme.HappyTheme
import com.slopus.happy.ui.theme.happyTextStyle
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

object CallPaywallTags {
    const val SHEET = "call-paywall"
    const val OFFER = "call-paywall-offer"
}

/** [calls]' voice paywall while it is up ([CallController.paywall]), with what it can offer today. */
@Composable
fun CallPaywall(calls: CallController) {
    val shown by calls.paywall.collectAsStateWithLifecycle()
    if (shown) CallPaywall(freeAgain = remember { calls.freeAgain() }, offer = CallOffer.Unavailable, onDismiss = calls::dismissPaywall)
}

/**
 * The voice paywall (iOS `CallPaywallViewController`): shown once a
 * device's free voice time is used, as a sheet of the app's own grouped
 * rows. It says when free time comes back ([freeAgain], wall-clock millis)
 * and what can be bought, which today is nothing ([CallOffer.Unavailable]):
 * no price, no button that pretends.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun CallPaywall(freeAgain: Long?, offer: CallOffer, onDismiss: () -> Unit) {
    val colors = HappyTheme.colors
    val context = LocalContext.current
    ModalBottomSheet(
        onDismissRequest = onDismiss,
        sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true),
        containerColor = colors.grouped.background,
        modifier = Modifier.testTag(CallPaywallTags.SHEET),
    ) {
        SheetStatusIcons()
        Column(Modifier.fillMaxWidth().verticalScroll(rememberScrollState()).navigationBarsPadding().padding(bottom = 16.dp)) {
            Text(
                stringResource(R.string.call_paywall_title),
                style = happyTextStyle(fontSize = 17, lineHeight = 22, weight = FontWeight.SemiBold),
                color = colors.text,
                modifier = Modifier.padding(horizontal = 20.dp).padding(bottom = 4.dp),
            )
            ItemGroup(footer = stringResource(R.string.call_paywall_footer)) {
                Item(
                    title = stringResource(R.string.call_paywall_used),
                    subtitle = freeAgain?.let { stringResource(R.string.call_paywall_free, dayTime(context, it)) },
                    icon = { ItemIcon(Ionicon.MicOutline, SettingsTiles.purple) },
                    showChevron = false,
                )
            }
            when (offer) {
                CallOffer.Unavailable -> ItemGroup(footer = stringResource(R.string.call_paywall_unavailable_footer)) {
                    Item(
                        title = stringResource(R.string.call_paywall_more),
                        detail = stringResource(R.string.call_paywall_unavailable),
                        icon = { ItemIcon(Ionicon.SparklesOutline, SettingsSpec.blue) },
                        showChevron = false,
                        modifier = Modifier.testTag(CallPaywallTags.OFFER),
                    )
                }
            }
        }
    }
}

/** A time today as the phone's clock writes it; another day's with its weekday first (iOS `Strings.dayTime`). */
private fun dayTime(context: Context, millis: Long): String {
    val time = DateFormat.getTimeFormat(context).format(Date(millis))
    if (DateUtils.isToday(millis)) return time
    return "${SimpleDateFormat("EEE", Locale.getDefault()).format(Date(millis))} $time"
}
