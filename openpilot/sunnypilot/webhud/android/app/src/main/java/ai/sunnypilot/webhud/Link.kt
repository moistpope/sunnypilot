package ai.sunnypilot.webhud

import android.content.Context
import android.os.Handler
import android.os.Looper
import android.util.Log
import java.net.InetAddress
import java.net.InetSocketAddress
import java.util.concurrent.ExecutorCompletionService
import java.util.concurrent.Executors
import java.util.concurrent.ScheduledFuture
import java.util.concurrent.TimeUnit

/**
 * Finds the comma's HUD server on the hotspot and keeps watching it, on its own thread. Lives as long
 * as the process, so recreating the activity (day/night switch) doesn't search again.
 *
 * Searching: a hand-set address, the last device seen, every host in the ARP table and every host a
 * sweep found up but not serving yet (a comma still booting) are asked for /api/status together; then
 * every local subnet, the hotspot's first, is swept for port 8088, less often the longer nothing
 * answers (a new network is swept at once).
 *
 * Connected: while the device streams to the page through the [LocalServer] that's all the proof
 * needed; when it goes quiet /api/status is polled, and [MAX_MISSES] misses in a row mean it's gone.
 */
class Link private constructor(context: Context) {

    interface Listener {
        /** Found, or found again: the page should load, or reconnect at once. */
        fun onConnected(device: Device)

        /** Not connected; [detail] says what's being tried. */
        fun onSearching(detail: String)
    }

    private val prefs = context.getSharedPreferences("link", Context.MODE_PRIVATE)
    private val main = Handler(Looper.getMainLooper())
    private val loop = Executors.newSingleThreadScheduledExecutor { Thread(it, "webhud-link").apply { isDaemon = true } }
    private val probes = Executors.newFixedThreadPool(8) { Thread(it, "webhud-probe").apply { isDaemon = true } }
    val root = RootShell()   // also turns on the notification listener (HudListener.grant)
    private val neighbors = Neighbors(root)
    val server = LocalServer(context.assets, assetVersion(context), MapTiles(java.io.File(context.filesDir, "osm/offline")), onDeviceUnreachable = { checkNow() })

    // UI thread only
    private var listener: Listener? = null

    // read on any thread, written on the link thread
    @Volatile var device: Device? = null
        private set
    @Volatile var detail = ""
        private set
    @Volatile var manual: String? = prefs.getString(KEY_MANUAL, null)
        private set
    val lastSeen: String? get() = prefs.getString(KEY_LAST, null)

    // link thread only
    private var task: ScheduledFuture<*>? = null
    private var running = false
    private var misses = 0
    private var sweeps = 0
    private var nextSweepAt = 0L
    private var networks = ""
    private val upHosts = LinkedHashMap<String, Long>()   // hosts that refused port 8088 → when, on the nowMs clock

    init {
        server.start()
    }

    /** Called with the current state at once, then on every change, on the UI thread. */
    fun attach(l: Listener) {
        listener = l
        device?.let { l.onConnected(it) } ?: l.onSearching(detail)
    }

    fun detach(l: Listener) {
        if (listener === l) listener = null
    }

    // activities showing the HUD: while an activity is recreated (a day/night switch) the new one starts
    // before the old one stops, so a plain flag would end up paused with the HUD on screen
    private var shown = 0

    /** The HUD is on screen: search or watch. */
    @Synchronized
    fun resume() {
        shown++
        server.paused = false
        loop.execute {
            running = true
            schedule(0)
        }
    }

    /** The HUD is hidden (screen off, another app in front): stop, and let go of the device so it stops
     *  reading the bus for us. The CAN reader and the local server carry on in [HudService]. */
    @Synchronized
    fun pause() {
        if (--shown > 0) return
        shown = 0
        server.paused = true
        loop.execute {
            running = false
            task?.cancel(false)
            task = null
        }
    }

    /** Forget the current device and look again from scratch. */
    fun searchAgain() = loop.execute {
        if (device != null) lost("search requested")
        sweeps = 0
        nextSweepAt = 0
        schedule(0)
    }

    /** Use [address] ("host" or "host:port") first from now on; null goes back to finding it. */
    fun setManual(address: String?) = loop.execute {
        manual = address
        prefs.edit().apply { if (address == null) remove(KEY_MANUAL) else putString(KEY_MANUAL, address) }.apply()
        if (device != null) lost("address changed")
        schedule(0)
    }

    /** Something failed to reach the device: check now rather than at the next tick. */
    fun checkNow() = loop.execute { schedule(0) }

    private fun schedule(delayMs: Long) {
        if (!running) return
        task?.cancel(false)
        task = loop.schedule({ tick() }, delayMs, TimeUnit.MILLISECONDS)
    }

    private fun tick() {
        val next = try {
            server.closeIdle(IDLE_PIPE_MS)
            if (device != null) watch() else search()
        } catch (e: Exception) {
            Log.e(TAG, "link tick failed", e)
            SEARCH_INTERVAL_MS
        }
        schedule(next)
    }

    // ---- connected ---------------------------------------------------------------------------------

    private fun watch(): Long {
        val d = device ?: return 0
        if (nowMs() - server.lastDeviceData < QUIET_MS) {
            misses = 0   // streaming to the page right now
            return WATCH_INTERVAL_MS
        }
        if (Probe.status(d.host, d.port) != null) {
            misses = 0
            return WATCH_INTERVAL_MS
        }
        if (++misses < MAX_MISSES) return RECHECK_MS
        lost("${d.address} stopped answering")
        return 0
    }

    private fun connected(d: Device, how: String): Long {
        device = d
        misses = 0
        prefs.edit().putString(KEY_LAST, d.address).apply()
        server.setDevice(InetSocketAddress(d.host, d.port))
        Log.i(TAG, "connected to ${d.hostname} at ${d.address} (webhud ${d.version}), found by $how")
        main.post { listener?.onConnected(d) }
        return WATCH_INTERVAL_MS
    }

    private fun lost(why: String) {
        Log.w(TAG, "lost the device: $why")
        device = null
        misses = 0
        server.setDevice(null)
        report(Net.subnets(), null, force = true)
    }

    // ---- searching ---------------------------------------------------------------------------------

    private fun search(): Long {
        val nets = Net.subnets()
        val signature = nets.joinToString { "${it.iface} ${it.searched}" }
        if (signature != networks) {
            networks = signature   // joined or left a network: sweep it now
            sweeps = 0
            nextSweepAt = 0
        }
        report(nets, null)

        // 1. addresses we know of
        val known = LinkedHashSet<Pair<String, Int>>()
        manual?.let { Net.parseAddress(it, Probe.PORT) }?.let(known::add)
        lastSeen?.let { Net.parseAddress(it, Probe.PORT) }?.let(known::add)
        neighbors.read().forEach { known += it to Probe.PORT }
        upHosts.entries.removeAll { nowMs() - it.value > UP_HOST_TTL_MS }
        upHosts.keys.forEach { known += it to Probe.PORT }
        firstDevice(known)?.let { return connected(it, "trying known addresses (set by hand, last seen, ARP table, up hosts)") }
        Log.d(TAG, "no HUD at ${known.joinToString { "${it.first}:${it.second}" }}")

        // 2. everything on the local networks
        if (nets.isNotEmpty() && nowMs() >= nextSweepAt) {
            val swept = HashSet<InetAddress>()
            for (net in nets) {
                report(nets, net)
                val hosts = net.hosts().filter { swept.add(it) }
                for (batch in hosts.chunked(SWEEP_BATCH)) {
                    val t0 = nowMs()
                    val result = Probe.sweep(batch, Probe.PORT, SWEEP_WINDOW_MS)
                    Log.d(TAG, "swept ${batch.size} hosts on ${net.iface} in ${nowMs() - t0} ms: open ${result.open}, closed ${result.refused}")
                    // first come, first kept: the hotspot is swept first and keeps its places
                    for (h in result.refused) {
                        if (h.hostAddress!! in upHosts || upHosts.size < MAX_UP_HOSTS) upHosts[h.hostAddress!!] = nowMs()
                    }
                    firstDevice(result.open.map { it.hostAddress!! to Probe.PORT })?.let { return connected(it, "sweeping ${net.iface}") }
                }
            }
            nextSweepAt = nowMs() + SWEEP_BACKOFF_MS[minOf(sweeps++, SWEEP_BACKOFF_MS.lastIndex)]
            report(nets, null)
        }
        return SEARCH_INTERVAL_MS
    }

    /** Asks every address at once; the first HUD server to answer. */
    private fun firstDevice(addresses: Collection<Pair<String, Int>>): Device? {
        if (addresses.isEmpty()) return null
        val done = ExecutorCompletionService<Device?>(probes)
        val futures = addresses.map { (host, port) -> done.submit { Probe.status(host, port) } }
        try {
            repeat(futures.size) {
                runCatching { done.take().get() }.getOrNull()?.let { return it }
            }
            return null
        } finally {
            futures.forEach { it.cancel(true) }
        }
    }

    private fun report(nets: List<Subnet>, scanning: Subnet?, force: Boolean = false) {
        val text = when {
            scanning != null -> "Scanning ${scanning.iface} ${scanning.searched}…"
            nets.isEmpty() -> "No local network. Is the car's hotspot on?"
            else -> "Watching " + nets.joinToString(", ") { "${it.iface} ${it.searched}" } +
                (lastSeen?.let { " · last seen at $it" } ?: "")
        }
        if (text == detail && !force) return
        detail = text
        main.post { if (device == null) listener?.onSearching(text) }
    }

    companion object {
        private const val TAG = "WebHud"
        private const val KEY_LAST = "last"
        private const val KEY_MANUAL = "manual"

        private const val SEARCH_INTERVAL_MS = 1500L
        private const val SWEEP_BATCH = 256
        private const val SWEEP_WINDOW_MS = 900L
        private val SWEEP_BACKOFF_MS = longArrayOf(2_000, 3_000, 5_000, 8_000, 10_000)
        private const val MAX_UP_HOSTS = 16
        private const val UP_HOST_TTL_MS = 120_000L

        private const val WATCH_INTERVAL_MS = 2000L
        private const val QUIET_MS = 2500L       // the WebSocket carries 20 frames a second
        private const val RECHECK_MS = 500L
        private const val MAX_MISSES = 3
        private const val IDLE_PIPE_MS = 15_000L

        @Volatile private var instance: Link? = null

        /** Changes with every install, so the page's files are re-fetched then and cached (ETag) in between. */
        private fun assetVersion(context: Context): String = try {
            context.packageManager.getPackageInfo(context.packageName, 0).lastUpdateTime.toString(36)
        } catch (e: Exception) {
            "0"
        }

        fun get(context: Context): Link =
            instance ?: synchronized(this) { instance ?: Link(context.applicationContext).also { instance = it } }
    }
}
