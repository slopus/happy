package com.slopus.happy.conversation

import com.slopus.happy.ui.conversation.PickerKeys
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** iOS ModelFilterTests and StemCellModelPickersTests (e2238fdc4, 083c30df4). */
class ModelMenusTest {
    private val catalog = ModeCatalog.parse(
        Json.parseToJsonElement(
            """{"config":{
            "defaults":{"providerId":"claude","modelId":"opus","permissionMode":"auto"},
            "models":{
                "opus":{"name":"Opus","efforts":["low","high"],"defaultEffort":"high"},
                "haiku":{"name":"Haiku","efforts":[],"defaultEffort":"low"},
                "sol":{"name":"Sol","efforts":["low","medium","high"],"defaultEffort":"medium"},
                "luna":{"name":"Luna","efforts":["low"],"defaultEffort":"low"},
                "grok":{"name":"Grok","efforts":["high"],"defaultEffort":"high"},
                "gone":{"name":"Gone Model","efforts":["low"],"defaultEffort":"low"}
            },
            "providers":{
                "claude":{"name":"Current CLI","type":"claude","enabled":true,"hidden":false,"models":[{"id":"opus","enabled":true},{"id":"haiku","enabled":true,"hidden":true}]},
                "work":{"name":"Work","type":"claude","enabled":true,"hidden":false,"models":[{"id":"opus","enabled":true}]},
                "codex":{"type":"codex","enabled":true,"hidden":false,"models":[{"id":"sol","enabled":true},{"id":"luna","enabled":false}]},
                "secret":{"type":"codex","enabled":true,"hidden":true,"models":[{"id":"sol","enabled":true}]},
                "grok":{"type":"grok","enabled":false,"hidden":false,"models":[{"id":"grok","enabled":true}]}
            }}}""",
        ).jsonObject,
    )
    private fun mode(provider: String, model: String, effort: String = "high") = Mode(provider, model, effort, null, "auto")

    @Test fun `the catalog keeps every account, switched-on models, and those hidden`() {
        assertEquals(listOf("claude", "work", "codex", "secret", "grok"), catalog.providers.map { it.id })
        assertEquals(setOf("haiku"), catalog.provider("claude")!!.hiddenModels)
        assertEquals(listOf("sol"), catalog.provider("codex")!!.models.map { it.modelId })
        assertTrue(catalog.provider("grok")!!.isDisabled)
        // What a message can run with: shown, switched-on accounts only.
        assertEquals(listOf("claude/opus", "claude/haiku", "work/opus", "codex/sol"), catalog.models.map { "${it.providerId}/${it.modelId}" })
    }

    @Test fun `services group accounts by type, hidden accounts and models stay out unless selected`() {
        val menus = ModelMenus.of(catalog, mode("claude", "opus"))
        assertEquals(listOf("claude", "codex", "grok"), menus.services.map { it.id })
        assertEquals(listOf("Claude", "Codex", "Grok"), menus.services.map { it.label })
        assertEquals(listOf("claude", "work"), menus.services[0].accounts.map { it.id })
        // The hidden model and the hidden account aren't offered.
        assertEquals(listOf("opus"), menus.services[0].shown!!.models.map { it.id })
        assertEquals(listOf("codex"), menus.services[1].accounts.map { it.id })
        // A switched-off account is listed, its models not to be picked.
        assertTrue(menus.services[2].shown!!.models.single().disabled)
        assertNull(menus.notice)
        assertTrue(menus.listsSelection)
        assertEquals(listOf("claude", "work", "codex", "grok"), menus.listedAccounts)

        // On the hidden model, it stays in its own list.
        val onHidden = ModelMenus.of(catalog, mode("claude", "haiku"))
        assertEquals(listOf("opus", "haiku"), onHidden.services[0].shown!!.models.map { it.id })
        assertNull(onHidden.effort.takeIf { onHidden.current!!.efforts.isNotEmpty() })
    }

    @Test fun `a selection the lists don't offer is named, with why`() {
        val hidden = ModelMenus.of(catalog, mode("secret", "sol"))
        assertEquals(ModelMenus.Notice.Hidden, hidden.notice)
        assertEquals("Sol", hidden.current!!.name)
        assertFalse(hidden.listsSelection)
        assertEquals(ModelMenus.Notice.Off("grok"), ModelMenus.of(catalog, mode("grok", "grok")).notice)
        val removed = ModelMenus.of(catalog, mode("old", "gone"))
        assertEquals(ModelMenus.Notice.Removed("old"), removed.notice)
        assertEquals("Gone Model", removed.current!!.name)
        assertEquals(listOf("claude", "work", "codex", "grok", "old"), removed.listedAccounts)
    }

    @Test fun `a service lists the selected account, else the first that is on`() {
        assertEquals("work", ModelMenus.of(catalog, mode("work", "opus")).services[0].account)
        assertEquals("claude", ModelMenus.of(catalog, mode("codex", "sol")).services[0].account)
    }

    @Test fun `another model runs at its own effort, an account keeps the model and the effort it can`() {
        val current = mode("claude", "opus", "low")
        // Same model: the effort stays.
        assertEquals(current, catalog.pick(current, "claude", "opus"))
        // Another: its own default, never one carried over.
        assertEquals(mode("codex", "sol", "medium"), catalog.pick(current, "codex", "sol"))
        // A switched-off account can't serve it.
        assertEquals(current, catalog.pick(current, "grok", "grok"))
        // An account switched keeps the model and the effort when it runs them.
        val menus = ModelMenus.of(catalog, current)
        val work = menus.services[0].accounts[1]
        assertEquals("opus", menus.model(work)!!.id)
        assertEquals(mode("work", "opus", "low"), catalog.pick(current, work.id, "opus", effort = current.effort))
        // The effort shown is the model's default when the selection's isn't one it runs.
        assertEquals("high", ModelMenus.of(catalog, mode("claude", "opus", "xhigh")).effort)
    }

    /** desktop's `tierConfig`: one model on two accounts, each reference with its own speed menu. */
    private fun tiers(eligible: Boolean = true): ModeCatalog {
        val astraMenu = if (eligible) ASTRA_MENU else REGULAR_ONLY
        return ModeCatalog.parse(
            Json.parseToJsonElement(
                """{"config":{
                "defaults":{"providerId":"codex","modelId":"astra","permissionMode":"auto"},
                "models":{
                    "astra":{"name":"GPT-6 Astra","efforts":["low","medium","high"],"defaultEffort":"medium","serviceTiers":["priority","ultrafast"],
                        "serviceTierOptions":[{"id":null,"label":"Regular"},{"id":"priority","label":"Fast"},{"id":"ultrafast","label":"Ultrafast"}]},
                    "sol":{"name":"GPT-6.1 Sol","efforts":["low","medium","high"],"defaultEffort":"medium","serviceTiers":["priority"],
                        "serviceTierOptions":[{"id":null,"label":"Regular"},{"id":"priority","label":"Fast"}]},
                    "old":{"name":"Older daemon","efforts":["low"],"defaultEffort":"low","serviceTiers":["priority"]}
                },
                "providers":{
                    "codex":{"type":"codex","enabled":true,"models":[
                        {"id":"astra","enabled":true,"serviceTierOptions":$astraMenu},
                        {"id":"sol","enabled":true},
                        {"id":"old","enabled":true}
                    ]},
                    "codex_other":{"type":"codex","enabled":true,"models":[{"id":"astra","enabled":true,"serviceTiers":[],"serviceTierOptions":[{"id":null,"label":"Regular"}]}]}
                }}}""",
            ).jsonObject,
        )
    }

    @Test fun `the speed menu is the daemon's, in its order and words, the account's own over the definition's`() {
        val catalog = tiers()
        val astra = ModelMenus.of(catalog, Mode("codex", "astra", "high", null, "auto"))
        assertTrue(astra.offersSpeed)
        assertEquals(listOf(null, "priority", "ultrafast"), astra.speeds.map { it.id })
        assertEquals(listOf("Regular", "Fast", "Ultrafast"), astra.speeds.map { it.label })
        assertEquals("Regular", astra.speed?.label)
        // Ultrafast is its own choice, never Fast.
        assertEquals("Ultrafast", ModelMenus.of(catalog, Mode("codex", "astra", "high", "ultrafast", "auto")).speed?.label)
        // The same model on an account whose menu is Regular alone: no choice.
        assertFalse(ModelMenus.of(catalog, Mode("codex_other", "astra", "high", null, "auto")).offersSpeed)
        // An older daemon sends no menu: none is made up from `serviceTiers`.
        val old = ModelMenus.of(catalog, Mode("codex", "old", "low", "priority", "auto"))
        assertFalse(old.offersSpeed)
        assertTrue(old.speeds.isEmpty())
        // A tier the menu doesn't offer reads as Regular.
        assertEquals("Regular", ModelMenus.of(catalog, Mode("codex", "sol", "high", "ultrafast", "auto")).speed?.label)
    }

    @Test fun `a speed pick sends its id unchanged, and another model or account drops one it doesn't offer`() {
        val catalog = tiers()
        val regular = Mode("codex", "astra", "high", null, "auto")
        val ultrafast = regular.copy(serviceTier = "ultrafast")
        val menus = ModelMenus.of(catalog, regular)
        assertEquals(ultrafast, PickerKeys.pick(PickerKeys.speed("ultrafast"), menus, catalog))
        assertEquals(regular.copy(serviceTier = "priority"), PickerKeys.pick(PickerKeys.speed("priority"), menus, catalog))
        assertEquals(regular, PickerKeys.pick(PickerKeys.speed(null), ModelMenus.of(catalog, ultrafast), catalog))
        assertEquals(ultrafast, catalog.pick(ultrafast, "codex", "astra"))
        assertNull(catalog.pick(ultrafast, "codex", "sol").serviceTier)
        assertEquals("priority", catalog.pick(regular.copy(serviceTier = "priority"), "codex", "sol").serviceTier)
        assertNull(catalog.pick(ultrafast, "codex_other", "astra").serviceTier)
    }

    @Test fun `a speed the account no longer offers is dropped, the rest of the mode kept`() {
        val ultrafast = Mode("codex", "astra", "high", "ultrafast", "auto")
        assertEquals(ultrafast, tiers().reconcileTier(ultrafast))
        val revoked = tiers(eligible = false)
        assertEquals(ultrafast.copy(serviceTier = null), revoked.reconcileTier(ultrafast))
        assertFalse(ModelMenus.of(revoked, ultrafast).offersSpeed)
    }

    private companion object {
        const val ASTRA_MENU = """[{"id":null,"label":"Regular"},{"id":"priority","label":"Fast"},{"id":"ultrafast","label":"Ultrafast"}]"""
        const val REGULAR_ONLY = """[{"id":null,"label":"Regular"}]"""
    }
}
