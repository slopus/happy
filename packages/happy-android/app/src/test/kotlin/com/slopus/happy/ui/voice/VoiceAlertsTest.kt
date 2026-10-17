package com.slopus.happy.ui.voice

import android.content.Context
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import com.slopus.happy.R
import com.slopus.happy.voice.VoiceStart
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith

/** RealtimeSession.ts outcomes: silent decline/success; actionable permission and account/limit alerts. */
@RunWith(AndroidJUnit4::class)
class VoiceAlertsTest {
    @Test fun outcomesKeepTheirSpecificMessagesAndOnlyPermanentMicDenialOpensSettings() {
        val resources = ApplicationProvider.getApplicationContext<Context>().resources
        var opened = false
        fun alert(result: VoiceStart) = voiceStartAlert(result, resources) { opened = true }
        assertNull(alert(VoiceStart.Started("c")))
        assertNull(alert(VoiceStart.Declined))
        assertEquals(resources.getString(R.string.errors_authentication_failed), alert(VoiceStart.NotSignedIn)?.message)
        assertEquals(resources.getString(R.string.errors_voice_limit_reached_title), alert(VoiceStart.LimitReached)?.title)
        assertEquals(resources.getString(R.string.errors_voice_conversation_limit_reached), alert(VoiceStart.LimitReached)?.message)
        assertEquals(resources.getString(R.string.errors_voice_service_unavailable), alert(VoiceStart.Unavailable)?.message)
        assertEquals(listOf("Cancel"), alert(VoiceStart.MicrophoneDenied(true))?.buttons?.map { it.text })
        val denied = alert(VoiceStart.MicrophoneDenied(false))!!
        assertEquals(listOf("Cancel", "Open Settings"), denied.buttons.map { it.text })
        denied.buttons.last().onClick()
        assertTrue(opened)
    }
}