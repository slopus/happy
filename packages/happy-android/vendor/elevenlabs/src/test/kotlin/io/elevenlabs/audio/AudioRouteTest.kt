package io.elevenlabs.audio

import android.content.Context
import android.content.pm.PackageManager
import android.media.AudioDeviceInfo
import android.media.AudioManager
import android.os.Looper
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import com.twilio.audioswitch.AudioDevice
import com.twilio.audioswitch.AudioSwitch
import org.junit.Assert.assertEquals
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config
import org.robolectric.shadows.AudioDeviceInfoBuilder
import org.robolectric.util.ReflectionHelpers

/**
 * Where the call's audio goes when a headset comes and goes, as a phone
 * call's does: LiveKit's AudioSwitch, with the order the call's
 * AudioSwitchHandler gives it (Bluetooth, wired, speaker, earpiece). A
 * headset that goes leaves the call on the speaker it started on, still
 * routing; nothing stops it. Android 11's scanner (the same selection as
 * Android 12's communication-device one).
 */
@RunWith(AndroidJUnit4::class)
@Config(sdk = [30])
class AudioRouteTest {
    private val context = ApplicationProvider.getApplicationContext<Context>()
    private val audio = context.getSystemService(AudioManager::class.java)
    private val order = listOf(AudioDevice.BluetoothHeadset::class.java, AudioDevice.WiredHeadset::class.java, AudioDevice.Speakerphone::class.java, AudioDevice.Earpiece::class.java)

    /** A device as the system lists it, with a name (AudioSwitch reads it; Robolectric's builder leaves none). */
    private fun device(type: Int): AudioDeviceInfo = AudioDeviceInfoBuilder.newBuilder().setType(type).build().also { info ->
        ReflectionHelpers.setField(ReflectionHelpers.getField<Any>(info, "mPort"), "mName", "Headphones")
    }

    @Test
    fun aHeadsetGoingLeavesTheCallOnTheSpeakerItStartedOn() {
        shadowOf(context.packageManager).setSystemFeature(PackageManager.FEATURE_TELEPHONY, true)
        shadowOf(context.packageManager).setSystemFeature(PackageManager.FEATURE_AUDIO_OUTPUT, true)
        val speaker = device(AudioDeviceInfo.TYPE_BUILTIN_SPEAKER)
        shadowOf(audio).addOutputDevice(speaker, false)
        val switch = AudioSwitch(context, preferredDeviceList = order)
        var selected: AudioDevice? = null
        switch.start { _, device -> selected = device }
        switch.activate()
        shadowOf(Looper.getMainLooper()).idle()
        assertEquals(AudioDevice.Speakerphone::class.java, selected?.javaClass)

        val wired = device(AudioDeviceInfo.TYPE_WIRED_HEADSET)
        shadowOf(audio).addOutputDevice(wired, true)
        shadowOf(Looper.getMainLooper()).idle()
        assertEquals(AudioDevice.WiredHeadset::class.java, selected?.javaClass)

        shadowOf(audio).removeOutputDevice(wired, true)
        shadowOf(Looper.getMainLooper()).idle()
        assertEquals(AudioDevice.Speakerphone::class.java, selected?.javaClass)
        @Suppress("DEPRECATION")
        assertEquals("still routing for the call", true, audio.isSpeakerphoneOn)

        val bluetooth = device(AudioDeviceInfo.TYPE_BLUETOOTH_SCO)
        shadowOf(audio).addOutputDevice(bluetooth, true)
        shadowOf(Looper.getMainLooper()).idle()
        assertEquals(AudioDevice.BluetoothHeadset::class.java, selected?.javaClass)
        shadowOf(audio).removeOutputDevice(bluetooth, true)
        shadowOf(Looper.getMainLooper()).idle()
        assertEquals(AudioDevice.Speakerphone::class.java, selected?.javaClass)
        switch.stop()
    }
}
