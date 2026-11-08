package io.elevenlabs.audio

import android.content.Context
import android.media.AudioFocusRequest
import android.media.AudioManager
import com.twilio.audioswitch.AudioDevice
import com.twilio.audioswitch.AudioDeviceChangeListener
import io.livekit.android.AudioType
import io.livekit.android.audio.AudioHandler
import io.livekit.android.audio.AudioSwitchHandler

/**
 * Happy patch: LiveKit 2.26.0 still owns the focus request and routing.
 * Its focus is transient, as a phone call's is: music playing when a call
 * starts pauses and plays on once it ends. LiveKit's own default is
 * AUDIOFOCUS_GAIN, which other apps take as for good and stay paused.
 *
 * With [held], the call is a phone call's: another app taking the audio for
 * a while (a phone call ringing, an alarm) holds it until the audio comes
 * back, one taking it for good (music started) has it taken back at once,
 * as a phone call refuses it, and a headset going leaves AudioSwitch to
 * route to the next device. Nothing here ends the call.
 *
 * Otherwise, with [interrupted] (the relay's voice), its public listeners
 * report interruptions; the app closes its session through the ordinary
 * generation-guarded disconnect callback. Stopping the handler disarms
 * listeners before abandoning focus, so teardown cannot end a later call.
 */
internal class ConversationAudioHandler(
    context: Context,
    output: AudioType,
    private val interrupted: (() -> Unit)?,
    private val held: ((Boolean) -> Unit)? = null,
) : AudioHandler {
    private val policy = AudioInterruptions()
    private val hold = AudioHold()
    private val audio = context.getSystemService(Context.AUDIO_SERVICE) as AudioManager
    private val handler = AudioSwitchHandler(context).apply {
        // AudioOptions.audioOutputType does not configure a custom handler.
        audioMode = output.audioMode
        audioStreamType = output.audioStreamType
        audioAttributeUsageType = output.audioAttributes.usage
        audioAttributeContentType = output.audioAttributes.contentType
        focusMode = AudioManager.AUDIOFOCUS_GAIN_TRANSIENT
    }
    private val focus = AudioManager.OnAudioFocusChangeListener { change ->
        if (held != null) act(hold.focusChanged(change)) else if (policy.focusChanged(change)) interrupted?.invoke()
    }

    /**
     * The request that takes the audio back after a loss for good. A loss
     * for good takes AudioSwitch's request off the focus stack, so this is
     * then the call's only one; it goes with the call.
     */
    private val reclaim = AudioFocusRequest.Builder(AudioManager.AUDIOFOCUS_GAIN_TRANSIENT)
        .setAudioAttributes(output.audioAttributes)
        .setAcceptsDelayedFocusGain(true)
        .setOnAudioFocusChangeListener(focus)
        .build()
    @Volatile private var reclaimed = false

    private fun act(action: AudioHold.Action?) {
        when (action) {
            AudioHold.Action.Hold -> held?.invoke(true)
            AudioHold.Action.Resume -> held?.invoke(false)
            AudioHold.Action.Reclaim -> {
                reclaimed = true
                act(hold.reclaimed(audio.requestAudioFocus(reclaim)))
            }
            null -> Unit
        }
    }

    private val devices = object : AudioDeviceChangeListener {
        override fun invoke(audioDevices: List<AudioDevice>, selectedAudioDevice: AudioDevice?) {
            val available = audioDevices.mapNotNull { it.headset() }.toSet()
            if (policy.devicesChanged(available, selectedAudioDevice?.headset())) interrupted?.invoke()
        }
    }

    override fun start() {
        policy.start()
        hold.start()
        handler.registerOnAudioFocusChangeListener(focus)
        if (held == null) handler.registerAudioDeviceChangeListener(devices)
        handler.start()
    }

    override fun stop() {
        policy.stop()
        hold.stop()
        handler.unregisterOnAudioFocusChangeListener(focus)
        handler.unregisterAudioDeviceChangeListener(devices)
        handler.stop()
        if (reclaimed) {
            reclaimed = false
            audio.abandonAudioFocusRequest(reclaim)
        }
    }
}

/**
 * A phone call's way with the audio focus, for [ConversationAudioHandler]:
 * a loss for a while holds the call until the audio is back; a loss for
 * good is taken back at once, at most [MAX_RECLAIMS] times in
 * [RECLAIM_WINDOW] ms (past that the other app is let be, and the call
 * goes on); a duck changes nothing. Taking it back may have to wait for the
 * other app (a phone call), holding the call meanwhile.
 */
internal class AudioHold(private val now: () -> Long = { android.os.SystemClock.elapsedRealtime() }) {
    enum class Action { Hold, Resume, Reclaim }

    private var active = false
    private var held = false
    private val reclaims = ArrayDeque<Long>()

    @Synchronized fun start() { active = true; held = false; reclaims.clear() }
    @Synchronized fun stop() { active = false; held = false }

    @Synchronized fun focusChanged(change: Int): Action? {
        if (!active) return null
        return when (change) {
            AudioManager.AUDIOFOCUS_LOSS_TRANSIENT -> hold()
            AudioManager.AUDIOFOCUS_GAIN -> resume()
            AudioManager.AUDIOFOCUS_LOSS -> {
                val at = now()
                while (reclaims.isNotEmpty() && at - reclaims.first() > RECLAIM_WINDOW) reclaims.removeFirst()
                if (reclaims.size >= MAX_RECLAIMS) null else Action.Reclaim.also { reclaims.addLast(at) }
            }
            else -> null
        }
    }

    /** What the request to take the audio back answered. */
    @Synchronized fun reclaimed(result: Int): Action? {
        if (!active) return null
        return when (result) {
            AudioManager.AUDIOFOCUS_REQUEST_GRANTED -> resume()
            AudioManager.AUDIOFOCUS_REQUEST_DELAYED -> hold()
            else -> null
        }
    }

    private fun hold(): Action? = if (held) null else Action.Hold.also { held = true }
    private fun resume(): Action? = if (!held) null else Action.Resume.also { held = false }

    companion object {
        const val MAX_RECLAIMS = 3
        const val RECLAIM_WINDOW = 30_000L
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

    /** Another app took the audio, for good or for a while (a phone call ringing). A sound that only ducks (a notification) does not end a call. */
    @Synchronized fun focusChanged(change: Int): Boolean = when (change) {
        AudioManager.AUDIOFOCUS_LOSS, AudioManager.AUDIOFOCUS_LOSS_TRANSIENT -> interrupt()
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