package com.slopus.happy.analytics

import com.slopus.happy.model.settings.SettingsRepository
import kotlinx.coroutines.CoroutineDispatcher
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.FlowPreview
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.combine
import kotlinx.coroutines.flow.debounce
import kotlinx.coroutines.flow.mapLatest
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

/**
 * Whether a Happy account signed in here opted out of analytics, for
 * `Analytics.start`. [open] is the open account's setting as it is now, so
 * turning it off counts at once, before it is stored or synced. [optedOut]
 * reads each account in [ids] from its own database, so one not open counts
 * too, again once [changes] settle. Nothing comes until the first read (the
 * module takes that as not yet); a change while reading starts it again.
 * An account that can't be read counts as opted out.
 */
@OptIn(ExperimentalCoroutinesApi::class, FlowPreview::class)
fun accountsOptedOut(
    ids: Flow<List<String>>,
    open: Flow<Boolean>,
    changes: Flow<Long>,
    optedOut: (String) -> Boolean,
    io: CoroutineDispatcher = Dispatchers.IO,
): Flow<Boolean> = combine(ids, open, changes.debounce(500)) { ids, open, _ -> ids to open }
    .mapLatest { (ids, open) ->
        open || withContext(io) {
            ids.any { id ->
                try {
                    optedOut(id)
                } catch (_: Exception) {
                    true
                }
            }
        }
    }

/**
 * The Account screen's Analytics switch ([optOut] is it turned off). Off:
 * analytics goes off at once, before the setting reaches [accountsOptedOut],
 * then the setting is written. On: only once [allow]ed, so never while the
 * last install id can't be deleted; until then the setting stays off, even
 * after a restart. [notSaved] is told an opt-out that couldn't be written
 * (true) or a turning on that was refused (false), for the screen to say so
 * as Data and Storage's switch does.
 */
fun CoroutineScope.setAnalyticsOptOut(
    settings: SettingsRepository,
    optOut: Boolean,
    allow: suspend () -> Boolean = Analytics::allow,
    notSaved: (optOut: Boolean) -> Unit,
) {
    if (!optOut) {
        launch { if (allow()) settings.change { it.copy(analyticsOptOut = false) } else notSaved(false) }
        return
    }
    Analytics.revoke()
    val saved = settings.change { it.copy(analyticsOptOut = true) }
    launch { if (!saved.await()) notSaved(true) }
}
