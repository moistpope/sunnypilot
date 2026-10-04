package ai.sunnypilot.webhud

import android.content.Context
import android.util.Log
import org.json.JSONArray
import org.json.JSONObject
import java.io.BufferedReader
import java.util.concurrent.CopyOnWriteArraySet
import kotlin.concurrent.thread

/**
 * The car's live state for the HUD's read-out (static/js/carstate.js). Pulse has two MCP251x CAN
 * controllers wired to the car: can1 = IBUS1, can2 = IBUS2. The gateway broadcasts status messages
 * there all the time; this reads the ones the menus show and forwards each changed frame to the page.
 *
 * Receive only. The reading is done by the bundled `libcanbridge.so` helper, which opens the sockets
 * with a receive-only filter and has no transmit path at all; this class only starts it and reads its
 * stdout. Nothing here, or in the helper, ever writes to the bus.
 *
 * The helper is a plain executable shipped as a .so so it lands in the app's nativeLibraryDir (the one
 * place an app may exec from); it needs no root, since the Pulse app opens CAN the same way.
 */
object CanBridge {

    interface Listener {
        /** A batch of changed frames as the page takes them: [{bus,addr,data}], or "[]". */
        fun onCanFrames(json: String)
    }

    // the status messages the menus read, by interface (hex IDs). Keep in step with carsignals.js.
    private const val CAN1 = "234,2F5,335,343,358,373,512,518"   // IBUS1
    private const val CAN2 = "236,321,369"                        // IBUS2
    private val BUS = mapOf("can1" to "IBUS1", "can2" to "IBUS2")

    private val listeners = CopyOnWriteArraySet<Listener>()
    private val latest = LinkedHashMap<String, JSONObject>()   // "bus/addr" -> last frame, for a new page
    private var proc: Process? = null
    @Volatile private var running = false

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
        thread(name = "webhud-can", isDaemon = true) { run(bin) }
    }

    @Synchronized
    fun stop() {
        running = false
        proc?.destroy()
        proc = null
    }

    private fun run(bin: String) {
        var tries = 0
        while (running) {
            try {
                Log.i(TAG, "CAN helper starting ($bin)")
                val p = ProcessBuilder(bin, "can1=$CAN1", "can2=$CAN2").redirectErrorStream(false).start()
                proc = p
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
            if (running) Thread.sleep(minOf(30_000L, 1000L shl minOf(tries++, 5)))   // restart with backoff
        }
    }

    private fun readLoop(reader: BufferedReader) {
        val batch = ArrayList<JSONObject>()
        var lastFlush = 0L
        var loggedFirst = false
        while (running) {
            val line = reader.readLine() ?: break
            if (line.startsWith("#")) {
                Log.i(TAG, "CAN helper: ${line.drop(1).trim()}")
                continue
            }
            val parts = line.split(' ')
            if (parts.size != 3) continue
            val bus = BUS[parts[0]] ?: continue
            val f = JSONObject().put("bus", bus).put("addr", parts[1].toInt(16)).put("data", parts[2])
            synchronized(latest) { latest[bus + "/" + parts[1]] = f }
            if (!loggedFirst) { loggedFirst = true; Log.i(TAG, "CAN frames flowing (first: ${f.getString("bus")} ${parts[1]})") }
            batch.add(f)
            // coalesce: flush at ~15 Hz so a burst of changes is one page event
            val now = System.currentTimeMillis()
            if (now - lastFlush >= 66 || batch.size >= 24) {
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
}
