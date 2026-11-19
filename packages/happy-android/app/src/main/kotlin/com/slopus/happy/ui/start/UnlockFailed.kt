package com.slopus.happy.ui.start

import androidx.activity.compose.ReportDrawn
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.displayCutout
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.systemBars
import androidx.compose.foundation.layout.union
import androidx.compose.foundation.layout.windowInsetsPadding
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.stringResource
import com.slopus.happy.R
import com.slopus.happy.ui.components.Ionicon
import com.slopus.happy.ui.components.StatePage
import com.slopus.happy.ui.theme.HappyTheme

object UnlockFailedTags {
    const val PAGE = "unlockFailed.page"
}

/**
 * The open Happy account (or the React Native app's, on the first start
 * after the upgrade) is on the phone but its credentials can't be read
 * (`AppGraph.locked`): in the first screen's place, which would look like
 * being signed out. A [StatePage] on the surface inside the
 * bars: lock, title, line, Retry ([onRetry] reads again), and Use another
 * account ([onOther], the first screen's next one), which leaves the
 * unreadable item as it is.
 */
@Composable
fun UnlockFailed(onRetry: () -> Unit, onOther: () -> Unit) {
    ReportDrawn()
    Box(Modifier.fillMaxSize().background(HappyTheme.colors.surface).windowInsetsPadding(WindowInsets.systemBars.union(WindowInsets.displayCutout))) {
        StatePage(
            title = stringResource(R.string.account_unlock_failed_title),
            body = stringResource(R.string.account_unlock_failed_body),
            icon = Ionicon.LockClosedOutline,
            action = stringResource(R.string.common_retry) to onRetry,
            secondary = stringResource(R.string.account_unlock_failed_other) to onOther,
            tag = UnlockFailedTags.PAGE,
        )
    }
}
