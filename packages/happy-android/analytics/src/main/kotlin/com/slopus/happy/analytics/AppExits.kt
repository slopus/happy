package com.slopus.happy.analytics

import android.app.ActivityManager
import android.app.ApplicationExitInfo
import android.os.Build
import android.os.Process

/**
 * `app_crashed` from the system's own record of how this app's last
 * process ended (`ApplicationExitInfo`, Android 11 and later), with nothing
 * kept on the phone: a process with analytics on leaves its version with
 * the system ([mark]; turning analytics off takes it back), and the next
 * start reads the one record before it ([last]), only when it has that mark,
 * so a process that ran with analytics off is never reported.
 * Only the reason, importance and that version are read, never the trace,
 * description or anything else. A crash, native crash, ANR or failed start
 * always counts; the system ending it for memory or resources, or a
 * signal, only while it was on the screen. Exits the app asked for, updates
 * and kills in the background are how Android works, not failures.
 */
internal object AppExits {
    /** Leaves this process's [version] with the system for the next start to read, or takes it back (null); nothing below Android 11. */
    fun mark(manager: ActivityManager, version: String?) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.R) return
        manager.setProcessStateSummary(version?.toByteArray(Charsets.US_ASCII) ?: ByteArray(0))
    }

    /** How the process before this one ended, when that was a crash; null otherwise and below Android 11. */
    fun last(manager: ActivityManager, packageName: String): AnalyticsEvent.AppCrashed? {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.R) return null
        val info = manager.getHistoricalProcessExitReasons(packageName, 0, 1).firstOrNull() ?: return null
        if (info.pid == Process.myPid()) return null
        val reason = reason(info.reason, info.importance) ?: return null
        val process = if (info.processName == packageName) CrashProcess.App else CrashProcess.Extension
        val mark = info.processStateSummary?.takeIf { it.isNotEmpty() && it.size <= 32 } ?: return null
        return AnalyticsEvent.AppCrashed(process, reason, AnalyticsSchema.version(mark.toString(Charsets.US_ASCII)))
    }

    /** [ApplicationExitInfo]'s `REASON_*` as the catalog's reason; null for an exit that isn't one. */
    fun reason(reason: Int, importance: Int): CrashReason? {
        val shown = importance <= ActivityManager.RunningAppProcessInfo.IMPORTANCE_VISIBLE
        return when (reason) {
            ApplicationExitInfo.REASON_CRASH -> CrashReason.Crash
            ApplicationExitInfo.REASON_CRASH_NATIVE -> CrashReason.NativeCrash
            ApplicationExitInfo.REASON_ANR -> CrashReason.Hang
            ApplicationExitInfo.REASON_INITIALIZATION_FAILURE -> CrashReason.LaunchFailed
            ApplicationExitInfo.REASON_LOW_MEMORY -> CrashReason.Oom.takeIf { shown }
            ApplicationExitInfo.REASON_EXCESSIVE_RESOURCE_USAGE, ApplicationExitInfo.REASON_SIGNALED -> CrashReason.Killed.takeIf { shown }
            else -> null
        }
    }
}
