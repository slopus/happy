package com.slopus.happy.ui.home

import android.content.Context
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import com.slopus.happy.model.HomeEmptyState
import com.slopus.happy.model.SessionListGrouping
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith

/**
 * utils/requestReview.ts:
 * - Nothing without the Play Store.
 * - Never answered: "Enjoying the app?" (Yes, I love it! / Not really); the
 *   answer goes to the synced settings. Yes opens the store review and
 *   stamps it; Not really stamps the decline and opens nothing.
 * - Liked: the store review again once 7 days have passed since the last.
 * - Answered without liking it, here or on another device: never again.
 * - A local decline holds the ask back 30 days.
 * - SessionsList.tsx asks once its list has sessions; a phone grouped by
 *   project (ProjectHomeList) never does, the tablet sidebar always can.
 * - The stamps go with the account on logout (the default MMKV upstream).
 */
@RunWith(AndroidJUnit4::class)
class ReviewPromptTest {
    private class Stamps(override var storeReviewShownAt: Long? = null, override var declinedAt: Long? = null) : ReviewStamps

    private val day = 24L * 60 * 60 * 1000
    private var now = 100 * day
    private var answered = false
    private var liked: Boolean? = null
    private val stamps = Stamps()
    private val prompter = ReviewPrompter(
        answered = { answered to liked },
        answer = { answered = true; liked = it },
        stamps = stamps,
        now = { now },
    )
    private var asks = 0
    private var reviews = 0

    private suspend fun run(likes: Boolean = true, available: Boolean = true) = prompter.run(
        isAvailable = { available },
        ask = { asks++; likes },
        review = { reviews++ },
    )

    @Test
    fun nothingWithoutThePlayStore() = runTest {
        run(available = false)
        assertEquals(0, asks)
        assertEquals(0, reviews)
    }

    @Test
    fun aYesIsStoredAndOpensTheStoreReview() = runTest {
        run(likes = true)
        assertEquals(1, asks)
        assertTrue(answered)
        assertEquals(true, liked)
        assertEquals(1, reviews)
        assertEquals(now, stamps.storeReviewShownAt)

        // Within the week: nothing, and no second ask.
        now += 6 * day
        run()
        assertEquals(1, asks)
        assertEquals(1, reviews)

        // A week on: the store review alone.
        now += day
        run()
        assertEquals(1, asks)
        assertEquals(2, reviews)
    }

    @Test
    fun aNoIsStoredAndNeverAskedAgain() = runTest {
        run(likes = false)
        assertEquals(1, asks)
        assertEquals(false, liked)
        assertEquals(0, reviews)
        assertEquals(now, stamps.declinedAt)
        assertNull(stamps.storeReviewShownAt)

        now += 40 * day
        run()
        assertEquals("the answer, synced, wins over the 30 days", 1, asks)
    }

    @Test
    fun aLocalDeclineHoldsTheAskBack30Days() {
        val declined = Stamps(declinedAt = now)
        assertEquals(ReviewStep.Nothing, resolveReviewStep(answered = false, liked = null, stamps = declined, now = now + 29 * day))
        assertEquals(ReviewStep.Ask, resolveReviewStep(answered = false, liked = null, stamps = declined, now = now + 30 * day))
        assertEquals(ReviewStep.Ask, resolveReviewStep(answered = false, liked = null, stamps = Stamps(), now = now))
        assertEquals(ReviewStep.StoreReview, resolveReviewStep(answered = true, liked = true, stamps = Stamps(), now = now))
        assertEquals(ReviewStep.Nothing, resolveReviewStep(answered = true, liked = null, stamps = Stamps(), now = now))
    }

    @Test
    fun aFailedStoreReviewIsSwallowed() = runTest {
        prompter.run(isAvailable = { true }, ask = { true }, review = { error("no Play services") })
        assertTrue(answered)
        assertNull("the stamp follows a shown review only", stamps.storeReviewShownAt)
    }

    @Test
    fun theListAsksOnceItHasSessions() {
        fun state(grouping: SessionListGrouping, rows: Boolean, empty: HomeEmptyState = HomeEmptyState.List) = HomeListState(
            emptyState = empty,
            grouping = grouping,
            hasArchivedSessions = false,
            archiveHidden = true,
            rows = if (rows) listOf(HomeRow.ArchiveToggle(hidden = true, banded = false)) else emptyList(),
            offlineBanner = null,
        )
        assertFalse(asksForReview(null, phone = true))
        assertTrue(asksForReview(state(SessionListGrouping.Flat, rows = true), phone = true))
        assertFalse(asksForReview(state(SessionListGrouping.Flat, rows = false), phone = true))
        assertFalse(asksForReview(state(SessionListGrouping.Flat, rows = true, empty = HomeEmptyState.NoSessions), phone = true))
        assertFalse("ProjectHomeList never asks", asksForReview(state(SessionListGrouping.Project, rows = true), phone = true))
        assertTrue("the sidebar is SessionsList", asksForReview(state(SessionListGrouping.Project, rows = true), phone = false))
    }

    @Test
    fun theStampsArePreferences() {
        val context = ApplicationProvider.getApplicationContext<Context>()
        val prefs = context.getSharedPreferences(PrefsReviewStamps.PREFS_NAME, Context.MODE_PRIVATE)
        val stored = PrefsReviewStamps(prefs)
        assertNull(stored.declinedAt)
        stored.declinedAt = 42
        stored.storeReviewShownAt = 7
        assertEquals(42L, PrefsReviewStamps(prefs).declinedAt)
        assertEquals(7L, PrefsReviewStamps(prefs).storeReviewShownAt)
        stored.declinedAt = null
        assertNull(PrefsReviewStamps(prefs).declinedAt)
    }
}
