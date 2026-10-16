package com.slopus.happy.ui.home

import java.time.Instant
import java.time.ZoneId
import java.time.format.DateTimeFormatter
import java.time.format.FormatStyle
import java.util.Locale

private const val DAY_MS = 24L * 60 * 60 * 1000

/**
 * sessionListTimestamp.ts: the clock for the last 24 hours, the weekday for
 * the week behind that, then MM/DD, and MM/DD/YY outside this year. Elapsed
 * time sets the first boundary, so a Sunday-night session doesn't turn into
 * "Sun" a few minutes after midnight.
 */
fun formatSessionListTimestamp(
    timestamp: Long,
    now: Long = System.currentTimeMillis(),
    zone: ZoneId = ZoneId.systemDefault(),
    locale: Locale = Locale.getDefault(),
): String {
    val date = Instant.ofEpochMilli(timestamp).atZone(zone)
    val age = now - timestamp
    if (age < DAY_MS) return DateTimeFormatter.ofLocalizedTime(FormatStyle.SHORT).withLocale(locale).format(date)
    if (age < 7 * DAY_MS) return DateTimeFormatter.ofPattern("EEE", locale).format(date)
    val monthDay = String.format(Locale.ROOT, "%02d/%02d", date.monthValue, date.dayOfMonth)
    val thisYear = Instant.ofEpochMilli(now).atZone(zone).year
    return if (date.year == thisYear) monthDay else String.format(Locale.ROOT, "%s/%02d", monthDay, date.year % 100)
}

/** `new Date(timestamp).toLocaleString()`: the date and the time with seconds, in the user's locale. */
fun formatLocaleDateTime(timestamp: Long, zone: ZoneId = ZoneId.systemDefault(), locale: Locale = Locale.getDefault()): String =
    DateTimeFormatter.ofLocalizedDateTime(FormatStyle.SHORT, FormatStyle.MEDIUM).withLocale(locale).format(Instant.ofEpochMilli(timestamp).atZone(zone))
