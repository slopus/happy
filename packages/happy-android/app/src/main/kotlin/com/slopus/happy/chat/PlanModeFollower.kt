package com.slopus.happy.chat

import com.slopus.happy.sync.StoredMessages
import com.slopus.happy.sync.StoredSource

/**
 * storage.ts applyMessages' `shouldEnterPlanMode`: a batch of new messages
 * that ends inside plan mode (an EnterPlanMode with no ExitPlanMode after
 * it) switches the session's permission mode to plan, and sync.ts pushes the
 * switch to metadata. A history replay holds both calls and ends outside, so
 * it changes nothing.
 *
 * A page preloaded on touch waits for the chat to open (sync.ts
 * `activatePreloadedPlanMode`): then it switches, once, unless a later batch
 * left plan mode or the mode was changed since the preload.
 */
class PlanModeFollower(
    private val permissionMode: (sessionId: String) -> String? = { null },
    private val enterPlanMode: suspend (sessionId: String) -> Unit,
) {
    // Session id to its permission mode when the preloaded page arrived. Batches come from one collector.
    private val deferred = HashMap<String, String?>()

    suspend fun onStored(batch: StoredMessages) {
        val id = batch.sessionId
        when (batch.source) {
            StoredSource.OPENED -> {
                if (!deferred.containsKey(id)) return
                val before = deferred.remove(id)
                if (permissionMode(id) == before) enterPlanMode(id)
            }
            StoredSource.PRELOAD -> {
                if (planMode(batch) == true) deferred[id] = permissionMode(id)
            }
            StoredSource.SYNC -> when (planMode(batch)) {
                true -> enterPlanMode(id)
                false -> deferred.remove(id)
                null -> Unit
            }
        }
    }

    private fun planMode(batch: StoredMessages) = messagePlanMode(batch.messages.mapNotNull(ChatNormalizer::normalize))
}
