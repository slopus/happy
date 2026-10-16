package com.slopus.happy.model

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File
import kotlin.random.Random

class BotFaceTest {
    private val style = BotFaceStyle.parse(File("src/main/assets/$BOT_FACE_STYLE_ASSET").readText())

    /**
     * @dicebear/core 10.7.0 with @dicebear/styles 10.6.0 Adventurer Neutral,
     * `new Avatar(style, { seed }).toJSON().options`, in node: the same seed
     * must wear the same face here as on happy-app and the desktop.
     */
    @Test
    fun aSeedResolvesToTheFaceDiceBearDraws() {
        val reference = listOf(
            listOf("abc12345", "#f2d3b1", "variant21", "variant10", "variant23", null),
            listOf("k3j9x0aa", "#9e5622", "variant10", "variant06", "variant15", null),
            listOf("zzzzzzzz", "#763900", "variant25", "variant03", "variant10", null),
            listOf("0", "#f2d3b1", "variant26", "variant08", "variant15", null),
            listOf("happy", "#9e5622", "variant15", "variant15", "variant02", "variant01"),
            listOf("q1w2e3r4", "#f2d3b1", "variant10", "variant06", "variant27", null),
            listOf("glasses?", "#f2d3b1", "variant25", "variant07", "variant18", null),
            listOf("bot-face", "#9e5622", "variant11", "variant07", "variant17", null),
        )
        for ((seed, background, eyes, eyebrows, mouth, glasses) in reference.map { it.toTypedArray() }) {
            val face = resolveBotFace(style, seed!!)
            val variants = face.parts.associate { it.component to it.variant }
            assertEquals("$seed background", background, face.background)
            assertEquals("$seed eyes", eyes, variants["eyes"])
            assertEquals("$seed eyebrows", eyebrows, variants["eyebrows"])
            assertEquals("$seed mouth", mouth, variants["mouth"])
            assertEquals("$seed glasses", glasses, variants["glasses"])
        }
    }

    @Test
    fun theCanvasPlacesThePartsInItsOrder() {
        val face = resolveBotFace(style, "happy")
        assertEquals(400f, face.width)
        assertEquals(listOf("eyes", "eyebrows", "mouth", "glasses"), face.parts.map { it.component })
        assertEquals(36.7f to 101.2f, face.parts[0].x to face.parts[0].y)
        assertEquals("#ffffff", face.colors["sclera"])
        assertEquals("Lisa Wischofsky", style.artist)
        assertTrue(style.artistUrl.startsWith("https://"))
    }

    @Test
    fun fourFreshSeedsOfEightCharacters() {
        val seeds = rollBotFaceSeeds(Random(1))
        assertEquals(BOT_FACE_COUNT, seeds.size)
        assertTrue(seeds.all { it.length == 8 && it.all { c -> c.isDigit() || c in 'a'..'z' } })
        assertEquals(4, seeds.distinct().size)
    }

    /** botName.ts: the composer refuses a name before a request is spent on it. */
    @Test
    fun aBotNameIsWhatTheDaemonAccepts() {
        assertEquals("Release Bot", sanitizeBotName("Release\nBot"))
        assertEquals(BOT_NAME_MAX_LENGTH, sanitizeBotName("x".repeat(300)).length)
        assertTrue(isValidBotName("  Ada "))
        assertFalse(isValidBotName("   "))
        assertEquals("Give the bot a name", describeBotNameProblem(" "))
        assertEquals("A bot's name is at most 256 characters", describeBotNameProblem("x".repeat(257)))
        assertEquals("A bot's name cannot contain line breaks or control characters", describeBotNameProblem("a\u0007b"))
        assertNull(describeBotNameProblem("Ada"))
    }

    private operator fun <T> Array<T>.component6() = this[5]
}
