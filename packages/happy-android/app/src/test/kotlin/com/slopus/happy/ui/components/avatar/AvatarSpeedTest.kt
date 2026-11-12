package com.slopus.happy.ui.components.avatar

import com.slopus.happy.ui.home.AccountMenuEntry
import com.slopus.happy.ui.settings.SettingsProfile
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

/**
 * happy-ios's rules on Android: how fast a placeholder moves, on whose
 * clock, at what rate it is drawn, and which accounts move (`liveSeed`).
 */
class AvatarSpeedTest {
    /** AvatarShader.speed: 2x at every size, so one seed is one frame everywhere; 20 frames a second, in one place. */
    @Test
    fun oneSpeedForEverySize() {
        assertEquals(2f, AvatarShader.SPEED)
        assertEquals(20, AvatarShader.FRAMES_PER_SECOND)
    }

    /**
     * A placeholder has one clock: a view that comes later (a row composed
     * again, the chat opened from it, home come back to) joins it rather
     * than starting over at its phase, and other placeholders keep their own.
     */
    @Test
    fun everyViewOfAPlaceholderReadsOneClock() {
        val clock = AvatarShader.Clock()
        assertEquals("the first view starts on its picture", 1_000L, clock.origin(7, 1_000L))
        assertEquals("a later view joins it", 1_000L, clock.origin(7, 61_000L))
        assertEquals(61_000L, clock.origin(8, 61_000L))
        val parameters = AvatarShader.parameters(7)
        assertEquals(parameters.phase + 120f, AvatarShader.time(parameters, 61_000L - clock.origin(7, 61_000L), AvatarShader.SPEED), 1e-3f)
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
