package com.slopus.happy.conversation.ui

import com.slopus.happy.conversation.Block
import com.slopus.happy.conversation.KeptConversation
import com.slopus.happy.conversation.Message
import com.slopus.happy.conversation.Presentation
import com.slopus.happy.conversation.Run
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.boolean
import kotlinx.serialization.json.int
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Chat UI and quick replies as read off the wire ([UiDocument],
 * [UiComponent], [UiActionRecord], [QuickReplies]), against the vendored
 * contract ([UiContract]): the client package's vectors, and the catalog's
 * own schemas for the types this build draws.
 */
class UiWireTest {
    private fun json(text: String): JsonObject = Json.parseToJsonElement(text).jsonObject

    /** The types this build draws; every other is its fallback line. */
    private val drawn = setOf(UiComponent.FileTree.TYPE, UiComponent.Media.TYPE, UiComponent.DefaultModel.TYPE)

    private fun component(type: String, props: String): UiComponent =
        UiComponent.parse(json("""{"id":"c","type":"$type","fallback":"A line","props":$props}"""))!!

    @Test fun `every vector's document reads, a component drawn only where its type is known here and its props fit`() {
        for (vector in UiContract.vectors("documents")) {
            val raw = vector.getValue("document").jsonObject
            val components = raw.getValue("components").jsonArray.map { it.jsonObject }
            val document = UiDocument.parse(raw)!!
            assertEquals(raw.getValue("id").jsonPrimitive.content, document.id)
            assertEquals(components.map { it.getValue("id").jsonPrimitive.content }, document.components.map { it.id })
            assertEquals(components.map { it.getValue("fallback").jsonPrimitive.content }, document.components.map { it.fallback })
            val fits = vector.getValue("drawn").jsonArray.map { it.jsonPrimitive.boolean }
            components.forEachIndexed { index, component ->
                val expected = fits[index] && component.getValue("type").jsonPrimitive.content in drawn
                assertEquals(component.toString(), expected, document.components[index] !is UiComponent.Other)
            }
        }
    }

    @Test fun `a known type's props are read exactly as its schema takes them`() {
        val long = "x".repeat(1025)
        val cases = mapOf(
            UiComponent.FileTree.TYPE to listOf(
                """{"paths":["src/app.ts","docs/"]}""",
                """{"paths":[]}""",
                """{"paths":[""]}""",
                """{"paths":["$long"]}""",
                """{"paths":["${long.dropLast(1)}"]}""",
                """{"paths":["a\u0007b"]}""",
                """{"paths":["a\u202eb"]}""",
                """{"paths":[1]}""",
                """{"paths":"src"}""",
                """{"paths":${(1..201).map { "\"f$it\"" }}}""",
                """{"paths":${(1..200).map { "\"f$it\"" }}}""",
                """{"paths":["a"],"entries":[]}""",
                """{}""",
            ),
            UiComponent.Media.TYPE to listOf(
                """{"items":[{"mediaIndex":0,"label":"Login"},{"mediaIndex":23}]}""",
                """{"items":[]}""",
                """{"items":[{"mediaIndex":24}]}""",
                """{"items":[{"mediaIndex":-1}]}""",
                """{"items":[{"mediaIndex":0.5}]}""",
                """{"items":[{"mediaIndex":"0"}]}""",
                """{"items":[{"label":"No index"}]}""",
                """{"items":[{"mediaIndex":0,"label":""}]}""",
                """{"items":[{"mediaIndex":0,"label":null}]}""",
                """{"items":[{"mediaIndex":0,"label":"${"x".repeat(81)}"}]}""",
                """{"items":[{"mediaIndex":0,"label":"${"x".repeat(80)}"}]}""",
                """{"items":[{"mediaIndex":0,"label":"right-to-left \u202e"}]}""",
                """{"items":[{"mediaIndex":0,"label":"two\nlines"}]}""",
                """{"items":[{"mediaIndex":0,"alt":"A cat"}]}""",
                """{"items":[{"mediaIndex":0}],"columns":2}""",
                """{"items":${(0..24).map { """{"mediaIndex":0}""" }}}""",
                """{"items":${(0..23).map { """{"mediaIndex":$it}""" }}}""",
                """{"images":[{"mediaIndex":0}]}""",
                """{}""",
            ),
            UiComponent.DefaultModel.TYPE to listOf("""{}""", """{"providerId":"claude"}"""),
        )
        assertEquals(drawn, cases.keys)
        for ((type, samples) in cases) {
            val schema = UiContract.component(type).getValue("props").jsonObject
            var fitting = 0
            for (props in samples) {
                val fits = UiContract.passes(schema, json(props))
                if (fits) fitting++
                assertEquals("$type $props", fits, component(type, props) !is UiComponent.Other)
            }
            assertTrue("$type: some samples fit and some don't", fitting in 1 until samples.size)
        }
        assertEquals(
            UiComponent.Media("c", "A line", listOf(UiComponent.Media.Item(0, "Login"), UiComponent.Media.Item(23, null))),
            component(UiComponent.Media.TYPE, cases.getValue(UiComponent.Media.TYPE).first()),
        )
        assertEquals(UiComponent.FileTree("c", "A line", listOf("src/app.ts", "docs/")), component(UiComponent.FileTree.TYPE, cases.getValue(UiComponent.FileTree.TYPE).first()))
    }

    @Test fun `a type this build doesn't know is its fallback line, and what is no component is left out`() {
        assertEquals(UiComponent.Other("c", "A line"), component("slideshow", """{"count":3}"""))
        // The catalog has it, and no stage 1 client draws it.
        assertEquals(UiComponent.Other("c", "A line"), component("provider_sign_in", """{"provider":"claude"}"""))
        assertEquals(UiComponent.Other("c", ""), UiComponent.parse(json("""{"id":"c","type":"file_tree"}""")))
        val document = UiDocument.parse(json("""{"id":"u1","components":[{"type":"file_tree","fallback":"No id","props":{"paths":["a"]}},7,{"id":"ok","type":"default_model","fallback":"The default model","props":{}}]}"""))
        assertEquals(UiDocument("u1", listOf(UiComponent.DefaultModel("ok", "The default model"))), document)
        assertNull(UiDocument.parse(json("""{"id":"u1","components":[]}""")))
        assertNull(UiDocument.parse(json("""{"components":[{"id":"ok","type":"default_model","fallback":"","props":{}}]}""")))
    }

    @Test fun `a block that doesn't read is skipped, never its message`() {
        val message = Message.parse(
            json(
                """{"id":"m1","role":"agent","createdAt":1,"metadata":{},"content":[
                {"type":"text","text":"Before."},
                {"type":"ui","ui":{"id":"u1"}},
                {"type":"quick_replies","options":["Same","Same"]},
                {"type":"action","messageId":"m0","uiId":"u0","componentId":"c","action":{"type":"default_model.set"},"outcome":{"status":"accepted"}},
                {"type":"tool_call","id":"c1","name":"show_ui","status":"completed","presentation":{"type":"ui","ui":{"components":[]},"items":[]}},
                {"type":"text","text":"After."}]}""",
            ),
        )!!
        assertEquals(
            listOf(Block.Text("Before."), Block.Unknown("ui"), Block.Unknown("quick_replies"), Block.Unknown("action"), Block.Text("After.")),
            message.content.filter { it !is Block.ToolCall },
        )
        val call = message.content.filterIsInstance<Block.ToolCall>().single()
        assertEquals("the call stays, with nothing to show", null, call.presentation)
    }

    @Test fun `a presentation's media items keep their places, one that doesn't read included`() {
        val shown = Presentation.parse(
            json(
                """{"type":"ui","ui":{"id":"u1","components":[{"id":"shots","type":"media","fallback":"2 images","props":{"items":[{"mediaIndex":1}]}}]},
                "items":[{"name":"no kind"},{"kind":"image","name":"b.png","mimeType":"image/png","size":10,"width":4,"height":3,"thumbhash":"1QcSHQRnh493V4dIh4eXh1h4kJUI"}]}""",
            ),
        ) as Presentation.Ui
        assertEquals(listOf(null, "b.png"), shown.items.map { it?.name })
    }

    @Test fun `an attempt record reads its offer, its action and how it stands, by every status of the schema`() {
        val outcome = UiContract.schema.getValue("wire").jsonObject.getValue("actionBlock").jsonObject.getValue("properties").jsonObject.getValue("outcome").jsonObject
        val statuses = outcome.getValue("properties").jsonObject.getValue("status").jsonObject.getValue("anyOf").jsonArray.map { it.jsonObject.getValue("const").jsonPrimitive.content }
        assertEquals(listOf("pending", "accepted", "rejected", "failed"), statuses)
        val read = statuses.associateWith { status ->
            val block = json("""{"type":"action","messageId":"m1","uiId":"u1","componentId":"model","action":{"type":"default_model.set","payload":{"modelId":"x"}},"outcome":{"status":"$status","code":"nope","reason":"Not now."}}""")
            assertTrue(UiContract.passes(UiContract.schema.getValue("wire").jsonObject.getValue("actionBlock").jsonObject, block))
            (Block.parse(block) as Block.Action).record
        }
        val record = read.getValue("rejected")
        assertEquals(UiOffer("m1", "u1", "model"), record.offer)
        assertEquals(UiAction("default_model.set", json("""{"modelId":"x"}""")), record.action)
        assertEquals(UiComponent.DefaultModel.TYPE, record.action.component)
        assertEquals("Not now.", record.outcome.reason)
        assertEquals(mapOf("pending" to true, "accepted" to false, "rejected" to false, "failed" to false), read.mapValues { it.value.outcome.pending })
        assertEquals(mapOf("pending" to false, "accepted" to false, "rejected" to true, "failed" to true), read.mapValues { it.value.outcome.refused })
    }

    @Test fun `quick replies are drawn only where the package finds no problem with them`() {
        for (vector in UiContract.vectors("quickReplies")) {
            val options = vector.getValue("normalized").jsonArray.map { it.jsonPrimitive.content }
            val passes = vector.getValue("problems").jsonArray.isEmpty()
            assertEquals(vector.toString(), passes, QuickReplies.valid(options))
            val block = json("""{"type":"quick_replies","options":${vector.getValue("normalized")}}""")
            assertEquals(vector.toString(), options.takeIf { passes }, QuickReplies.options(block))
        }
        assertNull(QuickReplies.options(json("""{"type":"quick_replies","options":["Yes",2]}""")))
        assertNull(QuickReplies.options(json("""{"type":"quick_replies"}""")))
        // The drawing an option may carry isn't read: the option is its words.
        assertEquals(listOf("Yes", "No"), QuickReplies.options(json("""{"type":"quick_replies","options":["Yes","No"],"ui":[{"type":"provider","props":{"provider":"claude"}},null]}""")))
    }

    @Test fun `quick replies' bounds are the schema's`() {
        val options = UiContract.schema.getValue("quickReplies").jsonObject.getValue("block").jsonObject.getValue("properties").jsonObject.getValue("options").jsonObject
        assertEquals(QuickReplies.MAX, options.getValue("maxItems").jsonPrimitive.int)
        assertEquals(QuickReplies.MAX_LENGTH, options.getValue("items").jsonObject.getValue("maxLength").jsonPrimitive.int)
        val reply = UiContract.schema.getValue("quickReplies").jsonObject.getValue("quickReply").jsonObject
        for (sent in listOf(QuickReply("m1", "c1", 5), QuickReply("m1", null, 0))) {
            assertTrue(sent.toString(), UiContract.passes(reply, sent.json()))
            assertEquals(sent, QuickReply.parse(sent.json()))
        }
        assertEquals("""{"messageId":"m1","toolCallId":"c1","index":5}""", QuickReply("m1", "c1", 5).json().toString())
        assertEquals("""{"messageId":"m1","index":0}""", QuickReply("m1", null, 0).json().toString())
        assertFalse(UiContract.passes(reply, json("""{"messageId":"m1","index":6}""")))
        assertNull(QuickReply.parse(json("""{"messageId":"m1","index":6}""")))
    }

    @Test fun `chat UI, attempt records and quick replies are kept on the phone exactly as they came`() {
        val messages = listOf(
            """{"id":"m0","role":"agent","createdAt":1,"metadata":{},"content":[{"type":"text","text":"Pick one."},
                {"type":"ui","ui":{"id":"u0","components":[{"id":"x","type":"slideshow","fallback":"3 pictures","props":{"count":3}},{"id":"model","type":"default_model","fallback":"The default model","props":{}}]}},
                {"type":"quick_replies","options":["Yes","No"],"ui":[null,null]}]}""",
            """{"id":"m1","role":"agent","createdAt":2,"metadata":{},"content":[
                {"type":"tool_call","id":"c1","name":"show_ui","status":"completed","presentation":{"type":"ui","ui":{"id":"u1","components":[{"id":"shots","type":"media","fallback":"1 image","props":{"items":[{"mediaIndex":0}]}}]},
                "items":[{"kind":"image","name":"a.png","mimeType":"image/png","size":10,"width":4,"height":3,"thumbhash":"1QcSHQRnh493V4dIh4eXh1h4kJUI"}]}},
                {"type":"tool_call","id":"c2","name":"suggest_replies","status":"completed","presentation":{"type":"quick_replies","options":["Merge it","Not now"]}}]}""",
            """{"id":"k1","role":"service","createdAt":3,"metadata":{},"content":[{"type":"action","messageId":"m0","uiId":"u0","componentId":"model",
                "action":{"type":"default_model.set","payload":{"providerId":"claude","modelId":"opus","effort":"high"}},"outcome":{"status":"rejected","code":"no_model","reason":"That model is off."}}]}""",
            """{"id":"p1","role":"user","status":"accepted","createdAt":4,"metadata":{},"content":[{"type":"text","text":"Not now"}],"quickReply":{"messageId":"m1","toolCallId":"c2","index":1}}""",
        ).map { Message.parse(json(it))!! }
        assertTrue(messages[0].content[1] is Block.Ui && messages[0].content[2] is Block.QuickReplies)
        assertTrue(messages[1].content.map { (it as Block.ToolCall).presentation }.let { it[0] is Presentation.Ui && it[1] is Presentation.QuickReplies })
        assertTrue(messages[2].content.single() is Block.Action)
        assertEquals(QuickReply("m1", "c2", 1), messages[3].quickReply)
        for (message in messages) assertEquals(message, Message.parse(KeptConversation.messageJson(message)))
    }

    @Test fun `a run says it is standalone with its kind, in history and when kept, and no other run is`() {
        val record = """{"id":"k1","role":"service","createdAt":3,"metadata":{},"content":[]}"""
        val standalone = Run.parse(json("""{"id":"r2","kind":"standalone","status":"completed","startedAt":3,"endedAt":3,"messages":[$record]}"""))!!
        assertTrue(standalone.standalone)
        for (turn in listOf("""{"id":"r1","status":"completed","startedAt":1,"endedAt":2,"messages":[]}""", """{"id":"r1","kind":"compaction","status":"completed","messages":[]}""")) {
            assertFalse(turn, Run.parse(json(turn))!!.standalone)
        }
        val kept = KeptConversation.parse(KeptConversation(listOf(standalone, Run("r3", "running", 4, emptyList())), emptyList(), false, null, null).json())!!
        assertEquals(listOf(true, false), kept.runs.map { it.standalone })
    }
}
