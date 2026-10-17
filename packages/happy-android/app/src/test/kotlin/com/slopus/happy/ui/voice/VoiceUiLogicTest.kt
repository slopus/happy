package com.slopus.happy.ui.voice

import com.slopus.happy.model.Settings
import com.slopus.happy.ui.chat.PrimaryAction
import com.slopus.happy.ui.chat.resolvePrimaryAction
import com.slopus.happy.voice.VoiceLanguages
import org.junit.Assert.*
import org.junit.Test

class VoiceUiLogicTest {
    @Test fun voiceIsTheLastEnabledFallbackAfterStopBlockedAndSend() {
        assertEquals(PrimaryAction.Stop, resolvePrimaryAction(false, true, true, true, canVoice = true))
        assertEquals(PrimaryAction.Blocked, resolvePrimaryAction(true, false, false, true, canVoice = true))
        assertEquals(PrimaryAction.Send, resolvePrimaryAction(true, false, false, false, canVoice = true))
        assertEquals(PrimaryAction.Voice, resolvePrimaryAction(false, false, false, false, canVoice = true))
        assertEquals(PrimaryAction.Idle, resolvePrimaryAction(false, false, false, false, disabled = true, canVoice = true))
    }
    @Test fun callDurationUsesHoursOnlyWhenNeeded() {
        assertEquals("0:00", formatCallDuration(-1))
        assertEquals("0:59", formatCallDuration(59))
        assertEquals("1:00", formatCallDuration(60))
        assertEquals("59:59", formatCallDuration(3599))
        assertEquals("1:00:00", formatCallDuration(3600))
    }
    @Test fun languageLookupAndSearchKeepTheReferenceCatalog() {
        assertEquals(46, VoiceLanguages.all.size)
        assertNull(VoiceLanguages.all.first().code)
        assertEquals("English - United Kingdom", VoiceLanguages.find("en-GB")?.displayName)
        assertEquals("pt-br", VoiceLanguages.elevenLabsCode("pt-BR"))
        assertNull(VoiceLanguages.elevenLabsCode("he-IL"))
        assertNull(VoiceLanguages.elevenLabsCode(null))
        assertTrue(VoiceLanguages.find("ja-JP")!!.matches("日本"))
        assertTrue(VoiceLanguages.find("en-GB")!!.matches("UNITED KINGDOM"))
        assertTrue(VoiceLanguages.find("en-GB")!!.matches("EN-GB"))
    }
    @Test fun customAgentSettingOnlyChangesVoiceFieldsAndSetsBypass() {
        val settings = Settings(voiceAssistantLanguage = "ja-JP")
        val custom = setCustomVoiceAgent(settings, "  agent  ")
        assertEquals(settings.copy(voiceCustomAgentId = "agent", voiceBypassToken = true), custom)
        assertEquals(settings, setCustomVoiceAgent(custom, "  "))
    }
}