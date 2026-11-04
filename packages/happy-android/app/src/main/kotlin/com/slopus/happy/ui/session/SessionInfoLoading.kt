package com.slopus.happy.ui.session

import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.stringResource
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.compose.LocalLifecycleOwner
import androidx.lifecycle.repeatOnLifecycle
import com.slopus.happy.R
import com.slopus.happy.model.ProjectAvatar
import com.slopus.happy.model.Session
import com.slopus.happy.ui.components.Ionicon
import com.slopus.happy.ui.components.Item
import com.slopus.happy.ui.components.ItemGroup
import com.slopus.happy.ui.components.ItemList
import com.slopus.happy.ui.settings.SettingsTile
import com.slopus.happy.ui.settings.SettingsTiles
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch

private enum class DetailsLoading { Waiting, Delayed }

/**
 * iOS b062d5879: the seeded profile stays above a normal details card.
 * Its status row uses Item's 56 dp minimum and 16 dp inset; the 32 dp
 * refresh tile appears with Retry after five seconds while resumed.
 * Leaving the page cancels the watchdog and any outstanding retry.
 */
@Composable
internal fun SessionInfoLoading(session: Session?, avatar: ProjectAvatar?, controls: SessionInfoControls) {
    val lifecycle = LocalLifecycleOwner.current.lifecycle
    val scope = rememberCoroutineScope()
    var attempt by remember { mutableIntStateOf(0) }
    var state by remember(attempt) { mutableStateOf(DetailsLoading.Waiting) }
    var retry by remember { mutableStateOf<Job?>(null) }
    LaunchedEffect(lifecycle, attempt) {
        lifecycle.repeatOnLifecycle(Lifecycle.State.RESUMED) {
            state = DetailsLoading.Waiting
            delay(5_000)
            state = DetailsLoading.Delayed
        }
    }
    ItemList {
        session?.let { SessionInfoHeader(it, avatar ?: it.avatar) }
        ItemGroup {
            Item(
                title = stringResource(if (state == DetailsLoading.Waiting) R.string.common_loading else R.string.session_info_loading_delayed),
                modifier = Modifier.testTag(SessionInfoTags.LOADING),
            )
            if (state == DetailsLoading.Delayed) {
                Item(
                    title = stringResource(R.string.common_retry),
                    icon = { SettingsTile(Ionicon.RefreshOutline, SettingsTiles.blue) },
                    showChevron = false,
                    onClick = {
                        attempt++
                        retry?.cancel()
                        retry = scope.launch { controls.retryLoad() }
                    },
                    modifier = Modifier.testTag(SessionInfoTags.RETRY),
                )
            }
        }
    }
}