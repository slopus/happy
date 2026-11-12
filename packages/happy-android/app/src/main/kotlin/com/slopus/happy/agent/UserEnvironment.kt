package com.slopus.happy.agent

import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import kotlinx.serialization.json.putJsonArray
import java.util.Calendar
import java.util.Locale
import java.util.TimeZone

/**
 * What this device tells a computer about the time zone, languages, clock,
 * week and calendar its person works in (happy-agent API.md, "User
 * environment"), so their agents can be told it. A field this device can't
 * name in the API's terms is left out, never guessed: one bad field refuses
 * the whole report.
 */
data class UserEnvironment(
    val deviceKind: DeviceKind?,
    val timeZone: String?,
    /** Advisory: checked, never stored; agents are told offsets from [timeZone]. */
    val utcOffsetMinutes: Int?,
    val locale: String?,
    val languages: List<String>,
    val hourCycle: String?,
    /** 1 for Monday through 7 for Sunday. */
    val firstDayOfWeek: Int?,
    val calendar: String?,
) {
    enum class DeviceKind(val wire: String) { Phone("phone"), Tablet("tablet") }

    /** The report `PUT /v0/environment` takes from device [deviceId]. */
    fun report(deviceId: String): JsonObject = buildJsonObject {
        put("deviceId", deviceId)
        deviceKind?.let { put("deviceKind", it.wire) }
        timeZone?.let { put("timeZone", it) }
        utcOffsetMinutes?.let { put("utcOffsetMinutes", it) }
        locale?.let { put("locale", it) }
        if (languages.isNotEmpty()) putJsonArray("languages") { languages.forEach { add(JsonPrimitive(it)) } }
        hourCycle?.let { put("hourCycle", it) }
        firstDayOfWeek?.let { put("firstDayOfWeek", it) }
        calendar?.let { put("calendar", it) }
    }

    companion object {
        /** The BCP 47 calendars the API takes. */
        private val CALENDARS = setOf(
            "buddhist", "chinese", "coptic", "dangi", "ethioaa", "ethiopic", "gregory", "hebrew", "indian", "islamic",
            "islamic-civil", "islamic-rgsa", "islamic-tbla", "islamic-umalqura", "iso8601", "japanese", "persian", "roc",
        )

        /**
         * This device as [locale] formats and [zone] tells time, at [now].
         * [languages] are the person's in order; [twentyFourHour] is the
         * system's clock setting, which overrides the locale's on Android.
         */
        fun of(
            kind: DeviceKind?,
            zone: TimeZone,
            locale: Locale,
            languages: List<Locale>,
            twentyFourHour: Boolean,
            now: Long = System.currentTimeMillis(),
        ): UserEnvironment {
            val offset = zone.getOffset(now) / 60_000
            val week = Calendar.getInstance(zone, locale)
            return UserEnvironment(
                deviceKind = kind,
                timeZone = name(zone.id),
                utcOffsetMinutes = offset.takeIf { it in -720..840 },
                locale = name(locale.toLanguageTag()),
                languages = languages.mapNotNull { name(it.toLanguageTag()) }.distinct().take(16),
                hourCycle = if (twentyFourHour) "h23" else "h12",
                firstDayOfWeek = isoWeekday(week.firstDayOfWeek),
                calendar = (locale.getUnicodeLocaleType("ca") ?: week.calendarType).takeIf { it in CALENDARS },
            )
        }

        /** 1–64 characters, none of them a control character, as the API takes a name. */
        internal fun name(value: String): String? = value.takeIf { it.length in 1..64 && it.none(Char::isISOControl) && it != "und" }

        /** [Calendar.getFirstDayOfWeek] (1 Sunday … 7 Saturday) in ISO numbering. */
        internal fun isoWeekday(firstDayOfWeek: Int): Int? = firstDayOfWeek.takeIf { it in 1..7 }?.let { (it + 5) % 7 + 1 }
    }
}

/**
 * One computer's side of this device's reports: whether it takes them, and
 * what it was last told. A daemon that doesn't refuses a send naming a
 * device, so [sendingDeviceId] is null until it says it does: health's
 * `capabilities.userEnvironment`, or a report it took.
 */
class UserEnvironmentReports {
    @Volatile private var served: Boolean? = null
    @Volatile private var deviceId: String? = null
    @Volatile private var reported: UserEnvironment? = null

    /** What to name the sending device as on a send, once the computer takes it. */
    val sendingDeviceId: String? get() = if (served == true) deviceId else null

    /**
     * Tells [client]'s computer [environment] as device [deviceId]
     * (`PUT /v0/environment`), when its health says it takes reports and it
     * changed since it was last told. Health is asked until it says yes: a
     * computer updated while the app runs starts taking reports. A 404 is a
     * computer that doesn't. A failure is thrown and not remembered, so it
     * goes again at the next report.
     */
    suspend fun report(client: AgentClient, environment: UserEnvironment, deviceId: String) {
        if (served != true) {
            val capabilities = client.decode<JsonObject>("GET", "/v0/health")["capabilities"] as? JsonObject
            val takes = (capabilities?.get("userEnvironment") as? JsonPrimitive)?.booleanOrNull == true
            serves(takes, deviceId)
            if (!takes) return
        }
        if (reported == environment) return
        try {
            client.send("PUT", "/v0/environment", environment.report(deviceId))
        } catch (e: AgentApiException) {
            if (e.status != 404) throw e
            serves(false, deviceId)
            return
        }
        reported = environment
    }

    @Synchronized
    private fun serves(value: Boolean, deviceId: String) {
        served = value
        if (value) this.deviceId = deviceId else reported = null
    }
}
