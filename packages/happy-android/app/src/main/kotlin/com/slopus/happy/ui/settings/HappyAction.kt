package com.slopus.happy.ui.settings

import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.setValue
import com.slopus.happy.model.settings.ConnectException
import com.slopus.happy.net.HttpStatusException
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import java.io.IOException
import kotlin.random.Random

/**
 * happy-app's `useHappyAction` with the `backoff` its API calls run in: one
 * run at a time, [loading] while it runs. A network failure is retried with
 * backoff (as `backoff` does, for as long as the screen is there); a
 * [ConnectException] reports its message and anything else reports null
 * ("Unknown error") through [onError].
 */
class HappyAction internal constructor(
    private val scope: CoroutineScope,
    private val onError: (String?) -> Unit,
    private val block: suspend () -> Unit,
) {
    var loading by mutableStateOf(false)
        private set

    fun run() {
        if (loading) return
        loading = true
        scope.launch {
            try {
                var failures = 0
                while (true) {
                    try {
                        block()
                        break
                    } catch (e: CancellationException) {
                        throw e
                    } catch (e: IOException) {
                        if (e is HttpStatusException) throw e
                        failures = minOf(failures + 1, MAX_FAILURES)
                        delay(backoffDelay(failures))
                    }
                }
            } catch (e: CancellationException) {
                throw e
            } catch (e: ConnectException) {
                onError(e.message)
            } catch (_: Exception) {
                onError(null)
            } finally {
                loading = false
            }
        }
    }

    internal companion object {
        const val MIN_DELAY = 250L
        const val MAX_DELAY = 1000L
        const val MAX_FAILURES = 50

        /** time.ts exponentialBackoffDelay with createBackoff's defaults. */
        fun backoffDelay(failures: Int): Long {
            val max = MIN_DELAY + (MAX_DELAY - MIN_DELAY).toDouble() / MAX_FAILURES * maxOf(failures, MAX_FAILURES)
            return Math.round(Random.nextDouble() * max)
        }
    }
}

@Composable
fun rememberHappyAction(onError: (String?) -> Unit, block: suspend () -> Unit): HappyAction {
    val scope = rememberCoroutineScope()
    val currentBlock by rememberUpdatedState(block)
    val currentOnError by rememberUpdatedState(onError)
    return remember(scope) { HappyAction(scope, { currentOnError(it) }, { currentBlock() }) }
}
