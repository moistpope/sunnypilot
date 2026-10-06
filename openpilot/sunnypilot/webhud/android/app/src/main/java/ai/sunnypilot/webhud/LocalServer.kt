package ai.sunnypilot.webhud

import android.content.res.AssetManager
import android.util.Log
import java.io.ByteArrayOutputStream
import java.io.FileInputStream
import java.io.FileNotFoundException
import java.io.IOException
import java.io.InputStream
import java.io.OutputStream
import java.net.InetAddress
import java.net.InetSocketAddress
import java.net.ServerSocket
import java.net.Socket
import java.net.SocketTimeoutException
import java.net.URLDecoder
import org.json.JSONObject
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.atomic.AtomicBoolean
import kotlin.concurrent.thread

/**
 * The HUD's own web server at http://127.0.0.1:[port]: the page, its scripts, three.js, the car model
 * and the DBCs come from the APK's assets (`www/`, copied in at build time from the repo), so the HUD
 * starts at once and runs without the comma. `/api/...` and the `/ws` stream are relayed to the comma
 * byte for byte (HTTP and the WebSocket alike); with no device (searching, or paused in the
 * background) those connections are closed at once, so the page fails fast and shows itself offline.
 *
 * One origin for everything, so the page keeps its settings (localStorage is per origin) whatever
 * address the comma has, and the device can be switched under a loaded page, which then only
 * reconnects its WebSocket. [lastDeviceData] tells the link the device is alive without polling it.
 */
class LocalServer(
    private val assets: AssetManager?,
    private val assetVersion: String,
    private val mapTiles: MapTiles? = null,
    private val mapFeatures: MapFeatures? = null,
    private val mapPrefetch: MapPrefetch? = null,
    private val onDeviceUnreachable: () -> Unit,
) {
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
        thread(name = "webhud-server", isDaemon = true) { acceptLoop() }
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
     * Drops relayed connections nothing has crossed for [maxIdleMs]. The device streams at 20 Hz, so a
     * quiet one is a link that died without a reset (Wi-Fi dropped) or an idle keep-alive.
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
            thread(name = "webhud-conn", isDaemon = true) { handle(client) }
        }
    }

    // ---- one connection -------------------------------------------------------------------------------

    private fun handle(client: Socket) {
        val head = try {
            client.soTimeout = HEAD_TIMEOUT_MS
            client.tcpNoDelay = true
            readHead(client.getInputStream())
        } catch (e: IOException) {
            client.closeQuietly()
            return
        }
        if (head == null) {
            client.closeQuietly()
            return
        }
        val text = String(head, Charsets.ISO_8859_1)
        val line = text.substringBefore("\r\n").split(' ')
        val method = line.getOrNull(0).orEmpty()
        val target = line.getOrNull(1).orEmpty()
        val path = target.substringBefore('?')
        if (path == "/ws" || path.startsWith("/api/")) {
            relay(client, head)
        } else {
            try {
                client.soTimeout = 0
                when {
                    path.startsWith("/map/tile/") -> serveTile(client, method, path, text)
                    path.startsWith("/map/features/") -> serveFeatures(client, method, path, text)
                    path == "/map/prefetch" || path == "/map/status" -> servePrefetch(client, method, path, text)
                    else -> serveAsset(client, method, path, text)
                }
            } catch (e: IOException) {
                // the page went away mid-file
            } finally {
                client.closeQuietly()
            }
        }
    }

    /** The request head, through the blank line, or null if the peer sent nothing usable. */
    private fun readHead(input: InputStream): ByteArray? {
        val buf = ByteArrayOutputStream()
        var last4 = 0   // the last four bytes, newest lowest
        while (buf.size() < MAX_HEAD) {
            val b = try {
                input.read()
            } catch (e: SocketTimeoutException) {
                return null
            }
            if (b < 0) return null
            buf.write(b)
            last4 = (last4 shl 8 or b) and 0xFFFFFFFF.toInt()
            if (last4 == 0x0D0A0D0A) return buf.toByteArray()   // \r\n\r\n
        }
        return null
    }

    // ---- the comma's API and stream ------------------------------------------------------------------

    private fun relay(client: Socket, head: ByteArray) {
        val target = device
        if (paused || target == null) {
            Log.d(TAG, "relay refused (paused=$paused, device=$target)")
            client.closeQuietly()
            return
        }
        val up = Socket()
        try {
            up.tcpNoDelay = true
            up.keepAlive = true
            up.connect(target, CONNECT_TIMEOUT_MS)
            up.getOutputStream().write(head)
        } catch (e: IOException) {
            Log.w(TAG, "relay to $target failed: ${e.message}")
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
            client.soTimeout = 0
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
                // this side is done sending: pass that on and let the other direction drain (a request
                // whose sender closes its half early still gets its response)
                runCatching { to.shutdownOutput() }
                if (fromDevice) close()
            } catch (e: IOException) {
                close()   // either side went away
            }
        }

        fun close() {
            if (!closed.compareAndSet(false, true)) return
            client.closeQuietly()
            up.closeQuietly()
            pipes -= this
        }
    }

    // ---- the page and its files ----------------------------------------------------------------------

    private fun serveAsset(client: Socket, method: String, path: String, head: String) {
        val out = client.getOutputStream()
        if (assets == null) {
            respond(out, 503, "Service Unavailable", "text/plain", "no assets".toByteArray(), emptyMap(), method == "HEAD")
            return
        }
        var rel = URLDecoder.decode(path, "UTF-8").trimStart('/')
        if (rel.isEmpty()) rel = "index.html"
        var cacheable = rel.startsWith("vendor/") || rel.startsWith("models/")
        if (rel.contains("..") || rel.contains('\u0000') || !exists(rel)) {
            rel = "index.html"   // unknown paths fall back to the app shell so deep links work, like the comma's server
            cacheable = false
        }
        val etag = "\"$assetVersion-${rel.hashCode().toUInt().toString(16)}\""
        val headers = linkedMapOf(
            "ETag" to etag,
            "Cache-Control" to if (cacheable) "max-age=86400" else "no-cache",
        )
        val inm = header(head, "If-None-Match")
        if (inm != null && inm.split(',').any { it.trim().removePrefix("W/") == etag || it.trim() == "*" }) {
            respond(out, 304, "Not Modified", null, null, headers, true)
            return
        }
        val type = contentType(rel)
        // the assets are stored uncompressed (build.gradle noCompress), so a file descriptor gives the length
        // and the bytes can stream out without a copy of the ~25 MB model in memory
        try {
            assets.openFd("$WWW/$rel").use { fd ->
                headers["Content-Type"] = type
                headers["Content-Length"] = fd.length.toString()
                writeHead(out, 200, "OK", headers)
                if (method != "HEAD") fd.createInputStream().use { stream(it, out, fd.length) }
            }
        } catch (e: IOException) {   // a compressed asset: read it whole
            val bytes = assets.open("$WWW/$rel").use { it.readBytes() }
            respond(out, 200, "OK", type, bytes, headers, method == "HEAD")
        }
        out.flush()
    }

    /** An OSM road tile for the page's map matcher (MapTiles): long-lived, so cached hard; a first request for
     *  an area waits while its cell downloads. */
    private fun serveTile(client: Socket, method: String, path: String, head: String) {
        val out = client.getOutputStream()
        val parsed = MapTiles.parsePath(URLDecoder.decode(path, "UTF-8"))
        val file = if (parsed == null || mapTiles == null) null else mapTiles.tile(parsed.first, parsed.second, parsed.third)
        if (file == null) {
            respond(out, 404, "Not Found", "text/plain", "no such map tile".toByteArray(), emptyMap(), method == "HEAD")
            return
        }
        val etag = "\"${file.lastModified().toString(16)}-${file.length().toString(16)}\""
        val headers = linkedMapOf("ETag" to etag, "Cache-Control" to "max-age=604800")
        val inm = header(head, "If-None-Match")
        if (inm != null && inm.split(',').any { it.trim().removePrefix("W/") == etag || it.trim() == "*" }) {
            respond(out, 304, "Not Modified", null, null, headers, true)
            return
        }
        headers["Content-Type"] = "application/octet-stream"
        headers["Content-Length"] = file.length().toString()
        writeHead(out, 200, "OK", headers)
        if (method != "HEAD") FileInputStream(file).use { stream(it, out, file.length()) }
        out.flush()
    }

    /** The point features of a map cell (MapFeatures): from Overpass once, then from disk. */
    private fun serveFeatures(client: Socket, method: String, path: String, head: String) {
        val out = client.getOutputStream()
        val parsed = MapFeatures.parsePath(URLDecoder.decode(path, "UTF-8"))
        val file = if (parsed == null || mapFeatures == null) null else mapFeatures.cell(parsed.first, parsed.second)
        if (file == null) {
            respond(out, 404, "Not Found", "text/plain", "no features for this cell".toByteArray(), emptyMap(), method == "HEAD")
            return
        }
        respond(out, 200, "OK", "application/json", file.readBytes(), mapOf("Cache-Control" to "max-age=86400"), method == "HEAD")
        out.flush()
    }

    /** POST /map/prefetch {lat, lon, radius_km}: download the map around the car (MapPrefetch); GET /map/status: how far it got. */
    private fun servePrefetch(client: Socket, method: String, path: String, head: String) {
        val out = client.getOutputStream()
        val pf = mapPrefetch
        if (pf == null) {
            respond(out, 404, "Not Found", "text/plain", "no map".toByteArray(), emptyMap(), method == "HEAD")
            return
        }
        val status = try {
            if (path == "/map/prefetch" && method == "POST") {
                val length = header(head, "Content-Length")?.toIntOrNull() ?: 0
                if (length <= 0 || length > MAX_BODY) throw IllegalArgumentException("no body")
                val body = ByteArray(length)
                val input = client.getInputStream()
                var got = 0
                while (got < length) {
                    val n = input.read(body, got, length - got)
                    if (n < 0) throw IOException("body ended early")
                    got += n
                }
                val json = JSONObject(String(body, Charsets.UTF_8))
                pf.request(json.getDouble("lat"), json.getDouble("lon"), json.optDouble("radius_km", 25.0))
            } else if (path == "/map/status" && method == "GET") {
                pf.status()
            } else {
                respond(out, 405, "Method Not Allowed", "text/plain", "".toByteArray(), emptyMap(), false)
                return
            }
        } catch (e: Exception) {
            respond(out, 400, "Bad Request", "application/json", JSONObject().put("error", e.message ?: "bad request").toString().toByteArray(), emptyMap(), false)
            return
        }
        respond(out, 200, "OK", "application/json", status.toString().toByteArray(), mapOf("Cache-Control" to "no-store"), method == "HEAD")
        out.flush()
    }

    private fun exists(rel: String): Boolean = try {
        assets!!.open("$WWW/$rel").close()
        true
    } catch (e: FileNotFoundException) {
        false
    } catch (e: IOException) {
        false
    }

    private fun header(head: String, name: String): String? {
        val prefix = "$name:"
        return head.split("\r\n").drop(1).firstOrNull { it.startsWith(prefix, ignoreCase = true) }?.substring(prefix.length)?.trim()
    }

    private fun respond(out: OutputStream, status: Int, reason: String, type: String?, body: ByteArray?, headers: Map<String, String>, headOnly: Boolean) {
        val h = LinkedHashMap(headers)
        if (type != null) h["Content-Type"] = type
        if (body != null) h["Content-Length"] = body.size.toString()
        writeHead(out, status, reason, h)
        if (body != null && !headOnly) out.write(body)
        out.flush()
    }

    private fun writeHead(out: OutputStream, status: Int, reason: String, headers: Map<String, String>) {
        val sb = StringBuilder("HTTP/1.1 $status $reason\r\n")
        for ((k, v) in headers) sb.append(k).append(": ").append(v).append("\r\n")
        sb.append("Connection: close\r\n\r\n")   // one request per connection: the WebView never reuses one of these for the comma
        out.write(sb.toString().toByteArray(Charsets.ISO_8859_1))
    }

    private fun stream(input: InputStream, out: OutputStream, length: Long) {
        val buf = ByteArray(BUFFER)
        var left = length
        while (left > 0) {
            val n = input.read(buf, 0, minOf(buf.size.toLong(), left).toInt())
            if (n < 0) break
            out.write(buf, 0, n)
            left -= n
        }
    }

    companion object {
        private const val TAG = "WebHud"
        /** Fixed, so the page's origin and its saved settings stay the same from launch to launch. */
        const val PREFERRED_PORT = 18088
        const val WWW = "www"
        private const val CONNECT_TIMEOUT_MS = 2000
        private const val HEAD_TIMEOUT_MS = 5000
        private const val MAX_HEAD = 64 * 1024
        private const val MAX_BODY = 64 * 1024
        private const val BUFFER = 64 * 1024

        fun contentType(name: String): String = when (name.substringAfterLast('.', "").lowercase()) {
            "html" -> "text/html; charset=utf-8"
            "js", "mjs" -> "text/javascript; charset=utf-8"
            "css" -> "text/css; charset=utf-8"
            "json", "webmanifest" -> "application/json; charset=utf-8"
            "svg" -> "image/svg+xml"
            "png" -> "image/png"
            "jpg", "jpeg" -> "image/jpeg"
            "ico" -> "image/x-icon"
            "glb" -> "model/gltf-binary"
            "dbc", "txt", "md" -> "text/plain; charset=utf-8"
            "woff2" -> "font/woff2"
            "woff" -> "font/woff"
            else -> "application/octet-stream"
        }

        private fun bind(): ServerSocket {
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
