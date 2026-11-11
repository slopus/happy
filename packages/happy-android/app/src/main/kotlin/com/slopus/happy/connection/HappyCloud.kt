package com.slopus.happy.connection

import com.slopus.happy.BuildConfig

/**
 * Happy Cloud (accounts contract v1): the accounts service at its own
 * origin, [BuildConfig.HAPPY_CLOUD_ACCOUNTS], where the person signs in and
 * their servers are listed, and the servers under one domain,
 * [BuildConfig.HAPPY_CLOUD_BASE]: the server named `acme` is
 * `https://acme.BASE`. The person signs in to their account once, then
 * picks, creates or joins servers; the account gets each server's token
 * ([CloudAccount.serverToken]), and each server is kept as its own
 * connection. These addresses are the app's own, never typed or pasted, so
 * no code and no `instanceId` check them.
 */
object HappyCloud {
    /** BASE; null in release builds (`release`, and `bench`, which is release) and when the build's isn't a host. Null leaves out every way in. */
    val base: String? = BuildConfig.HAPPY_CLOUD_BASE.takeIf { offeredIn(BuildConfig.BUILD_TYPE) && serverOf(it, "x") != null }

    /** The accounts service, where the account signs in and servers are listed; null wherever [base] is. */
    val accounts: AgentOrigin? = base?.let { originOf(BuildConfig.HAPPY_CLOUD_ACCOUNTS) }

    /** The web app's domain, [BuildConfig.HAPPY_CLOUD_WEB]: the server named `acme`'s settings are under `https://acme.WEB/#/settings/`. */
    private val web: String = BuildConfig.HAPPY_CLOUD_WEB

    /**
     * [page] of [server]'s settings in the web app, for a settings link to
     * a page the phone hasn't; null for a server that isn't Happy Cloud's.
     */
    fun webSettings(server: String?, page: String, base: String? = this.base, web: String = this.web): String? =
        handle(server, base)?.let { "https://${it.removePrefix("@")}.$web/#/settings/$page" }

    /** Only the dev (`debug`) and `preview` builds offer Happy Cloud. */
    internal fun offeredIn(buildType: String): Boolean = buildType == "debug" || buildType == "preview"

    internal fun originOf(url: String): AgentOrigin? = try {
        ServerAuthClient.parseAddress(url)
    } catch (_: ServerAuthException) {
        null
    }

    /** The server named [name] under [base]; null when that isn't an origin. */
    internal fun serverOf(base: String, name: String): AgentOrigin? = try {
        ServerAuthClient.parseAddress("https://$name.$base/").takeIf { it.host == "$name.$base" }
    } catch (_: ServerAuthException) {
        null
    }

    /** Whether [server], an origin, is a Happy Cloud server: a host directly under BASE. */
    fun isServer(server: String?, base: String? = this.base): Boolean {
        if (server == null || base == null) return false
        val origin = runCatching { AgentOrigin.parse(server) }.getOrNull() ?: return false
        val name = origin.host.removeSuffix(".$base").takeIf { it != origin.host } ?: return false
        return origin.port == 443 && name.isNotEmpty() && '.' !in name
    }

    /**
     * How a person reads a Happy Cloud server's address: `@name`, like a
     * username, until Happy Cloud has its own domain (accounts contract,
     * Display). Null for any other server, which shows its host.
     */
    fun handle(server: String?, base: String? = this.base): String? = serverName(server, base)?.let { "@$it" }

    /**
     * A Happy Cloud server's bare name (`acme`), what its placeholder
     * picture is picked by on every client (desktop's rail, both phones'
     * server lists and account menus). Null for any other server.
     */
    fun serverName(server: String?, base: String? = this.base): String? =
        if (isServer(server, base)) AgentOrigin.parse(server!!).host.removeSuffix(".$base") else null

    /** This person's connection to [server] already on the phone, if any: the open one first, else the oldest. */
    fun connection(accounts: List<AgentConnection>, server: String, open: String? = null): AgentConnection? =
        accounts.filter { it.server == server }.let { here -> here.firstOrNull { it.id == open } ?: here.minByOrNull { it.addedAt } }
}
