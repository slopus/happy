package com.slopus.happy.analytics

import kotlinx.coroutines.CoroutineDispatcher
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.FlowPreview
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.combine
import kotlinx.coroutines.flow.debounce
import kotlinx.coroutines.flow.mapLatest
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
