package io.elevenlabs.audio

import android.content.Context
import android.media.AudioManager
import com.twilio.audioswitch.AudioDevice
import com.twilio.audioswitch.AudioDeviceChangeListener
import io.livekit.android.AudioType
import io.livekit.android.audio.AudioHandler
import io.livekit.android.audio.AudioSwitchHandler

/**
 * Happy patch: LiveKit 2.26.0 still owns the single focus request and routing.
 * Its public listeners report interruptions; the app closes its session through
 * the ordinary generation-guarded disconnect callback. Stopping the handler
 * disarms listeners before abandoning focus, so teardown cannot end a later call.
 */
internal class ConversationAudioHandler(context: Context, output: AudioType, private val interrupted: () -> Unit) : AudioHandler {
    private val policy = AudioInterruptions()
    private val handler = AudioSwitchHandler(context).apply {
        // AudioOptions.audioOutputType does not configure a custom handler.
        audioMode = output.audioMode
        audioStreamType = output.audioStreamType
        audioAttributeUsageType = output.audioAttributes.usage
        audioAttributeContentType = output.audioAttributes.contentType
    }
    private val focus = AudioManager.OnAudioFocusChangeListener { if (policy.focusChanged(it)) interrupted() }
    private val devices = object : AudioDeviceChangeListener {
        override fun invoke(audioDevices: List<AudioDevice>, selectedAudioDevice: AudioDevice?) {
            val available = audioDevices.mapNotNull { it.headset() }.toSet()
            if (policy.devicesChanged(available, selectedAudioDevice?.headset())) interrupted()
        }
    }

    override fun start() {
        policy.start()
        handler.registerOnAudioFocusChangeListener(focus)
        handler.registerAudioDeviceChangeListener(devices)
        handler.start()
    }

    override fun stop() {
        policy.stop()
        handler.unregisterOnAudioFocusChangeListener(focus)
        handler.unregisterAudioDeviceChangeListener(devices)
        handler.stop()
    }
}

/** A selected physical headset, independent of AudioSwitch's private device constructors. */
internal sealed interface Headset {
    data class Wired(val name: String) : Headset
    data class Bluetooth(val name: String) : Headset
}

private fun AudioDevice.headset(): Headset? = when (this) {
    is AudioDevice.WiredHeadset -> Headset.Wired(name)
    is AudioDevice.BluetoothHeadset -> Headset.Bluetooth(name)
    else -> null
}

/** The selected headset must disappear; switching to speaker with it still present is allowed. */
internal class AudioInterruptions {
    private var active = false
    private var interrupted = false
    private var headset: Headset? = null

    @Synchronized fun start() { active = true; interrupted = false; headset = null }
    @Synchronized fun stop() { active = false; headset = null }

    @Synchronized fun focusChanged(change: Int): Boolean = when (change) {
        AudioManager.AUDIOFOCUS_LOSS, AudioManager.AUDIOFOCUS_LOSS_TRANSIENT,
        AudioManager.AUDIOFOCUS_LOSS_TRANSIENT_CAN_DUCK -> interrupt()
        else -> false
    }

    @Synchronized fun devicesChanged(available: Set<Headset>, selected: Headset?): Boolean {
        if (!active) return false
        val removed = headset?.let { it !in available } == true
        headset = selected
        return removed && interrupt()
    }

    private fun interrupt(): Boolean {
        if (!active || interrupted) return false
        interrupted = true
        return true
    }
}