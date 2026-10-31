package com.slopus.happy.ui.components.avatar

import com.slopus.happy.ui.home.AccountMenuEntry
import com.slopus.happy.ui.settings.SettingsProfile
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

/**
 * happy-ios 00b47cb84's rules on Android: how fast a placeholder moves for
 * its size, at what rate it is drawn, and which accounts move (`liveSeed`).
 */
class AvatarSpeedTest {
    /** AvatarShader.speed(side:): 2x at 48 and under, 1.5x above; 20 frames a second, in one place. */
    @Test
    fun speedBySize() {
        for (side in listOf(10f, 24f, 30f, 44f, 48f)) assertEquals("$side", 2f, AvatarShader.speed(side))
        for (side in listOf(48.5f, 56f, 100f, 128f)) assertEquals("$side", 1.5f, AvatarShader.speed(side))
        assertEquals(20, AvatarShader.FRAMES_PER_SECOND)
    }

    /** The same clock as happy-ios's: its phase, plus seconds on screen times its speed; the phase when still. */
    @Test
    fun theClockRunsAtItsSpeed() {
        val parameters = AvatarShader.parameters(7)
        assertEquals(parameters.phase, AvatarShader.time(parameters, 0L, 2f), 0f)
        assertEquals(parameters.phase + 3f, AvatarShader.time(parameters, 1500L, 2f), 1e-4f)
        assertEquals(parameters.phase + 2.25f, AvatarShader.time(parameters, 1500L, 1.5f), 1e-4f)
        assertEquals(parameters.phase, AvatarShader.time(parameters, 1500L, 2f, move = false), 0f)
        assertEquals("never before it started", parameters.phase, AvatarShader.time(parameters, -50L, 2f), 0f)
    }

    /** ProfilePictures.liveSeed: only an account with no picture and no thumbhash of one moves. */
    @Test
    fun onlyAnAccountWithoutAPictureMoves() {
        assertEquals("agent:10.0.0.2", AvatarPlaceholder.liveSeed("agent:10.0.0.2", null, null))
        assertNull(AvatarPlaceholder.liveSeed("a", "https://example.com/a.jpg", null))
        assertNull(AvatarPlaceholder.liveSeed("a", null, "1QcSHQRnh493V4dIh4eXh1h4kJUI"))
        assertNull(AvatarPlaceholder.liveSeed("a", "data:image/png;base64,AA", "1QcSHQRnh493V4dIh4eXh1h4kJUI"))
        assertEquals("addr", AccountMenuEntry("id", "Agent", seed = "addr").liveSeed)
        assertNull(AccountMenuEntry("id", "Me", imageUrl = "https://example.com/me.jpg").liveSeed)
        assertEquals("id", SettingsProfile("id", "Me", "@me").liveSeed)
        assertNull(SettingsProfile("id", "Me", "@me", thumbhash = "1QcSHQRnh493V4dIh4eXh1h4kJUI").liveSeed)
    }
}
