package com.slopus.happy.ui.components.avatar

import androidx.compose.runtime.Immutable
import kotlin.math.max

/**
 * happy-ios's AvatarShader.swift: the placeholders as live shaders, what
 * @craftedstudios/shaders draws each one with ([avatarShaderTable], made
 * from its own code), and the clock. At its phase a placeholder's shader
 * draws the picture it was made from, so the first live one starts where
 * the still one is.
 */
object AvatarShader {
    /** The shader's branch for each effect (renderer.js `FX`). */
    enum class Effect { Linear, Thermal, Topography, Plasma, Radial }

    @Immutable
    class Parameters(
        val effect: Effect,
        /** The effect's colours in its own roles, sRGB 0...1, r g b each; topography uses the first three. */
        val colors: FloatArray,
        /** Where in its pattern the seed sits: offset (x, y), turn, zoom. */
        val layout: FloatArray,
        /** The direction of the effects that have one, in radians. */
        val angle: Float,
        /** Seconds added to the clock, so no two move in step. */
        val phase: Float,
    )

    /** Floats per row of [avatarShaderTable]. */
    const val ROW = 19

    /**
     * The package's defaults, the same for every avatar: distortion 0.5
     * (warp 1), scale 1, grain 0.07, speed 1.
     */
    const val WARP = 1f
    const val SCALE = 1f
    const val GRAIN = 0.07f

    /**
     * How fast a live placeholder moves: its clock's rate, 1 the package's
     * own, at which a row's avatar reads as still (happy-ios's `speed`).
     * Every size runs at the same rate, so a row, its chat's mark and
     * Settings' large picture of the same seed show the same frame.
     */
    const val SPEED = 2f

    /**
     * When each placeholder's clock started: the first time any view asked
     * for it (happy-ios's `AvatarShader.Clock`). Every view of a placeholder
     * reads the one clock, so a row composed again, a screen opened from it
     * or come back to shows the frame the others show, never its phase again.
     */
    class Clock {
        private val origins = HashMap<Int, Long>()

        /** Placeholder [index]'s origin, [now] if nothing has asked yet. */
        fun origin(index: Int, now: Long): Long = origins.getOrPut(index) { now }
    }

    /** The frames a second live placeholders are drawn at (happy-ios's `framesPerSecond`). */
    const val FRAMES_PER_SECOND = 20

    private val table: List<Parameters> = List(AvatarPlaceholder.COUNT) { index ->
        val at = index * ROW
        Parameters(
            effect = Effect.entries[avatarShaderTable[at].toInt()],
            colors = avatarShaderTable.copyOfRange(at + 1, at + 13),
            layout = avatarShaderTable.copyOfRange(at + 13, at + 17),
            angle = avatarShaderTable[at + 17],
            phase = avatarShaderTable[at + 18],
        )
    }

    /** The parameters of placeholder [index] (as [AvatarPlaceholder]). */
    fun parameters(index: Int): Parameters = table[index]

    /** The one [seed] wears: the same placeholder as its still picture. */
    fun parameters(seed: String): Parameters = table[AvatarPlaceholder.index(seed)]

    /** The shader's clock after [elapsed] seconds on screen. */
    fun time(parameters: Parameters, elapsed: Double): Float = parameters.phase + elapsed.toFloat()

    /** The clock of one moving [speed] times its own rate, [millis] after it started; its phase when it doesn't [move]. */
    fun time(parameters: Parameters, millis: Long, speed: Float, move: Boolean = true): Float =
        time(parameters, if (move) millis.coerceAtLeast(0) / 1000.0 * speed else 0.0)

    /** The grain's cell in device pixels for an avatar [pixels] across (renderer.js: `max(1, 2r / 540)`), so large ones keep visible grain. */
    fun grainCell(pixels: Int): Float = max(1f, pixels / 540f)
}
