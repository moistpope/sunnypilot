package ai.sunnypilot.webhud

import org.json.JSONException
import org.json.JSONObject
import java.io.ByteArrayOutputStream
import java.io.IOException
import java.io.InputStream
import java.net.ConnectException
import java.net.InetAddress
import java.net.InetSocketAddress
import java.net.Socket
import java.nio.channels.SelectionKey
import java.nio.channels.Selector
import java.nio.channels.SocketChannel

/** A sunnypilot web HUD server, as its /api/status describes itself. */
data class Device(val host: String, val port: Int, val hostname: String, val version: String) {
    val address: String get() = "$host:$port"
}

object Probe {
    const val PORT = 8088
    private const val MAX_RESPONSE = 64 * 1024

    /** Asks [host] for /api/status: the HUD server if it is one, null for anything else. */
    fun status(host: String, port: Int, connectMs: Int = 1500, readMs: Int = 2000): Device? = try {
        Socket().use { s ->
            s.tcpNoDelay = true
            s.connect(InetSocketAddress(host, port), connectMs)
            s.soTimeout = readMs
            s.getOutputStream().write(
                "GET /api/status HTTP/1.1\r\nHost: $host:$port\r\nConnection: close\r\n\r\n".toByteArray()
            )
            parseStatus(readCapped(s.getInputStream()), host, port)
        }
    } catch (e: IOException) {
        null
    } catch (e: IllegalArgumentException) {
        null   // unresolvable or malformed host typed by hand
    }

    /** The device described by a raw HTTP response, if it's a 200 with the HUD server's status. */
    fun parseStatus(raw: ByteArray, host: String, port: Int): Device? {
        val text = String(raw, Charsets.UTF_8)
        val split = text.indexOf("\r\n\r\n")
        if (split < 0) return null
        val statusLine = text.substring(0, text.indexOf("\r\n"))
        if (!statusLine.startsWith("HTTP/1.") || statusLine.split(' ').getOrNull(1) != "200") return null
        return try {
            val j = JSONObject(text.substring(split + 4))
            if (!j.has("version") || !j.has("hostname") || !j.has("urls")) null
            else Device(host, port, j.getString("hostname"), j.getString("version"))
        } catch (e: JSONException) {
            null
        }
    }

    /** Hosts that accepted a connection, and hosts that are there but refused it (port closed). */
    data class Sweep(val open: List<InetAddress>, val refused: List<InetAddress>)

    /**
     * Connects to [port] on all [hosts]. Every connect is started at once (non-blocking) and given
     * [windowMs] to complete, so a /24 takes about that long whatever is on it.
     */
    fun sweep(hosts: List<InetAddress>, port: Int, windowMs: Long): Sweep {
        val open = mutableListOf<InetAddress>()
        val refused = mutableListOf<InetAddress>()
        val channels = ArrayList<SocketChannel>(hosts.size)
        Selector.open().use { selector ->
            try {
                var pending = 0
                for (h in hosts) {
                    try {
                        val ch = SocketChannel.open()
                        channels += ch
                        ch.configureBlocking(false)
                        if (ch.connect(InetSocketAddress(h, port))) open += h
                        else {
                            ch.register(selector, SelectionKey.OP_CONNECT, h)
                            pending++
                        }
                    } catch (e: IOException) {
                        // no route to this one
                    }
                }
                val deadline = System.nanoTime() + windowMs * 1_000_000
                while (pending > 0) {
                    val left = (deadline - System.nanoTime()) / 1_000_000
                    if (left <= 0) break
                    selector.select(left)
                    val keys = selector.selectedKeys().iterator()
                    while (keys.hasNext()) {
                        val key = keys.next()
                        keys.remove()
                        key.cancel()
                        pending--
                        try {
                            if ((key.channel() as SocketChannel).finishConnect()) open += key.attachment() as InetAddress
                        } catch (e: ConnectException) {
                            refused += key.attachment() as InetAddress   // up, nothing on the port (yet)
                        } catch (e: IOException) {
                            // unreachable: nobody has this address
                        }
                    }
                }
            } finally {
                channels.forEach { runCatching { it.close() } }
            }
        }
        return Sweep(open, refused)
    }

    private fun readCapped(input: InputStream): ByteArray {
        val out = ByteArrayOutputStream()
        val buf = ByteArray(8192)
        while (out.size() < MAX_RESPONSE) {
            val n = input.read(buf)
            if (n < 0) break
            out.write(buf, 0, n)
        }
        return out.toByteArray()
    }
}
