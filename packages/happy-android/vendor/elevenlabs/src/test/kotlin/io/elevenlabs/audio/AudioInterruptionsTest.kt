package io.elevenlabs.audio

import android.media.AudioManager
import org.junit.Assert.*
import org.junit.Test

class AudioInterruptionsTest {
    @Test fun everyFocusLossEndsOnceAndLateCallbacksAfterStopDoNothing() {
        for (loss in listOf(AudioManager.AUDIOFOCUS_LOSS, AudioManager.AUDIOFOCUS_LOSS_TRANSIENT, AudioManager.AUDIOFOCUS_LOSS_TRANSIENT_CAN_DUCK)) {
            val policy = AudioInterruptions()
            assertFalse(policy.focusChanged(loss))
            policy.start()
            assertFalse(policy.focusChanged(AudioManager.AUDIOFOCUS_GAIN))
            assertTrue(policy.focusChanged(loss))
            assertFalse(policy.focusChanged(loss))
            policy.stop()
            assertFalse(policy.focusChanged(loss))
        }
    }

    @Test fun unpluggingEitherSelectedHeadsetEndsButSpeakerRoutingDoesNot() {
        for (headset in listOf(Headset.Wired("Headphones"), Headset.Bluetooth("Headphones"))) {
            val policy = AudioInterruptions()
            policy.start()
            assertFalse(policy.devicesChanged(setOf(headset), headset))
            assertTrue(policy.devicesChanged(emptySet(), null))
            assertFalse(policy.devicesChanged(emptySet(), null))
            policy.start()
            assertFalse(policy.devicesChanged(setOf(headset), headset))
            assertFalse("selecting speaker while the headset is still available is not unplugging it", policy.devicesChanged(setOf(headset), null))
            assertFalse(policy.devicesChanged(emptySet(), null))
        }
    }

    @Test fun removingAnUnusedHeadsetOrReceivingTeardownDeviceChangesDoesNotInterrupt() {
        val wired = Headset.Wired("Headphones")
        val bluetooth = Headset.Bluetooth("Headphones")
        val policy = AudioInterruptions()
        policy.start()
        assertFalse(policy.devicesChanged(setOf(wired, bluetooth), bluetooth))
        assertFalse(policy.devicesChanged(setOf(bluetooth), bluetooth))
        policy.stop()
        assertFalse(policy.devicesChanged(emptySet(), null))
    }

    @Test fun anotherBluetoothHeadsetDoesNotHideRemovalOfTheSelectedOne() {
        val selected = Headset.Bluetooth("Headset A")
        val other = Headset.Bluetooth("Headset B")
        val policy = AudioInterruptions()
        policy.start()
        assertFalse(policy.devicesChanged(setOf(selected, other), selected))
        assertTrue(policy.devicesChanged(setOf(other), other))
    }
}