package com.slopus.happy.connection

import com.slopus.happy.BuildConfig

/**
 * Happy Cloud (accounts contract v1): one domain, [BuildConfig.HAPPY_CLOUD_BASE],
 * under which the accounts service is `https://accounts.BASE` and the server
 * named `acme` is `https://acme.BASE`. The person signs in to their account
 * once, then picks, creates or joins servers; each server is a team server
 * signed in to as any other, and kept as its own connection. These addresses
 * are the app's own, never typed or pasted, so no code and no `instanceId`
 * check them.
 */
object HappyCloud {
    /** BASE; null in release builds (`release`, and `bench`, which is release) and when the build's isn't a host. Null leaves out every way in. */
    val base: String? = BuildConfig.HAPPY_CLOUD_BASE.takeIf { offeredIn(BuildConfig.BUILD_TYPE) && accountsOf(it) != null }

    /** The accounts service, where the account signs in and servers are listed. */
    val accounts: AgentOrigin? = base?.let(::accountsOf)

    /** Only the dev (`debug`) and `preview` builds offer Happy Cloud. */
    internal fun offeredIn(buildType: String): Boolean = buildType == "debug" || buildType == "preview"

    internal fun accountsOf(base: String): AgentOrigin? = serverOf(base, "accounts")

    /** The server named [name] under [base]; null when that isn't an origin. */
    internal fun serverOf(base: String, name: String): AgentOrigin? = try {
        ServerAuthClient.parseAddress("https://$name.$base/").takeIf { it.host == "$name.$base" }
    } catch (_: ServerAuthException) {
        null
    }

    /** Whether [server], an origin, is a Happy Cloud server: a host directly under BASE, other than the accounts service. */
    fun isServer(server: String?, base: String? = this.base): Boolean {
        if (server == null || base == null) return false
        val origin = runCatching { AgentOrigin.parse(server) }.getOrNull() ?: return false
        val name = origin.host.removeSuffix(".$base").takeIf { it != origin.host } ?: return false
        return origin.port == 443 && name.isNotEmpty() && '.' !in name && name != "accounts"
    }

    /**
     * How a person reads a Happy Cloud server's address: `@name`, like a
     * username, until Happy Cloud has its own domain (accounts contract,
     * Display). Null for any other server, which shows its host.
     */
    fun handle(server: String?, base: String? = this.base): String? =
        if (isServer(server, base)) "@" + AgentOrigin.parse(server!!).host.removeSuffix(".$base") else null

    /** This person's connection to [server] already on the phone, if any: the open one first, else the oldest. */
    fun connection(accounts: List<AgentConnection>, server: String, open: String? = null): AgentConnection? =
        accounts.filter { it.server == server }.let { here -> here.firstOrNull { it.id == open } ?: here.minByOrNull { it.addedAt } }
}
