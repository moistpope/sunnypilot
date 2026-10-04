package ai.sunnypilot.webhud

import android.content.Context
import android.os.Handler
import android.os.HandlerThread
import android.util.Log
import org.json.JSONArray
import org.json.JSONObject
import java.io.BufferedReader
import java.io.BufferedWriter
import java.io.OutputStreamWriter
import java.util.concurrent.CopyOnWriteArraySet
import kotlin.concurrent.thread

/**
 * The car's own CAN link. Pulse has two MCP251x CAN controllers wired to the car: can1 = IBUS1, can2 =
 * IBUS2. The gateway broadcasts the car's state there all the time, and mirrors the ADAS bus onto
 * IBUS2 for the head unit; this reads what the page decodes ([CanIds]) and forwards each frame to it.
 *
 * It can also send: the head unit's own control messages (windows, locks, climate, seats...), and only
 * those. The allowlist is enforced twice, here and in the helper that holds the sockets. Every frame
 * sent is logged. Nothing is sent while a bus is asleep (nothing received on it lately) or faster than
 * [TX_PER_SECOND] frames a second.
 *
 * The reading and sending are done by the bundled `libcanbridge.so` helper (canbridge/main.go): a
 * plain executable shipped as a .so so it lands in the app's nativeLibraryDir, the one place an app may
 * exec from. It needs no root, since the Pulse app opens CAN the same way.
 */
object CanBridge {

    interface Listener {
        /** A batch of frames as the page takes them: [{bus,addr,data}], or "[]". */
        fun onCanFrames(json: String)
    }

    private val BUS = mapOf("can1" to "IBUS1", "can2" to "IBUS2")
    private val IFACE = BUS.entries.associate { (k, v) -> v to k }

    private val listeners = CopyOnWriteArraySet<Listener>()
    private val latest = LinkedHashMap<String, JSONObject>()   // "bus/addr" -> last frame, for a new page
    private val busSeen = HashMap<String, Long>()               // iface -> when a frame last came in
    private var proc: Process? = null
    private var stdin: BufferedWriter? = null
    @Volatile private var running = false
    private val txThread = HandlerThread("webhud-can-tx").apply { start() }
    private val tx = Handler(txThread.looper)
    private var txWindowStart = 0L
    private var txInWindow = 0

    fun addListener(l: Listener) = listeners.add(l)
    fun removeListener(l: Listener) = listeners.remove(l)

    /** Everything we currently hold, for a page that just started. */
    @Synchronized
    fun snapshot(): String {
        val arr = JSONArray()
        for (f in latest.values) arr.put(f)
        return arr.toString()
    }

    /** Start the reader if it isn't already; safe to call repeatedly. */
    @Synchronized
    fun start(context: Context) {
        if (running) return
        val bin = context.applicationInfo.nativeLibraryDir + "/libcanbridge.so"
        if (!java.io.File(bin).canExecute()) {
            Log.w(TAG, "CAN helper missing or not executable at $bin; live car state off")
            return
        }
        running = true
        val root = Link.get(context).root
        thread(name = "webhud-can", isDaemon = true) {
            // first open the chips' hardware filters so every ID in CanIds.RX can reach the helper
            val why = HwFilters.apply(root)
            if (why == null) Log.i(TAG, "CAN hardware filters pass every ID we read")
            else Log.w(TAG, "CAN hardware filters left as they are ($why): some read-outs stay empty")
            run(bin)
        }
    }

    @Synchronized
    fun stop() {
        running = false
        proc?.destroy()
        proc = null
        stdin = null
    }

    /** Whether frames are arriving on [bus] ("IBUS1" / "IBUS2"): the car is awake and the link works. */
    fun awake(bus: String, maxAgeMs: Long = 3000): Boolean {
        val iface = IFACE[bus] ?: return false
        val t = synchronized(busSeen) { busSeen[iface] } ?: return false
        return System.currentTimeMillis() - t < maxAgeMs
    }

    /**
     * Send one frame, if it's on the allowlist, the bus is awake and the rate allows. Returns null when
     * queued, else why not. [repeat] copies go out [gapMs] apart (the matrix's "OnWriteWithRepetition":
     * three, 20 ms apart). Asynchronous: the helper's answer goes to the log.
     */
    fun send(bus: String, addr: Int, data: ByteArray, repeat: Int = 1, gapMs: Long = 20): String? {
        val iface = IFACE[bus] ?: return "unknown bus $bus"
        val allowed = CanIds.TX[bus] ?: emptySet()
        if (addr !in allowed) return "0x%03X is not on the send list for %s".format(addr, bus)
        if (data.isEmpty() || data.size > 8) return "bad frame length"
        if (!awake(bus)) return "$bus is silent (the car is asleep, or the link is down)"
        val n = repeat.coerceIn(1, 10)
        synchronized(this) {
            val now = System.currentTimeMillis()
            if (now - txWindowStart > 1000) { txWindowStart = now; txInWindow = 0 }
            if (txInWindow + n > TX_PER_SECOND) return "too many frames this second"
            txInWindow += n
        }
        val hex = data.joinToString("") { "%02x".format(it) }
        val line = "tx $iface %03X $hex\n".format(addr)
        Log.i(TAG, "CAN send $bus 0x%03X $hex x$n".format(addr))
        for (i in 0 until n) {
            tx.postDelayed({
                val w = stdin
                if (w == null) { Log.w(TAG, "CAN send: helper not running"); return@postDelayed }
                try { w.write(line); w.flush() } catch (e: Exception) { Log.w(TAG, "CAN send failed: ${e.message}") }
            }, i * gapMs.coerceIn(5, 500))
        }
        return null
    }

    private fun run(bin: String) {
        var tries = 0
        while (running) {
            try {
                Log.i(TAG, "CAN helper starting ($bin)")
                val args = mutableListOf(bin, "can1=${CanIds.RX["IBUS1"]!!.hex()}", "can2=${CanIds.RX["IBUS2"]!!.hex()}")
                for ((bus, ids) in CanIds.TX) args += "tx:${IFACE[bus]}=${ids.hex()}"
                val p = ProcessBuilder(args).redirectErrorStream(false).start()
                proc = p
                stdin = BufferedWriter(OutputStreamWriter(p.outputStream))
                // the helper's stderr (its only error channel) to the log; closing it would block it
                thread(name = "webhud-can-err", isDaemon = true) {
                    try {
                        p.errorStream.bufferedReader().forEachLine { Log.w(TAG, "CAN helper: $it") }
                    } catch (e: Exception) { /* ended */ }
                }
                // the helper ends when its stdin closes (us), so keep stdin open until we stop
                val reader = p.inputStream.bufferedReader()
                readLoop(reader)
                val code = p.waitFor()
                Log.i(TAG, "CAN helper exited (code $code)")
            } catch (e: Exception) {
                Log.w(TAG, "CAN helper failed: ${e.message}")
            }
            proc?.destroy()   // never two helpers on the bus
            proc = null
            stdin = null
            if (running) Thread.sleep(minOf(30_000L, 1000L shl minOf(tries++, 5)))   // restart with backoff
        }
    }

    private fun Set<Int>.hex() = sorted().joinToString(",") { "%03X".format(it) }

    private fun readLoop(reader: BufferedReader) {
        val batch = ArrayList<JSONObject>()
        var lastFlush = 0L
        var loggedFirst = false
        while (running) {
            val line = reader.readLine() ?: break
            if (line.startsWith("#")) {
                val text = line.drop(1).trim()
                if (text.startsWith("tx ") && text.endsWith(" ok")) Log.d(TAG, "CAN helper: $text") else Log.i(TAG, "CAN helper: $text")
                continue
            }
            val parts = line.split(' ')
            if (parts.size != 3) continue
            val bus = BUS[parts[0]] ?: continue
            synchronized(busSeen) { busSeen[parts[0]] = System.currentTimeMillis() }
            val f = JSONObject().put("bus", bus).put("addr", parts[1].toInt(16)).put("data", parts[2])
            synchronized(latest) { latest[bus + "/" + parts[1]] = f }
            if (!loggedFirst) { loggedFirst = true; Log.i(TAG, "CAN frames flowing (first: ${f.getString("bus")} ${parts[1]})") }
            batch.add(f)
            // coalesce: flush at ~15 Hz so a burst of changes is one page event
            val now = System.currentTimeMillis()
            if (now - lastFlush >= 66 || batch.size >= 200) {
                flush(batch)
                batch.clear()
                lastFlush = now
            }
        }
        if (batch.isNotEmpty()) flush(batch)
    }

    private fun flush(batch: List<JSONObject>) {
        if (batch.isEmpty() || listeners.isEmpty()) return
        val arr = JSONArray()
        for (f in batch) arr.put(f)
        val json = arr.toString()
        for (l in listeners) l.onCanFrames(json)
    }

    private const val TAG = "WebHud"
    private const val TX_PER_SECOND = 60
}
