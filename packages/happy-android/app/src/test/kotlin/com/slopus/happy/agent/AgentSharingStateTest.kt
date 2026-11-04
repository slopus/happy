package com.slopus.happy.agent

import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Test

class AgentSharingStateTest {
    @Test fun absentUserSettingsAndOldProtocolsDoNotOfferUnsupportedWrites() {
        assertEquals(AgentSharingState.Loading, AgentSharingState.from(AgentCatalog(), 31))
        assertEquals(AgentSharingState.Unsupported, AgentSharingState.from(AgentCatalog().withBootstrap(AgentClient.json.decodeFromJsonElement(WireDesktopBootstrap.serializer(), Wire.bootstrap())), 31))
        val supported = AgentCatalog().withBootstrap(AgentClient.json.decodeFromJsonElement(WireDesktopBootstrap.serializer(), Wire.bootstrap(userSettings = emptyList())))
        assertEquals(AgentSharingState.Ready(true, null), AgentSharingState.from(supported, null))
        assertEquals(AgentSharingState.Ready(true, null), AgentSharingState.from(supported, 30))
        assertEquals(AgentSharingState.Ready(true, true), AgentSharingState.from(supported, 31))
    }

    @Test fun onlyBooleanFalseDisablesAutoJoinAndEnablingClearsTheOverride() {
        for (kind in AutoJoinKind.entries) {
            for (value in listOf(JsonNull, JsonPrimitive(true), JsonPrimitive("false"), JsonPrimitive(0))) {
                assertEquals(true, DesktopSettings.autoJoin(mapOf(kind.key to value), kind))
            }
            assertEquals(true, DesktopSettings.autoJoin(emptyMap(), kind))
            assertEquals(false, DesktopSettings.autoJoin(mapOf(kind.key to JsonPrimitive(false)), kind))
        }
        assertEquals(JsonNull, DesktopSettings.autoJoinValue(true))
        assertEquals(JsonPrimitive(false), DesktopSettings.autoJoinValue(false))
    }

    @Test fun pendingOfflineEditsOverrideBootstrapAndLiveChangesUntilAcknowledged() {
        val kind = AutoJoinKind.Tasks
        val catalog = AgentCatalog(loaded = true, userSettingsSupported = true)
            .withPendingSetting(kind.key, JsonPrimitive(false), "m1", 2)
            .withSetting(Wire.setting(kind.key, JsonNull, "02"))
        assertEquals(AgentSharingState.Ready(false, true), AgentSharingState.from(catalog, 31))
        val acknowledged = catalog.settingAcknowledged(kind.key, "m1", Wire.setting(kind.key, JsonPrimitive(false), "03"))
        assertEquals(AgentSharingState.Ready(false, true), AgentSharingState.from(acknowledged, 31))
        assertEquals(AgentSharingState.Ready(true, true), AgentSharingState.from(acknowledged.withSetting(Wire.setting(kind.key, JsonNull, "04")), 31))
    }
}