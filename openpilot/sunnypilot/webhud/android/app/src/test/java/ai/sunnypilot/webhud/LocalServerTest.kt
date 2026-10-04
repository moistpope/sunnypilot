package ai.sunnypilot.webhud

import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import java.net.InetAddress
import java.net.InetSocketAddress
import java.net.ServerSocket
import java.net.Socket
import java.net.SocketTimeoutException
import java.util.concurrent.atomic.AtomicInteger
import kotlin.concurrent.thread

/** The relay half of the server: the JVM has no assets, so the page's files aren't covered here. */
class LocalServerTest {
    private val unreachable = AtomicInteger()
    private val server = LocalServer(null, "test") { unreachable.incrementAndGet() }
    private val servers = mutableListOf<ServerSocket>()

    init {
        server.start()
    }

    @After
    fun tearDown() {
        server.stop()
        servers.forEach { it.close() }
    }

    /** A device that answers each line with "<name>:<line>". */
    private fun echo(name: String): InetSocketAddress {
        val sock = ServerSocket(0, 50, InetAddress.getLoopbackAddress())
        servers += sock
        thread(isDaemon = true) {
            while (!sock.isClosed) {
                val s = runCatching { sock.accept() }.getOrNull() ?: break
                thread(isDaemon = true) {
                    runCatching {
                        val out = s.getOutputStream()
                        s.getInputStream().bufferedReader().forEachLine { out.write("$name:$it\n".toByteArray()) }
                    }
                    s.close()
                }
            }
        }
        return InetSocketAddress("127.0.0.1", sock.localPort)
    }

    /** A connection the server relays to the device: an API request's head goes first (and is echoed back). */
    private fun open(path: String = "/api/x"): Socket {
        val s = Socket("127.0.0.1", server.port).apply { soTimeout = 2000 }
        s.getOutputStream().write("GET $path HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n".toByteArray())
        return s
    }

    private fun Socket.reader() = getInputStream().bufferedReader()

    /** Reads the echoed request head (three lines), then asks. */
    private fun Socket.ask(line: String, first: Boolean = false): String? {
        val r = reader()
        if (first) repeat(3) { r.readLine() }
        getOutputStream().write("$line\n".toByteArray())
        return r.readLine()
    }

    /** True once the far end has closed the connection. */
    private fun Socket.closedByPeer(): Boolean = try {
        getInputStream().read() < 0
    } catch (e: SocketTimeoutException) {
        false
    } catch (e: java.io.IOException) {
        true
    }

    @Test
    fun relaysBothWays() {
        server.setDevice(echo("a"))
        open().use { s ->
            assertEquals("a:hello", s.ask("hello", first = true))
            assertTrue(nowMs() - server.lastDeviceData < 1000)
        }
    }

    @Test
    fun refusesWithoutADevice() {
        open().use { assertTrue(it.closedByPeer()) }
        server.setDevice(echo("a"))
        server.paused = true
        open().use { assertTrue(it.closedByPeer()) }
    }

    @Test
    fun switchingDevicesDropsOldConnections() {
        server.setDevice(echo("a"))
        open().use { s ->
            assertEquals("a:1", s.ask("1", first = true))
            server.setDevice(echo("b"))
            assertTrue(s.closedByPeer())
        }
        open().use { assertEquals("b:2", it.ask("2", first = true)) }
    }

    @Test
    fun idleConnectionsAreDropped() {
        server.setDevice(echo("a"))
        open().use { s ->
            assertEquals("a:1", s.ask("1", first = true))
            Thread.sleep(50)
            server.closeIdle(10)
            assertTrue(s.closedByPeer())
        }
    }

    @Test
    fun unreachableDeviceIsReported() {
        val gone = ServerSocket(0).use { it.localPort }
        server.setDevice(InetSocketAddress("127.0.0.1", gone))
        open().use { assertTrue(it.closedByPeer()) }
        assertEquals(1, unreachable.get())
    }

    @Test
    fun pageRequestsAreNotRelayed() {
        server.setDevice(echo("a"))
        // no assets on the JVM: the server answers itself (503) instead of sending the request to the device
        Socket("127.0.0.1", server.port).use { s ->
            s.soTimeout = 2000
            s.getOutputStream().write("GET /js/main.js HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n".toByteArray())
            val status = s.reader().readLine()
            assertEquals("HTTP/1.1 503 Service Unavailable", status)
        }
    }

    @Test
    fun contentTypes() {
        assertEquals("text/javascript; charset=utf-8", LocalServer.contentType("js/world/worker.js"))
        assertEquals("model/gltf-binary", LocalServer.contentType("models/pulse_ocean_v0.10_parts.glb"))
        assertEquals("text/plain; charset=utf-8", LocalServer.contentType("dbc/fisker_ocean_mrr.dbc"))
        assertEquals("application/octet-stream", LocalServer.contentType("noext"))
    }
}
