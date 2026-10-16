package com.slopus.happy.chat

import com.slopus.happy.net.HappyJson
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonElement
import org.junit.Assert.assertEquals
import org.junit.Test

/**
 * [prettyJson] is JSON.stringify(value, null, 2), the one printer behind the
 * tool views (ToolView, ToolFullView), the session info dumps and both
 * "Copy session metadata" actions. It replaced four copies that had the same
 * two-space configuration; one of them (the session menu's) inherited
 * HappyJson, whose options only affect decoding. The output must stay byte
 * for byte what each of them printed: nested objects, arrays, escaped
 * strings and numbers.
 */
class PrettyJsonTest {
    private val sample = """
        {"name":"Bash","input":{"command":"echo \"hi\"\n\ttab","paths":["a\\b","ü/€",""]},
         "numbers":[1,-2.5,1e21,0.1,12345678901234567890],"flags":{"done":true,"error":null},
         "nested":[[{"deep":{"deeper":[1,{"k":"v"}]}}]],"unicode":"\u0001 </script>"}
    """.trimIndent()

    private val element = Json.parseToJsonElement(sample)

    /** The four printers as they were before [prettyJson] replaced them. */
    private val former = mapOf(
        "ToolView / ToolFullView / SessionInfoJson" to Json { prettyPrint = true; prettyPrintIndent = "  " },
        "SessionMenus" to Json(HappyJson) { prettyPrint = true; prettyPrintIndent = "  " },
    )

    @Test
    fun printsWhatEveryFormerCopyPrinted() {
        val printed = prettyJson(element)
        former.forEach { (name, json) ->
            assertEquals(name, json.encodeToString(JsonElement.serializer(), element), printed)
        }
    }

    @Test
    fun twoSpaceIndentNumbersAndEscapes() {
        val printed = prettyJson(Json.parseToJsonElement("""{"a":{"b":[1,2.50,"x\"y\n"]},"c":null}"""))
        assertEquals(
            """
            {
              "a": {
                "b": [
                  1,
                  2.5,
                  "x\"y\n"
                ]
              },
              "c": null
            }
            """.trimIndent(),
            printed,
        )
    }
}
