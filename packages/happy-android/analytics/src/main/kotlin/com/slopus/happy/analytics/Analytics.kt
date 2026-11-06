package com.slopus.happy.analytics

import android.app.ActivityManager
import android.content.Context
import android.content.SharedPreferences
import android.os.Build
import android.util.Log
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharingStarted
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.collectLatest
import kotlinx.coroutines.flow.combine
import kotlinx.coroutines.flow.stateIn
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import okhttp3.OkHttpClient
import java.io.File
import java.util.UUID
import kotlin.coroutines.CoroutineContext

/**
 * The facade the app calls, and all it calls: [start] once, then [record],
 * [errorShown] and [failureShown] with the typed events. Only a build that
 * sends ([AnalyticsTarget.of]) ever starts a client: never a test or a
 * build without a PostHog key, and a debug build only toward a local
 * capture endpoint. Until then, without one, and while analytics isn't
 * allowed, every call does nothing.
 */
object Analytics {
    @Volatile private var client: AnalyticsClient? = null

    /**
     * Keeps and sends this build's events toward [target] from now on,
     * only while [switch] is on and [accountsOptedOut] is false: null until
     * the app has read every signed-in account's opt-out, which records
     * nothing meanwhile. [agent] and [configuration] are read as each event
     * is made; [links] and [network] feed `agent_connection_lost` while
     * analytics is on. [flags] is told the PostHog flags on for this
     * install, and nothing (an empty set) whenever analytics is off.
     */
    fun start(
        context: Context,
        target: AnalyticsTarget,
        switch: AnalyticsSwitch,
        accountsOptedOut: Flow<Boolean?>,
        scope: CoroutineScope,
        http: OkHttpClient,
        foreground: StateFlow<Boolean>,
        agent: () -> AnalyticsAgent,
        configuration: () -> AnalyticsEvent.AppOpened.Configuration,
        links: Flow<ConnectionIncidents.Link?>,
        network: Flow<Boolean>,
        flags: (Set<String>) -> Unit,
    ) {
        val manager = context.getSystemService(ActivityManager::class.java)
        val consent = combine(switch.on, accountsOptedOut) { on, out -> if (!on) false else out?.not() }
            .stateIn(scope, SharingStarted.Eagerly, null)
        val client = AnalyticsClient(
            scope = scope,
            prefs = switch.prefs,
            posthog = PostHog(http, target.apiKey, target.host),
            consent = consent,
            foreground = foreground,
            device = AnalyticsDevice.of(context, target),
            agent = agent,
            configuration = configuration,
            links = links,
            network = network,
            crash = { manager?.let { AppExits.last(it, context.packageName) } },
            mark = { version -> manager?.let { AppExits.mark(it, version) } },
            flags = flags.takeIf { target.asksFlags },
        )
        this.client = client
        client.start()
        scope.launch(Dispatchers.IO) { Retired.delete(context, switch.prefs) }
    }

    fun record(event: AnalyticsEvent) {
        client?.record(event)
    }

    /** An error a person saw; at most once per (area, code) every ten minutes. */
    fun errorShown(area: ErrorArea, code: ErrorCode) {
        client?.errorShown(area, code)
    }

    /** A failure card on screen in the conversation; counted once per message while fresh. */
    fun failureShown(messageId: String, createdAt: Long, event: AnalyticsEvent.ChatFailureShown) {
        client?.failureShown(messageId, createdAt, event)
    }
}

/** The app's build, as analytics needs it: this module has no build config of its own. */
data class AnalyticsBuild(val debug: Boolean, val buildType: String, val postHogKey: String, val version: String)

/** Where and as what this build sends, or nothing. */
data class AnalyticsTarget(val host: String, val apiKey: String, val flavor: String, val appVersion: String) {
    /** Only a build sending to PostHog itself asks for flags; a debug capture never does. */
    val asksFlags: Boolean get() = host == PostHog.HOST

    companion object {
        /**
         * A release or preview build with a PostHog key, not under a test
         * harness, sends to PostHog. A debug build sends only when
         * `adb shell setprop debug.happy.analytics_host http://127.0.0.1:<port>`
         * names a local capture endpoint (`adb reverse` to a listener), never
         * to PostHog.
         */
        fun of(context: Context, build: AnalyticsBuild): AnalyticsTarget? {
            if (Build.FINGERPRINT == "robolectric" || instrumented()) return null
            if (build.debug) {
                val host = systemProperty("debug.happy.analytics_host")?.takeIf(::isLoopback) ?: return null
                return AnalyticsTarget(host, build.postHogKey.ifEmpty { "phc_debug_capture" }, "development", build.version)
            }
            if (build.postHogKey.isEmpty() || build.buildType == "bench") return null
            @Suppress("DEPRECATION")
            if (ActivityManager.isRunningInTestHarness() || ActivityManager.isUserAMonkey()) return null
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q && ActivityManager.isRunningInUserTestHarness()) return null
            if (android.provider.Settings.System.getString(context.contentResolver, "firebase.test.lab") == "true") return null
            return AnalyticsTarget(PostHog.HOST, build.postHogKey, if (build.buildType == "preview") "preview" else "standard", build.version)
        }

        /** An instrumented process has the test APK's classes beside the app's; the app alone never ships them. */
        private fun instrumented(): Boolean = try {
            Class.forName("androidx.test.platform.app.InstrumentationRegistry")
            true
        } catch (_: ClassNotFoundException) {
            false
        }

        internal fun isLoopback(value: String): Boolean = Regex("^http://(127\\.0\\.0\\.1|localhost)(:[0-9]{1,5})?/?$").matches(value)

        private fun systemProperty(name: String): String? = try {
            Class.forName("android.os.SystemProperties").getMethod("get", String::class.java).invoke(null, name) as? String
        } catch (_: Exception) {
            null
        }?.takeIf { it.isNotBlank() }
    }
}

/** The common properties that come from this phone and build. */
internal data class AnalyticsDevice(val appVersion: String?, val flavor: String, val osVersion: String?, val tablet: Boolean) {
    companion object {
        fun of(context: Context, target: AnalyticsTarget) = AnalyticsDevice(
            appVersion = AnalyticsSchema.version(target.appVersion),
            flavor = target.flavor,
            osVersion = osVersion(Build.VERSION.RELEASE),
            tablet = context.resources.configuration.smallestScreenWidthDp >= 600,
        )

        /** `15`, `8.1.0` → `15`, `8.1`: major and minor only. */
        fun osVersion(release: String?): String? = release?.let { Regex("^[0-9]+(\\.[0-9]+)?").find(it)?.value }
    }
}

/** The common properties that come from the open account: where its agent is, and which Happy Agent ([version] as the agent says it). */
data class AnalyticsAgent(val location: String? = null, val os: String? = null, val version: String? = null)

/**
 * The device's own Analytics switch, beside each Happy account's
 * `analyticsOptOut`: a phone with only agent connections has no account
 * setting to turn off. On for a new install; a stored value that can't be
 * read is off. Its prefs also hold the install id, the only other thing
 * analytics keeps.
 */
class AnalyticsSwitch(internal val prefs: SharedPreferences) {
    private val state = MutableStateFlow(read(prefs))
    val on: StateFlow<Boolean> = state.asStateFlow()

    /**
     * Turns analytics on or off at once, then writes it down off the main
     * thread: false when that write failed, for Settings to say so.
     */
    suspend fun set(on: Boolean): Boolean {
        state.value = on
        return withContext(Dispatchers.IO) {
            try {
                prefs.edit().putBoolean(KEY_ON, on).commit()
            } catch (e: Exception) {
                Log.w("Analytics", "Switch not written: ${e.javaClass.simpleName}")
                false
            }
        }
    }

    companion object {
        const val PREFS_NAME = "analytics"
        private const val KEY_ON = "device_on"

        fun of(context: Context) = AnalyticsSwitch(context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE))

        private fun read(prefs: SharedPreferences): Boolean = try {
            prefs.getBoolean(KEY_ON, true)
        } catch (_: Exception) {
            false
        }
    }
}

/** What earlier builds kept on the phone and this one doesn't: deleted at each start, which finds it at most once. */
internal object Retired {
    private val keys = listOf("launch_count", "exits_checked_at", "running_version", "failures_seen", "daily", "daily_counts")

    fun delete(context: Context, prefs: SharedPreferences) {
        try {
            val dir = File(context.noBackupFilesDir, "analytics")
            if (dir.exists()) dir.deleteRecursively()
            if (keys.any(prefs::contains)) prefs.edit().apply { keys.forEach(::remove) }.commit()
        } catch (e: Exception) {
            Log.w("Analytics", "Retired state not deleted: ${e.javaClass.simpleName}")
        }
    }
}

/**
 * Records and sends this phone's events while [consent] is true: each
 * checked against [AnalyticsSchema] with the common properties and
 * PostHog's own fields added, kept in memory, and posted in one batch every
 * [flushMillis] while the app is in front and once as it goes behind.
 * Nothing is counted on the phone: each event goes as it happens. Nothing
 * is recorded while [consent] is null (the accounts not read yet) or
 * false; false also stops every observer, forgets the queue, the throttle
 * and the failures seen, and deletes the install id, so turning it back on
 * starts a new one. Its state changes on one [lane].
 */
internal class AnalyticsClient(
    private val scope: CoroutineScope,
    /** Holds the install id, and nothing else of this client's. */
    private val prefs: SharedPreferences,
    private val posthog: PostHog,
    private val consent: StateFlow<Boolean?>,
    private val foreground: StateFlow<Boolean>,
    private val device: AnalyticsDevice,
    private val agent: () -> AnalyticsAgent,
    /** The setup `app_opened` reports, read as it is sent. */
    private val configuration: () -> AnalyticsEvent.AppOpened.Configuration,
    private val links: Flow<ConnectionIncidents.Link?> = MutableStateFlow(null),
    private val network: Flow<Boolean> = MutableStateFlow(true),
    /** How the process before this one ended, when it crashed with analytics on ([AppExits]). */
    private val crash: () -> AnalyticsEvent.AppCrashed? = { null },
    /** Marks this process as having analytics on (its version), or not (null), for the next start's [crash]. */
    private val mark: (String?) -> Unit = {},
    /** Told the flags on for this install; null where this build never asks. */
    private val flags: ((Set<String>) -> Unit)? = null,
    private val clock: () -> Long = System::currentTimeMillis,
    private val lane: CoroutineContext = Dispatchers.IO.limitedParallelism(1),
    private val flushMillis: Long = 30_000,
) {
    private val queue = AnalyticsQueue(clock)
    private var throttle = ErrorThrottle()
    private var exposures = FailureExposures()
    private val opens = AppOpens()
    private val sending = Mutex()
    private var installId: String? = null

    fun start() {
        scope.launch {
            var first = true
            consent.collectLatest { allowed ->
                if (allowed == null) return@collectLatest
                if (first) {
                    first = false
                    // A launch read as opted out has no launch of its own to tell later, nor a crash from before.
                    if (allowed) withContext(lane) { crash()?.let { enqueue(it, clock()) } } else opens.skip()
                }
                if (!allowed) return@collectLatest off()
                mark(device.appVersion ?: "-")
                coroutineScope {
                    launch { followOpens() }
                    launch { followFlushes() }
                    launch { followIncidents() }
                    flags?.let { tell -> launch { followFlags(tell) } }
                }
            }
        }
    }

    fun record(event: AnalyticsEvent) {
        val at = clock()
        if (consent.value != true) return
        scope.launch(lane) { if (consent.value == true) enqueue(event, at) }
    }

    /**
     * `error_shown`, at most once per area and code every ten minutes. One
     * failure reached by two paths at once (a conversation read as it opens
     * and again on the resync after) is one event: within
     * [ErrorThrottle.BURST_MILLIS] of one still waiting for the same area, a
     * specific code takes the place of `unknown` and anything else is dropped.
     */
    fun errorShown(area: ErrorArea, code: ErrorCode) {
        val at = clock()
        if (consent.value != true) return
        scope.launch(lane) {
            if (consent.value != true) return@launch
            val same = queue.pending().lastOrNull {
                it.event == "error_shown" && it.properties["area"] == JsonPrimitive(area.wire) && at - it.at < ErrorThrottle.BURST_MILLIS
            }
            if (same == null) {
                if (throttle.occur(area, code, at)) enqueue(AnalyticsEvent.ErrorShown(area, code), at)
                return@launch
            }
            if (same.properties["code"] == JsonPrimitive(ErrorCode.Unknown.wire) && code != ErrorCode.Unknown && throttle.occur(area, code, at)) {
                queue.replace(same, same.copy(properties = JsonObject(same.properties + ("code" to JsonPrimitive(code.wire)))))
            }
        }
    }

    fun failureShown(messageId: String, createdAt: Long, event: AnalyticsEvent.ChatFailureShown) {
        val at = clock()
        if (consent.value != true) return
        scope.launch(lane) {
            if (consent.value == true && exposures.shown(messageId, createdAt, at)) enqueue(event, at)
        }
    }

    /** Sends what is kept now, in one batch; what doesn't go stays for the next. */
    suspend fun flush() = sending.withLock {
        val batch = withContext(lane) { if (consent.value == true) queue.pending() else emptyList() }
        if (batch.isEmpty()) return@withLock
        when (posthog.send(batch)) {
            PostHog.Outcome.Sent, PostHog.Outcome.Refused -> withContext(lane) { queue.remove(batch) }
            PostHog.Outcome.Failed -> Unit
        }
    }

    /** Analytics went off: everything it had goes, the install id included, without waiting for a request on its way. */
    private suspend fun off() {
        withContext(lane) {
            queue.clear()
            throttle = ErrorThrottle()
            exposures = FailureExposures()
            opens.pause()
            installId = null
            try {
                prefs.edit().remove(KEY_INSTALL_ID).commit()
            } catch (e: Exception) {
                Log.w(TAG, "Install id not deleted: ${e.javaClass.simpleName}")
            }
        }
        mark(null)
        flags?.invoke(emptySet())
    }

    private suspend fun followOpens() {
        foreground.collect { front ->
            withContext(lane) {
                val now = clock()
                if (!front) return@withContext opens.background(now)
                val cold = opens.foreground(now) ?: return@withContext
                val setup = try {
                    configuration()
                } catch (e: Exception) {
                    Log.w(TAG, "Configuration unreadable: ${e.javaClass.simpleName}")
                    AnalyticsEvent.AppOpened.Configuration()
                }
                enqueue(AnalyticsEvent.AppOpened(cold, setup), now)
            }
        }
    }

    private suspend fun followFlushes() {
        foreground.collectLatest { front ->
            // Coming back doesn't call off the send made as the app went behind.
            if (!front) {
                scope.launch { flush() }
                return@collectLatest
            }
            while (true) {
                delay(flushMillis)
                flush()
            }
        }
    }

    private suspend fun followIncidents() {
        val incidents = ConnectionIncidents { scope.launch(lane) { if (consent.value == true) enqueue(it, clock()) } }
        combine(links, foreground, network) { link, front, online -> Triple(link, front, online) }
            .collect { (link, front, online) -> incidents.update(link, front, online, clock()) }
    }

    /** The flags for this install, asked each time the app comes to the front; a failed ask keeps the last answer. */
    private suspend fun followFlags(tell: (Set<String>) -> Unit) {
        foreground.collect { front ->
            if (!front) return@collect
            val id = withContext(lane) { id() }
            try {
                tell(posthog.flags(id))
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                Log.w(TAG, "PostHog flags failed: ${e.javaClass.simpleName}")
            }
        }
    }

    private fun enqueue(event: AnalyticsEvent, at: Long) {
        val own = AnalyticsSchema.check(event.name, event.properties)
        val common = AnalyticsSchema.checkCommon(commonProperties())
        if (own == null || common == null) {
            Log.w(TAG, "Dropped ${event.name}: not in the catalog's terms")
            return
        }
        val properties = LinkedHashMap<String, JsonElement>()
        for ((key, value) in common + own) properties[key] = element(value)
        properties["distinct_id"] = JsonPrimitive(id())
        properties["\$insert_id"] = JsonPrimitive(UUID.randomUUID().toString())
        properties["\$lib"] = JsonPrimitive("happy-android")
        properties["\$process_person_profile"] = JsonPrimitive(false)
        properties["\$ip"] = JsonNull
        properties["\$geoip_disable"] = JsonPrimitive(true)
        queue.add(QueuedEvent(event.name, at, JsonObject(properties)))
    }

    private fun commonProperties(): Map<String, Any?> {
        val agent = agent()
        return mapOf(
            "client" to "android",
            "app_version" to device.appVersion,
            "flavor" to device.flavor,
            "os" to "android",
            "os_version" to device.osVersion,
            "device_class" to if (device.tablet) "tablet" else "phone",
            "agent_location" to agent.location,
            "agent_os" to agent.os,
            "happy_agent_version" to AnalyticsSchema.version(agent.version),
        )
    }

    /** A random id made for this install, and again after each opt-out; never derived from or joined to an account. */
    private fun id(): String = installId ?: (prefs.getString(KEY_INSTALL_ID, null) ?: UUID.randomUUID().toString().also {
        prefs.edit().putString(KEY_INSTALL_ID, it).apply()
    }).also { installId = it }

    private fun element(value: Any?): JsonElement = when (value) {
        null -> JsonNull
        is String -> JsonPrimitive(value)
        is Boolean -> JsonPrimitive(value)
        is Number -> JsonPrimitive(value)
        else -> error("not a catalog value")
    }

    companion object {
        private const val TAG = "Analytics"
        private const val KEY_INSTALL_ID = "install_id"
    }
}
