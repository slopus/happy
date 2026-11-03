package com.slopus.happy.ui.call

import kotlin.math.abs
import kotlin.math.ceil
import kotlin.math.max
import kotlin.math.min
import kotlin.math.pow
import kotlin.random.Random

/**
 * The call bar's three waves (iOS `CallWaves`, after Telegram-iOS
 * `TelegramCallsUI/Sources/CallStatusBarWavesLayer.swift`): each a crest across
 * the bar resting on its bottom edge, morphing from one random shape to the
 * next. How loud the call is makes the next shape come sooner and wilder and
 * sinks the two lower waves further below the bar. Only numbers: [CallBar]
 * draws [crests]. With no level reported the waves morph slowly at rest;
 * flat (Reduce Motion, not connected) they are the bar's straight edge.
 */
class CallWaves(seed: Long = Random.nextLong()) {
    data class Motion(
        val minRandomness: Float, val maxRandomness: Float,
        val minSpeed: Float, val maxSpeed: Float,
        val minOffset: Float, val maxOffset: Float,
    )

    data class Point(val x: Float, val y: Float)

    /** One cubic segment of a crest, in the waves' own pixels. */
    data class Segment(val to: Point, val control1: Point, val control2: Point)

    /** From the bar's left edge to its right: [start], then each segment. */
    data class Crest(val start: Point, val segments: List<Segment>)

    private inner class Wave(val motion: Motion) {
        var from: List<Point> = points()
        var to: List<Point> = from
        var elapsed = 0f
        var duration = 1f
        var speedLevel = 0f

        init { next() }

        fun advance(delta: Float) {
            elapsed += delta
            while (elapsed >= duration) {
                elapsed -= duration
                from = to
                next()
            }
        }

        fun current(level: Float): Pair<List<Point>, Float> {
            val progress = easeInOut((elapsed / duration).coerceIn(0f, 1f))
            val points = from.zip(to) { a, b -> Point(a.x + (b.x - a.x) * progress, a.y + (b.y - a.y) * progress) }
            val offset = if (motion.minOffset > 0) (motion.minOffset + (motion.maxOffset - motion.minOffset) * level) * TRAVEL else 0f
            return points to offset
        }

        private fun next() {
            to = points()
            val speed = (motion.minSpeed + (motion.maxSpeed - motion.minSpeed) * speedLevel) * SPEED_MULTIPLIER
            duration = 1f / max(speed, 0.05f)
            speedLevel = 0f
        }

        private fun points(): List<Point> {
            val randomness = motion.minRandomness + (motion.maxRandomness - motion.minRandomness) * speedLevel
            val segment = 1f / (POINTS - 1)
            val rangeStart = 1f / (1f + randomness / 10f)
            return List(POINTS) { index ->
                when (index) {
                    0 -> Point(0f, 0f)
                    POINTS - 1 -> Point(1f, 0f)
                    else -> {
                        val pointOffset = (rangeStart + random.nextFloat() * (1f - rangeStart)) / 2f
                        Point(segment * index + segment - segment * pointOffset, (randomness * random.nextFloat() - randomness * 0.5f) * pointOffset)
                    }
                }
            }
        }
    }

    private val random = Random(seed)
    private val waves = MOTIONS.map { Wave(it) }

    /** The level last reported, 0..1, and the one drawn, which follows it. */
    var level = 0f
        private set
    var shownLevel = 0f
        private set

    /** How loud the call is now, from what it reported. 0 is silence. */
    fun update(level: Float) {
        val normalized = (level / MAX_LEVEL).coerceIn(0f, 1f)
        for (wave in waves) wave.speedLevel = max(wave.speedLevel, normalized)
        this.level = normalized
    }

    /** Moves the waves on by [delta] seconds. */
    fun advance(delta: Float) {
        val smoothing = LEVEL_SMOOTHING.pow(delta * 60f)
        shownLevel = shownLevel * smoothing + level * (1f - smoothing)
        for (wave in waves) wave.advance(delta)
    }

    /** The three crests, bottom to top, across [width], resting on [restY]. */
    fun crests(width: Float, restY: Float, flat: Boolean): List<Crest> = waves.map { wave ->
        if (flat) {
            val start = Point(0f, restY)
            val end = Point(width, restY)
            Crest(start, listOf(Segment(end, start, end)))
        } else {
            val (points, offset) = wave.current(shownLevel)
            smooth(points.map { Point(it.x * width, restY + it.y * amplitudePx + offset * scale) }, SMOOTHNESS)
        }
    }

    /** Pixels per unit of the iOS numbers (dp to px). */
    var scale = 1f
    private val amplitudePx get() = AMPLITUDE * scale

    companion object {
        const val SMOOTHNESS = 0.5f
        const val AMPLITUDE = 20f
        const val TRAVEL = 16f
        const val LEVEL_SMOOTHING = 0.93f
        const val MAX_LEVEL = 1.5f
        const val SPEED_MULTIPLIER = 0.85f
        const val POINTS = 6

        /** Bottom to top. */
        val MOTIONS = listOf(
            Motion(1.2f, 1.7f, 1.0f, 5.8f, 0.1f, 1.0f),
            Motion(1.2f, 1.5f, 1.0f, 4.4f, 0.1f, 0.55f),
            Motion(1.0f, 1.3f, 0.9f, 3.2f, 0.0f, 0.0f),
        )
        val ALPHAS = listOf(0.35f, 0.55f, 1f)

        /** How far below the bar a wave can reach, in dp (iOS's 29). */
        val OVERHANG: Float = run {
            val randomness = MOTIONS.maxOf { it.maxRandomness }
            val offset = MOTIONS.maxOf { it.maxOffset }
            ceil(AMPLITUDE * randomness * 0.25f * 1.3f + TRAVEL * offset) + 1f
        }

        fun smooth(points: List<Point>, smoothness: Float): Crest {
            fun tangent(index: Int): Point {
                val previous = points[max(index - 1, 0)]
                val next = points[min(index + 1, points.size - 1)]
                return Point((next.x - previous.x) / 2f, (next.y - previous.y) / 2f)
            }
            val segments = (1 until points.size).map { index ->
                val a = points[index - 1]
                val b = points[index]
                val ta = tangent(index - 1)
                val tb = tangent(index)
                Segment(b, Point(a.x + ta.x * smoothness, a.y + ta.y * smoothness), Point(b.x - tb.x * smoothness, b.y - tb.y * smoothness))
            }
            return Crest(points.first(), segments)
        }

        /** CSS ease-in-out, (0.42, 0, 0.58, 1), solved for x. */
        fun easeInOut(x: Float): Float {
            fun bezier(t: Float, p1: Float, p2: Float) = 3 * (1 - t) * (1 - t) * t * p1 + 3 * (1 - t) * t * t * p2 + t * t * t
            var low = 0f
            var high = 1f
            var t = x
            repeat(24) {
                t = (low + high) / 2
                if (bezier(t, 0.42f, 0.58f) < x) low = t else high = t
            }
            return bezier(t, 0f, 1f).let { if (abs(it) < 1e-6f) 0f else it }
        }
    }
}
