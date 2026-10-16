package com.slopus.happy.ui.home

import android.app.Activity
import android.content.Context
import android.content.ContextWrapper
import android.content.SharedPreferences
import android.content.pm.PackageManager
import android.util.Log
import androidx.core.content.edit
import com.google.android.gms.tasks.Task
import com.google.android.play.core.review.ReviewManagerFactory
import com.slopus.happy.model.SessionListGrouping
import com.slopus.happy.model.HomeEmptyState
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlin.coroutines.resume
import kotlin.coroutines.resumeWithException

/** requestReview.ts's local stamps (MMKV), in milliseconds; null when never set. */
interface ReviewStamps {
    var storeReviewShownAt: Long?
    var declinedAt: Long?
}

/**
 * The stamps in their own preferences, listed in AppGraph's WIPED_PREFS:
 * happy-app keeps them in the default MMKV, which logout's clearPersistence
 * empties.
 */
class PrefsReviewStamps(private val prefs: SharedPreferences) : ReviewStamps {
    override var storeReviewShownAt: Long?
        get() = read(KEY_STORE_REVIEW_LAST_SHOWN)
        set(value) = write(KEY_STORE_REVIEW_LAST_SHOWN, value)
    override var declinedAt: Long?
        get() = read(KEY_DECLINED_AT)
        set(value) = write(KEY_DECLINED_AT, value)

    private fun read(key: String): Long? = if (prefs.contains(key)) prefs.getLong(key, 0) else null

    private fun write(key: String, value: Long?) = prefs.edit { if (value == null) remove(key) else putLong(key, value) }

    companion object {
        const val PREFS_NAME = "review"
        private const val KEY_STORE_REVIEW_LAST_SHOWN = "review_store_last_shown"
        private const val KEY_DECLINED_AT = "review_declined_at"
    }
}

/** The pre-ask's words (`review.*`). */
data class ReviewStrings(val title: String, val message: String, val yes: String, val no: String)

/** The activity the store review is shown over. */
internal tailrec fun Context.findActivity(): Activity? = when (this) {
    is Activity -> this
    is ContextWrapper -> baseContext.findActivity()
    else -> null
}

/** What requestReview.ts does this time. */
enum class ReviewStep { Nothing, StoreReview, Ask }

/**
 * requestReview.ts's checks, in its order: someone who liked the app gets
 * the store review again once 7 days have passed; anyone who answered
 * (here or on another device) is not asked again; a decline holds the ask
 * back 30 days.
 */
fun resolveReviewStep(answered: Boolean, liked: Boolean?, stamps: ReviewStamps, now: Long): ReviewStep {
    if (answered && liked == true) {
        val shown = stamps.storeReviewShownAt
        return if (shown != null && now - shown < STORE_REVIEW_RETRY_DAYS * DAY_MS) ReviewStep.Nothing else ReviewStep.StoreReview
    }
    if (answered) return ReviewStep.Nothing
    val declined = stamps.declinedAt
    if (declined != null && now - declined < RETRY_DAYS * DAY_MS) return ReviewStep.Nothing
    return ReviewStep.Ask
}

/**
 * SessionsList.tsx asks once its list has sessions. Phones grouped by
 * project show ProjectHomeList, which never asks; the tablet sidebar is
 * always SessionsList.
 */
fun asksForReview(state: HomeListState?, phone: Boolean): Boolean =
    state != null &&
        state.emptyState == HomeEmptyState.List &&
        state.rows.isNotEmpty() &&
        (!phone || state.grouping == SessionListGrouping.Flat)

/**
 * requestReview.ts: one run at a time (its AsyncLock). Asking stores the
 * answer in the synced settings through [answer]; a "Not really" stamps
 * the decline, a "Yes" opens the store review and stamps that. The
 * analytics calls are left out. Failures are logged, as upstream's catch.
 */
class ReviewPrompter(
    private val answered: () -> Pair<Boolean, Boolean?>,
    private val answer: (liked: Boolean) -> Unit,
    private val stamps: ReviewStamps,
    private val now: () -> Long = System::currentTimeMillis,
) {
    private val lock = Mutex()

    suspend fun run(isAvailable: suspend () -> Boolean, ask: suspend () -> Boolean, review: suspend () -> Unit) = lock.withLock {
        try {
            if (!isAvailable()) return@withLock
            val (isAnswered, liked) = answered()
            when (resolveReviewStep(isAnswered, liked, stamps, now())) {
                ReviewStep.Nothing -> Unit
                ReviewStep.StoreReview -> {
                    review()
                    stamps.storeReviewShownAt = now()
                }
                ReviewStep.Ask -> {
                    val likes = ask()
                    answer(likes)
                    if (!likes) {
                        stamps.declinedAt = now()
                    } else {
                        review()
                        stamps.storeReviewShownAt = now()
                    }
                }
            }
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            Log.w(TAG, "Error requesting review", e)
        }
    }

    private companion object {
        const val TAG = "ReviewPrompt"
    }
}

/**
 * expo-store-review on Android: available when the Play Store is installed;
 * the review is Play's in-app review flow over [activity].
 */
class PlayStoreReview(private val context: Context) {
    fun isAvailable(): Boolean = try {
        context.packageManager.getPackageInfo(PLAY_STORE, 0)
        true
    } catch (_: PackageManager.NameNotFoundException) {
        false
    }

    suspend fun request(activity: Activity) {
        val manager = ReviewManagerFactory.create(context)
        val info = manager.requestReviewFlow().await()
        manager.launchReviewFlow(activity, info).await()
    }

    private companion object {
        const val PLAY_STORE = "com.android.vending"
    }
}

private suspend fun <T> Task<T>.await(): T = suspendCancellableCoroutine { continuation ->
    addOnCompleteListener { task ->
        if (task.isSuccessful) continuation.resume(task.result)
        else continuation.resumeWithException(task.exception ?: IllegalStateException("The review task was cancelled"))
    }
}

private const val RETRY_DAYS = 30L
private const val STORE_REVIEW_RETRY_DAYS = 7L
private const val DAY_MS = 24L * 60 * 60 * 1000
