package com.slopus.happy.analytics

import android.content.Context
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import com.slopus.happy.data.HappyDatabase
import com.slopus.happy.data.HappyStore
import com.slopus.happy.model.Settings
import com.slopus.happy.model.settings.SettingsRepository
import com.slopus.happy.net.HappyJson
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.map
import kotlinx.coroutines.launch
import kotlinx.coroutines.test.StandardTestDispatcher
import kotlinx.coroutines.test.advanceTimeBy
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.jsonObject
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Test
import org.junit.runner.RunWith

/**
 * The account side of analytics consent, from the Account screen's switch
 * (`SettingsRepository.change`) to what `Analytics.start` is told: the open
 * account's opt-out counts at once, every other account's from its own
 * database, nothing before they are read.
 */
@OptIn(ExperimentalCoroutinesApi::class)
@RunWith(AndroidJUnit4::class)
class AccountsOptedOutTest {
    private val context = ApplicationProvider.getApplicationContext<Context>()
    private val openDatabase = HappyDatabase(context, name = null)
    private val otherDatabase = HappyDatabase(context, name = null)
    private val open = HappyStore(openDatabase)
    private val other = HappyStore(otherDatabase)

    @After
    fun tearDown() {
        openDatabase.close()
        otherDatabase.close()
    }

    private fun stored(store: HappyStore, optOut: Boolean) =
        store.saveSettings(HappyJson.parseToJsonElement("""{"analyticsOptOut":$optOut}""").jsonObject, version = 1)

    private fun read(id: String): Boolean = Settings.parse(
        when (id) {
            "open" -> open
            "other" -> other
            else -> error("unreadable")
        }.effectiveSettings(),
    ).analyticsOptOut

    @Test
    fun turningTheOpenAccountsSwitchOffCountsAtOnce() = runTest {
        stored(open, false)
        stored(other, false)
        val io = StandardTestDispatcher(testScheduler)
        val settings = SettingsRepository(open, backgroundScope, onChanged = {}, io = io)
        val seen = mutableListOf<Boolean>()
        backgroundScope.launch {
            accountsOptedOut(MutableStateFlow(listOf("open", "other")), settings.settings.map { it.analyticsOptOut }, open.changes, ::read, io)
                .collect { seen += it }
        }
        runCurrent()
        assertEquals("nothing before the accounts are read", emptyList<Boolean>(), seen)
        advanceTimeBy(501)
        runCurrent()
        assertEquals(listOf(false), seen)

        // The Account screen's switch: AccountScreen → SettingsRoutes → settings.change.
        settings.change { it.copy(analyticsOptOut = true) }
        runCurrent()
        assertEquals("before the store or a sync has it", listOf(false, true), seen)
        advanceTimeBy(1_000)
        runCurrent()
        assertEquals(true, seen.last())

        settings.change { it.copy(analyticsOptOut = false) }
        advanceTimeBy(1_000)
        runCurrent()
        assertEquals(false, seen.last())
    }

    @Test
    fun anAccountNotOpenCountsAndOneThatCantBeReadIsOptedOut() = runTest {
        stored(open, false)
        stored(other, true)
        val io = StandardTestDispatcher(testScheduler)
        val ids = MutableStateFlow(listOf("open"))
        val seen = mutableListOf<Boolean>()
        backgroundScope.launch {
            accountsOptedOut(ids, MutableStateFlow(false), open.changes, ::read, io).collect { seen += it }
        }
        advanceTimeBy(501)
        runCurrent()
        assertEquals(listOf(false), seen)
        ids.value = listOf("open", "other")
        runCurrent()
        assertEquals(true, seen.last())
        ids.value = listOf("open", "gone")
        runCurrent()
        assertEquals(true, seen.last())
        stored(other, false)
        ids.value = listOf("open", "other")
        runCurrent()
        assertEquals(false, seen.last())
    }
}
