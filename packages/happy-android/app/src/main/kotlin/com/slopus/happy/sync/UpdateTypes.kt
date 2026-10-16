package com.slopus.happy.sync

import kotlinx.serialization.Serializable
import kotlinx.serialization.json.JsonObject

// What the `/v1/updates` socket delivers, as happy-server's eventRouter.ts
// builds it today (apiTypes.ts ApiUpdateContainerSchema and the ephemeral
// schemas on the app side). Encrypted fields are base64 strings.

/** An `update` event: a durable change, numbered by the account's update seq. */
@Serializable
data class ApiUpdateContainer(val id: String, val seq: Long, val body: JsonObject, val createdAt: Long)

@Serializable
data class ApiNewMessageUpdate(val sid: String, val message: ApiMessage)

/** A new value of one encrypted document and the version it got. A null value clears it. */
@Serializable
data class ApiVersionedValue(val version: Long, val value: String? = null)

/**
 * `update-session`. `projectId` is three-state on the wire (absent, null,
 * set), so the handler reads it from the raw body.
 */
@Serializable
data class ApiSessionUpdate(
    val id: String,
    val metadata: ApiVersionedValue? = null,
    val agentState: ApiVersionedValue? = null,
)

@Serializable
data class ApiDeleteSessionUpdate(val sid: String)

/** `new-machine` carries the whole record, data key included (buildNewMachineUpdate). */
@Serializable
data class ApiNewMachineUpdate(
    val machineId: String,
    val seq: Long,
    val metadata: String,
    val metadataVersion: Long,
    val daemonState: String? = null,
    val daemonStateVersion: Long,
    val dataEncryptionKey: String? = null,
    val active: Boolean,
    val activeAt: Long,
    val createdAt: Long,
    val updatedAt: Long,
)

@Serializable
data class ApiMachineUpdate(
    val machineId: String,
    val metadata: ApiVersionedValue? = null,
    val daemonState: ApiVersionedValue? = null,
    val active: Boolean? = null,
    val activeAt: Long? = null,
)

@Serializable
data class ApiDeleteMachineUpdate(val machineId: String)

/** `update-account`. Profile fields are three-state too; the handler reads them from the raw body. */
@Serializable
data class ApiAccountUpdate(val id: String, val settings: ApiVersionedValue? = null)

// Ephemerals: presence and usage, never stored.

@Serializable
data class ApiActivityEphemeral(val id: String, val active: Boolean, val activeAt: Long, val thinking: Boolean = false)

@Serializable
data class ApiMachineActivityEphemeral(val id: String, val active: Boolean, val activeAt: Long)

@Serializable
data class ApiUsageTokens(
    val total: Double,
    val input: Double,
    val output: Double,
    @kotlinx.serialization.SerialName("cache_creation") val cacheCreation: Double,
    @kotlinx.serialization.SerialName("cache_read") val cacheRead: Double,
)

@Serializable
data class ApiUsageCost(val total: Double, val input: Double, val output: Double)

@Serializable
data class ApiUsageEphemeral(
    val id: String,
    val key: String,
    val timestamp: Long,
    val tokens: ApiUsageTokens,
    val cost: ApiUsageCost,
)
