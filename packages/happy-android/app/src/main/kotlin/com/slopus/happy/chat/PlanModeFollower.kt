package com.slopus.happy.chat

import com.slopus.happy.sync.StoredMessages

/**
 * storage.ts applyMessages' `shouldEnterPlanMode`: a batch of new messages
 * that ends inside plan mode (an EnterPlanMode with no ExitPlanMode after
 * it) switches the session's permission mode to plan, and sync.ts pushes the
 * switch to metadata. A history replay holds both calls and ends outside, so
 * it changes nothing.
 *
 * happy-app's preloaded variant (sync.ts `activatePreloadedPlanMode`) has no
 * counterpart: nothing here fetches a chat's messages before it is opened.
 */
class PlanModeFollower(private val enterPlanMode: suspend (sessionId: String) -> Unit) {
    suspend fun onStored(batch: StoredMessages) {
        val normalized = batch.messages.mapNotNull(ChatNormalizer::normalize)
        if (messagePlanMode(normalized) == true) enterPlanMode(batch.sessionId)
    }
}
