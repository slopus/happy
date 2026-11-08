package io.elevenlabs.audio

import android.media.AudioManager
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

/** The call's audio focus as a phone call's: held for a while, taken back for good, never ended. */
class AudioHoldTest {
    private var clock = 0L
    private val hold = AudioHold { clock }.apply { start() }

    @Test fun aLossForAWhileHoldsOnceAndTheGainResumes() {
        assertEquals(AudioHold.Action.Hold, hold.focusChanged(AudioManager.AUDIOFOCUS_LOSS_TRANSIENT))
        assertNull(hold.focusChanged(AudioManager.AUDIOFOCUS_LOSS_TRANSIENT))
        assertEquals(AudioHold.Action.Resume, hold.focusChanged(AudioManager.AUDIOFOCUS_GAIN))
        assertNull(hold.focusChanged(AudioManager.AUDIOFOCUS_GAIN))
    }

    @Test fun aDuckChangesNothing() {
        assertNull(hold.focusChanged(AudioManager.AUDIOFOCUS_LOSS_TRANSIENT_CAN_DUCK))
        assertNull(hold.focusChanged(AudioManager.AUDIOFOCUS_GAIN))
    }

    @Test fun aLossForGoodIsTakenBackAndAWaitHoldsUntilTheGain() {
        assertEquals(AudioHold.Action.Reclaim, hold.focusChanged(AudioManager.AUDIOFOCUS_LOSS))
        assertNull("taken back at once: the call went on", hold.reclaimed(AudioManager.AUDIOFOCUS_REQUEST_GRANTED))
        assertEquals(AudioHold.Action.Reclaim, hold.focusChanged(AudioManager.AUDIOFOCUS_LOSS))
        assertEquals("a phone call has it: held until it is back", AudioHold.Action.Hold, hold.reclaimed(AudioManager.AUDIOFOCUS_REQUEST_DELAYED))
        assertEquals(AudioHold.Action.Resume, hold.focusChanged(AudioManager.AUDIOFOCUS_GAIN))
        assertEquals(AudioHold.Action.Reclaim, hold.focusChanged(AudioManager.AUDIOFOCUS_LOSS))
        assertNull("refused: the call goes on as it is", hold.reclaimed(AudioManager.AUDIOFOCUS_REQUEST_FAILED))
    }

    @Test fun anAppThatKeepsTakingItIsLetBeAfterThreeTriesAWindow() {
        repeat(AudioHold.MAX_RECLAIMS) {
            assertEquals(AudioHold.Action.Reclaim, hold.focusChanged(AudioManager.AUDIOFOCUS_LOSS))
            clock += 1_000
        }
        assertNull(hold.focusChanged(AudioManager.AUDIOFOCUS_LOSS))
        clock += AudioHold.RECLAIM_WINDOW
        assertEquals(AudioHold.Action.Reclaim, hold.focusChanged(AudioManager.AUDIOFOCUS_LOSS))
    }

    @Test fun nothingAfterStop() {
        hold.focusChanged(AudioManager.AUDIOFOCUS_LOSS_TRANSIENT)
        hold.stop()
        assertNull(hold.focusChanged(AudioManager.AUDIOFOCUS_GAIN))
        assertNull(hold.focusChanged(AudioManager.AUDIOFOCUS_LOSS))
        assertNull(hold.reclaimed(AudioManager.AUDIOFOCUS_REQUEST_GRANTED))
    }
}
