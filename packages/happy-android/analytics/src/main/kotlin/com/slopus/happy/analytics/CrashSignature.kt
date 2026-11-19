package com.slopus.happy.analytics

import android.os.Process
import java.io.File

/**
 * What `app_crashed` says about a JVM crash beyond its reason: the uncaught
 * exception's class, its root cause's, and up to five frames. Class names
 * and `class.method:line` frames only, never a message, file name or
 * argument; each is held to the catalog's `class_name` and `frame_list`
 * ([AnalyticsSchema]), and a name that doesn't fit is left out.
 *
 * The frames start at the first one outside the platform and the libraries
 * [PLATFORM] names, so they are where the crash left code this build
 * carries. A crash thrown and wrapped by the platform alone (a framework
 * NullPointerException as an activity launches) has no such frame: then
 * they are the innermost cause's own top frames. A store build is shrunk by R8, which renames classes and
 * packages alike (`g80.a`, the Kotlin and AndroidX libraries too) and keeps
 * no line table: the line is the one R8 leaves (its instruction offset),
 * and the build's mapping turns the frames back into source lines.
 */
data class CrashSignature(val exceptionClass: String?, val causeClass: String?, val frames: String?) {
    companion object {
        /**
         * Where the platform's classes and the libraries every build has begin; not this build's code.
         * `com.android.` is the boot classpath's (33 packages on Android 15, `internal`, `org.conscrypt`,
         * `okhttp`, `icu`, `server` among them, and more on some phones), less the Google libraries this
         * build bundles under it ([BUNDLED]).
         */
        val PLATFORM = listOf(
            "java.", "javax.", "jdk.", "kotlin.", "kotlinx.", "android.", "androidx.", "dalvik.", "libcore.", "sun.", "com.android.",
        )

        /** This build's own libraries under a [PLATFORM] prefix: Play Billing (its ProxyBillingActivity is ours to launch). */
        val BUNDLED = listOf("com.android.billingclient.", "com.android.installreferrer.")

        /** Whether [className] is the platform's or a library every build has, by [PLATFORM] and [BUNDLED]. */
        fun isPlatform(className: String): Boolean =
            PLATFORM.any { className.startsWith(it) } && BUNDLED.none { className.startsWith(it) }

        /** Causes followed at most, so a cycle or a very long chain ends. */
        private const val DEPTH = 16

        fun of(error: Throwable): CrashSignature {
            val causes = causes(error)
            return CrashSignature(
                exceptionClass = error.javaClass.name.takeIf(AnalyticsSchema::isClassName),
                causeClass = causes.lastOrNull()?.javaClass?.name?.takeIf(AnalyticsSchema::isClassName),
                // A wrapper thrown from the platform alone (a Looper's) has its frames in a cause; with none
                // of this build's anywhere, where the innermost cause was thrown, platform or not.
                frames = (listOf(error) + causes).firstNotNullOfOrNull { frames(it.stackTrace) }
                    ?: (causes.reversed() + error).firstNotNullOfOrNull { frames(it.stackTrace, fromTop = true) },
            )
        }

        /** [error]'s causes, outermost first, each once. */
        private fun causes(error: Throwable): List<Throwable> {
            val seen = mutableListOf(error)
            var next = error.cause
            while (next != null && seen.size <= DEPTH && seen.none { it === next }) {
                seen += next
                next = next.cause
            }
            return seen.drop(1)
        }

        /**
         * Up to five frames from the first outside [PLATFORM] (or the first of all, [fromTop]), a
         * space apart and within the catalog's length, fewer where five would be longer; null when
         * there is none.
         */
        fun frames(stack: Array<StackTraceElement>, fromTop: Boolean = false): String? {
            val first = if (fromTop) 0 else stack.indexOfFirst { !isPlatform(it.className) }
            if (first < 0) return null
            val frames = StringBuilder()
            var count = 0
            for (element in stack.drop(first)) {
                if (count == AnalyticsSchema.MAX_FRAMES) break
                val frame = "${element.className}.${element.methodName}:${element.lineNumber.coerceAtLeast(0)}"
                if (!AnalyticsSchema.isFrame(frame)) continue
                if (frames.length + frame.length + (if (count > 0) 1 else 0) > AnalyticsSchema.MAX_FRAMES_LENGTH) break
                if (count > 0) frames.append(' ')
                frames.append(frame)
                count++
            }
            return frames.toString().takeIf { count > 0 }
        }
    }
}

/**
 * The one file a JVM crash's [CrashSignature] is kept in, from the
 * crashing process's uncaught-exception handler to the next start, which
 * reads and deletes it ([take]). Written only while [armed]: analytics on
 * in that process, the same mark [AppExits] reads. Turning analytics off
 * deletes it. The process id goes with it, so it is told only for the exit
 * it belongs to.
 */
internal class CrashSignatures(private val file: File, private val pid: () -> Int = Process::myPid) {
    /** A signature as the next start reads it, with the process it came from. */
    data class Kept(val pid: Int, val signature: CrashSignature)

    @Volatile private var armed = false

    /** Writes the next crash down ([on]), or stops and deletes what is kept. */
    fun arm(on: Boolean) {
        armed = on
        if (!on) delete()
    }

    /** Becomes this process's uncaught-exception handler, ahead of the one there (the platform's, which ends the process). */
    fun install() {
        val previous = Thread.getDefaultUncaughtExceptionHandler()
        Thread.setDefaultUncaughtExceptionHandler { thread, error ->
            try {
                if (armed) write(pid(), error)
            } catch (_: Throwable) {
                // Whatever happens here, the crash goes on as it would have.
            }
            previous?.uncaughtException(thread, error)
        }
    }

    /** Synchronously, as the process is about to end. */
    fun write(pid: Int, error: Throwable) {
        val signature = CrashSignature.of(error)
        file.writeText(listOf(FORMAT, pid.toString(), signature.exceptionClass.orEmpty(), signature.causeClass.orEmpty(), signature.frames.orEmpty()).joinToString("\n"))
    }

    /** What the last crash left, deleted as it is read; null when nothing (or nothing readable) was. */
    fun take(): Kept? = try {
        if (!file.exists()) null else file.readText().also { delete() }.let(::parse)
    } catch (_: Exception) {
        delete()
        null
    }

    private fun delete() {
        try {
            file.delete()
        } catch (_: Exception) {
        }
    }

    private fun parse(text: String): Kept? {
        val lines = text.split('\n')
        if (lines.size != 5 || lines[0] != FORMAT) return null
        val pid = lines[1].toIntOrNull() ?: return null
        // Read back through the catalog's rules, so nothing else in the file could go.
        val signature = CrashSignature(
            exceptionClass = lines[2].takeIf(AnalyticsSchema::isClassName),
            causeClass = lines[3].takeIf(AnalyticsSchema::isClassName),
            frames = lines[4].takeIf(AnalyticsSchema::isFrameList),
        )
        return Kept(pid, signature)
    }

    companion object {
        /** Its name in `noBackupFilesDir`. */
        const val FILE = "crash_signature"
        private const val FORMAT = "crash-signature-1"
    }
}
