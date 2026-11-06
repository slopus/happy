package com.slopus.happy.connection

import com.slopus.happy.BuildConfig

/**
 * Happy Cloud: a team server with agents but no compute (no nodes,
 * workspaces, terminals or projects), at the one address compiled into the
 * app ([BuildConfig.HAPPY_CLOUD_URL]). It is the only team server a phone
 * adds without a scanned code (edge SSO §8): the address is the app's own,
 * never typed or pasted, so there is no code and no `instanceId` to check
 * it against. Health's `instanceId` is still kept on the connection.
 */
object HappyCloud {
    /**
     * The cloud's origin; null in release builds (`release`, and `bench`,
     * which is release), where it isn't offered yet, and when this build's
     * address isn't one (a path prefix, `http:`). Null leaves out every way in.
     */
    val origin: AgentOrigin? = of(BuildConfig.HAPPY_CLOUD_URL).takeIf { offeredIn(BuildConfig.BUILD_TYPE) }

    /** Only the dev (`debug`) and `preview` builds offer Happy Cloud. */
    internal fun offeredIn(buildType: String): Boolean = buildType == "debug" || buildType == "preview"

    internal fun of(url: String): AgentOrigin? = try {
        ServerAuthClient.parseAddress(url)
    } catch (_: ServerAuthException) {
        null
    }

    /** Whether [connection] is a Happy Cloud team, which has no compute. */
    fun isCloud(connection: AgentConnection?): Boolean = connection?.server != null && connection.server == origin?.value

    /** The connection already on the cloud, if any: the open one first, else the oldest. */
    fun connection(accounts: List<AgentConnection>, open: String? = null): AgentConnection? =
        accounts.filter(::isCloud).let { cloud -> cloud.firstOrNull { it.id == open } ?: cloud.minByOrNull { it.addedAt } }
}
