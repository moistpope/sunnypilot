package ai.sunnypilot.webhud

import android.util.Log
import java.io.File
import java.io.IOException
import java.util.concurrent.LinkedBlockingQueue
import java.util.concurrent.TimeUnit
import kotlin.concurrent.thread

/**
 * The kernel's ARP table: a client of the hotspot is listed as soon as it has talked to this device
 * (DHCP, DNS), so the comma can be found without sweeping the whole network. Apps can't read it on
 * Android 10+, so on the rooted head unit it's read through su.
 */
class Neighbors(private val root: RootShell) {

    /** Private IPv4 addresses currently resolved on any interface. */
    fun read(): Set<String> {
        val text = try {
            File(ARP).readText()
        } catch (e: Exception) {
            root.runIfReady("cat $ARP")
        }
        return text?.let(::parseArp).orEmpty()
    }

    companion object {
        private const val ARP = "/proc/net/arp"
        private val PRIVATE = Regex("""^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)""")

        /** IP address, HW type, Flags, HW address, Mask, Device; flags 0x0 is an unanswered lookup. */
        fun parseArp(text: String): Set<String> = text.lineSequence().drop(1).mapNotNull { line ->
            val f = line.trim().split(Regex("""\s+"""))
            if (f.size >= 4 && f[2] != "0x0" && f[3] != "00:00:00:00:00:00" && PRIVATE.containsMatchIn(f[0])) f[0]
            else null
        }.toSet()
    }
}

/**
 * One long-lived `su` shell. Starting su once means one grant prompt (or Magisk toast) per launch
 * rather than one per query. Until su has answered, and where there's no su, queries return null at
 * once instead of holding up discovery.
 */
class RootShell {
    private enum class State { IDLE, STARTING, READY, UNAVAILABLE }

    private class Shell(val process: Process) {
        val lines = LinkedBlockingQueue<String>()

        init {
            thread(name = "webhud-su-out", isDaemon = true) {
                try {
                    process.inputStream.bufferedReader().forEachLine { lines.put(it) }
                } catch (e: IOException) {
                    // shell killed
                }
                lines.put(EOF)
            }
        }
    }

    @Volatile private var state = State.IDLE
    @Volatile private var shell: Shell? = null
    @Volatile private var retryAt = 0L

    fun runIfReady(cmd: String, timeoutMs: Long = 2000): String? = when (state) {
        State.IDLE -> {
            if (nowMs() >= retryAt) start()
            null
        }
        State.STARTING, State.UNAVAILABLE -> null
        State.READY -> synchronized(this) {
            val out = shell?.let { exec(it, cmd, timeoutMs) }
            if (out == null) {
                // it worked before: start a new shell, but not right away
                close()
                retryAt = nowMs() + RETRY_MS
                state = State.IDLE
            }
            out
        }
    }

    /**
     * Runs [cmd] once root is up, waiting up to [waitMs] for su to start (and for the grant prompt to be
     * answered); its output, or null without root. Blocks: not on the main thread.
     */
    fun run(cmd: String, waitMs: Long = GRANT_TIMEOUT_MS + 5000): String? {
        val deadline = nowMs() + waitMs
        while (nowMs() < deadline) {
            runIfReady(cmd)?.let { return it }
            if (state == State.UNAVAILABLE) return null
            Thread.sleep(250)
        }
        return null
    }

    fun close() {
        shell?.process?.destroy()
        shell = null
    }

    private fun start() {
        state = State.STARTING
        thread(name = "webhud-su", isDaemon = true) {
            val s = try {
                Shell(ProcessBuilder("su").redirectErrorStream(true).start())
            } catch (e: IOException) {
                Log.i(TAG, "no su, reading the ARP table directly only")
                state = State.UNAVAILABLE
                return@thread
            }
            shell = s
            // the first su can wait on the user answering a grant prompt
            val uid = exec(s, "id -u", GRANT_TIMEOUT_MS)?.trim()
            state = if (uid == "0") State.READY else State.UNAVAILABLE
            if (state == State.READY) Log.i(TAG, "root shell ready")
            else {
                Log.i(TAG, "su refused ($uid), reading the ARP table directly only")
                close()
            }
        }
    }

    /** Runs [cmd] in [s]; its output, or null if the shell died or took too long. */
    private fun exec(s: Shell, cmd: String, timeoutMs: Long): String? {
        try {
            s.process.outputStream.write("$cmd\necho $MARK\n".toByteArray())
            s.process.outputStream.flush()
        } catch (e: IOException) {
            return null
        }
        val out = StringBuilder()
        val deadline = nowMs() + timeoutMs
        while (true) {
            val left = deadline - nowMs()
            val line = if (left > 0) s.lines.poll(left, TimeUnit.MILLISECONDS) else null
            when (line) {
                null, EOF -> return null
                MARK -> return out.toString()
                else -> out.append(line).append('\n')
            }
        }
    }

    private companion object {
        const val TAG = "WebHud"
        const val MARK = "__webhud_done__"
        const val EOF = "\u0000eof"
        const val GRANT_TIMEOUT_MS = 30_000L
        const val RETRY_MS = 30_000L
    }
}

internal fun nowMs(): Long = System.nanoTime() / 1_000_000
