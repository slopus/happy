package com.slopus.happy.text

import android.content.Context
import android.content.res.Configuration
import android.content.res.Resources
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.boolean
import kotlinx.serialization.json.int
import kotlinx.serialization.json.intOrNull
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import java.io.File
import java.security.MessageDigest
import java.util.Locale

/**
 * The generated resources against happy-app's catalogs, through
 * translation-vectors.json (tools/translations/generate.mjs): every
 * _default.ts key has its resource, every English string reads back as the
 * catalog says, and every catalog function's sampled outputs in every
 * language are what the resources render for the same arguments.
 */
@RunWith(AndroidJUnit4::class)
class TranslationResourcesTest {
    private val context = ApplicationProvider.getApplicationContext<Context>()
    private val fixture = Json.parseToJsonElement(
        requireNotNull(javaClass.classLoader?.getResource("translation-vectors.json")).readText(),
    ).jsonObject
    private val keys = fixture.getValue("keys").jsonObject

    /** _all.ts's languages and the locale each one's resources serve. */
    private val locales = mapOf(
        "en" to "en", "ru" to "ru", "pl" to "pl", "es" to "es", "it" to "it", "pt" to "pt", "ca" to "ca",
        "zh-Hans" to "zh-Hans", "zh-Hant" to "zh-Hant", "ja" to "ja",
    )

    private fun resources(tag: String): Resources {
        val configuration = Configuration(context.resources.configuration).apply { setLocale(Locale.forLanguageTag(tag)) }
        return context.createConfigurationContext(configuration).resources
    }

    private fun id(name: String, type: String): Int = context.resources.getIdentifier(name, type, context.packageName)

    @Test
    fun catalogsAreTheOnesTheResourcesCameFrom() {
        val text = File("../../happy-app/sources/text")
        for ((file, hash) in fixture.getValue("sources").jsonObject) {
            val actual = MessageDigest.getInstance("SHA-256").digest(text.resolve(file).readBytes()).joinToString("") { "%02x".format(it) }
            assertEquals("$file changed: run tools/translations/generate.mjs", hash.jsonPrimitive.content, actual)
        }
    }

    @Test
    fun everyDefaultKeyHasAResource() {
        assertTrue(keys.size > 800)
        for ((key, info) in keys) {
            val entry = info.jsonObject
            val name = entry.getValue("name").jsonPrimitive.content
            when (entry.getValue("kind").jsonPrimitive.content) {
                "plural" -> assertNotEquals(key, 0, id(name, "plurals"))
                "cases" -> for (case in entry.getValue("cases").jsonObject.values) assertNotEquals(key, 0, id(case.jsonPrimitive.content, "string"))
                else -> assertNotEquals(key, 0, id(name, "string"))
            }
        }
    }

    @Test
    fun englishStringsReadBackAsTheCatalogSays() {
        val res = resources("en")
        for ((key, info) in keys) {
            val entry = info.jsonObject
            if (entry.getValue("kind").jsonPrimitive.content != "string") continue
            val name = entry.getValue("name").jsonPrimitive.content
            assertEquals(key, entry.getValue("value").jsonPrimitive.content, res.getString(id(name, "string")))
        }
    }

    @Test
    fun functionsRenderAsTheCatalogsDoInEveryLanguage() {
        val vectors = fixture.getValue("vectors").jsonObject
        assertEquals(locales.keys, vectors.keys)
        for ((language, tag) in locales) {
            val res = resources(tag)
            for (vector in vectors.getValue(language).jsonArray) {
                val v = vector.jsonObject
                val key = v.getValue("key").jsonPrimitive.content
                val args = v.getValue("args").jsonObject
                val expected = v.getValue("output").jsonPrimitive.content
                assertEquals("$language $key $args", expected, render(res, key, args))
            }
        }
    }

    private fun render(res: Resources, key: String, args: JsonObject): String {
        val entry = keys.getValue(key).jsonObject
        val name = entry.getValue("name").jsonPrimitive.content
        val format = entry.getValue("params").jsonArray.map { argument(args.getValue(it.jsonPrimitive.content).jsonPrimitive) }.toTypedArray()
        return when (entry.getValue("kind").jsonPrimitive.content) {
            "plural" -> {
                val count = args.getValue(entry.getValue("p").jsonPrimitive.content).jsonPrimitive.int
                res.plural(id(name, "plurals"), count, *format)
            }
            "cases" -> {
                val chosen = args.getValue(entry.getValue("p").jsonPrimitive.content).jsonPrimitive.content
                val case = entry.getValue("cases").jsonObject.getValue(chosen).jsonPrimitive.content
                res.getString(id(case, "string"), *format)
            }
            else -> res.getString(id(name, "string"), *format)
        }
    }

    private fun argument(value: JsonPrimitive): Any = if (value.isString) value.content else value.intOrNull ?: value.boolean
}
