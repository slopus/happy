package com.slopus.happy.ui.home

import android.content.Context
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import com.slopus.happy.model.NewSessionDraft
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class NewSessionDraftStoreTest {
    private val prefs = ApplicationProvider.getApplicationContext<Context>()
        .getSharedPreferences(NewSessionDraftStore.PREFS_NAME, Context.MODE_PRIVATE)
        .apply { edit().clear().commit() }

    /**
     * Logout clears the file, then resets the store. A change in between (the
     * dock following its computer) stored the draft again; the reset removes it.
     */
    @Test
    fun aChangeBetweenLogoutsWipeAndResetIsGoneToo() {
        val drafts = NewSessionDraftStore(prefs) { 7 }
        drafts.change { it.copy(input = "before") }

        prefs.edit().clear().commit()
        drafts.change { it.copy(input = "racing the wipe") }
        drafts.reset()

        assertFalse(prefs.contains(NewSessionDraftStore.KEY))
        assertEquals(NewSessionDraft(), drafts.draft.value)
        assertEquals(NewSessionDraft(), NewSessionDraftStore(prefs).draft.value)
    }
}
