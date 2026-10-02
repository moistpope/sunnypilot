package ai.sunnypilot.webhud

import android.util.Log
import java.io.IOException
import java.net.InetAddress
import java.net.InetSocketAddress
import java.net.ServerSocket
import java.net.Socket
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.atomic.AtomicBoolean
import kotlin.concurrent.thread

/**
 * Relays http://127.0.0.1:[port] to the HUD server byte for byte (HTTP and the WebSocket alike), so
 * the WebView always sees one origin:
 *  - the page keeps its settings (localStorage is per origin) when the comma gets a new address;
 *  - the device can be switched under a loaded page, which then only reconnects its WebSocket;
 *  - [lastDeviceData] tells the link the device is alive without polling it.
 * With no device (searching, or paused in the background) connections are closed at once, so the
 * page fails fast instead of waiting on a connect timeout.
 */
class LocalProxy(private val onDeviceUnreachable: () -> Unit) {
    private val server = bind()
    private val pipes: MutableSet<Pipe> = ConcurrentHashMap.newKeySet()

    val port: Int get() = server.localPort

    @Volatile var device: InetSocketAddress? = null
        private set

    @Volatile var paused = false
        set(value) {
            field = value
            if (value) closeAll()
        }

    /** When the device last sent anything, on the [nowMs] clock. */
    @Volatile var lastDeviceData = 0L
        private set

    fun start() {
        thread(name = "webhud-proxy", isDaemon = true) { acceptLoop() }
    }

    fun stop() {
        runCatching { server.close() }
        closeAll()
    }

    /** Points the relay at [address]; open connections to a previous device are dropped. */
    fun setDevice(address: InetSocketAddress?) {
        if (address == device) return
        device = address
        closeAll()
    }

    fun closeAll() = pipes.toList().forEach { it.close() }

    /**
     * Drops connections nothing has crossed for [maxIdleMs]. The device streams at 20 Hz, so a quiet
     * one is a link that died without a reset (Wi-Fi dropped) or an idle keep-alive.
     */
    fun closeIdle(maxIdleMs: Long) {
        val now = nowMs()
        pipes.filter { now - it.lastActivity > maxIdleMs }.forEach { it.close() }
    }

    private fun acceptLoop() {
        while (!server.isClosed) {
            val client = try {
                server.accept()
            } catch (e: IOException) {
                break
            }
            val target = device
            if (paused || target == null) {
                client.closeQuietly()
                continue
            }
            thread(name = "webhud-pipe", isDaemon = true) { relay(client, target) }
        }
    }

    private fun relay(client: Socket, target: InetSocketAddress) {
        val up = Socket()
        try {
            up.tcpNoDelay = true
            up.keepAlive = true
            up.connect(target, CONNECT_TIMEOUT_MS)
        } catch (e: IOException) {
            onDeviceUnreachable()
            up.closeQuietly()
            client.closeQuietly()
            return
        }
        val pipe = Pipe(client, up)
        pipes += pipe
        if (target != device || paused) {
            pipe.close()   // switched away while connecting
            return
        }
        try {
            client.tcpNoDelay = true
        } catch (e: IOException) {
            pipe.close()
            return
        }
        thread(name = "webhud-pipe-up", isDaemon = true) { pipe.pump(client, up, fromDevice = false) }
        pipe.pump(up, client, fromDevice = true)
    }

    private inner class Pipe(private val client: Socket, private val up: Socket) {
        @Volatile var lastActivity = nowMs()
        private val closed = AtomicBoolean()

        fun pump(from: Socket, to: Socket, fromDevice: Boolean) {
            val buf = ByteArray(BUFFER)
            try {
                val input = from.getInputStream()
                val output = to.getOutputStream()
                while (true) {
                    val n = input.read(buf)
                    if (n < 0) break
                    val now = nowMs()
                    lastActivity = now
                    if (fromDevice) lastDeviceData = now
                    output.write(buf, 0, n)
                }
            } catch (e: IOException) {
                // either side went away
            } finally {
                close()   // HTTP and WebSocket both end when either side closes
            }
        }

        fun close() {
            if (!closed.compareAndSet(false, true)) return
            client.closeQuietly()
            up.closeQuietly()
            pipes -= this
        }
    }

    private companion object {
        const val TAG = "WebHud"
        /** Fixed, so the page's origin and its saved settings stay the same from launch to launch. */
        const val PREFERRED_PORT = 18088
        const val CONNECT_TIMEOUT_MS = 2000
        const val BUFFER = 16 * 1024

        fun bind(): ServerSocket {
            val loopback = InetAddress.getByName("127.0.0.1")
            return try {
                ServerSocket(PREFERRED_PORT, 50, loopback)
            } catch (e: IOException) {
                Log.w(TAG, "port $PREFERRED_PORT is taken; the page's settings won't carry over this session")
                ServerSocket(0, 50, loopback)
            }
        }
    }
}

internal fun Socket.closeQuietly() {
    try {
        close()
    } catch (e: IOException) {
        // already gone
    }
}
