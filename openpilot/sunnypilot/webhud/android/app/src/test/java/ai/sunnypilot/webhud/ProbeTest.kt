package ai.sunnypilot.webhud

import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.net.InetAddress
import java.net.ServerSocket
import kotlin.concurrent.thread

class ProbeTest {
    private val servers = mutableListOf<ServerSocket>()

    @After
    fun tearDown() = servers.forEach { it.close() }

    /** A server that answers every connection with [response]. */
    private fun serve(response: String): Int {
        val server = ServerSocket(0, 50, InetAddress.getLoopbackAddress())
        servers += server
        thread(isDaemon = true) {
            while (!server.isClosed) {
                val s = runCatching { server.accept() }.getOrNull() ?: break
                s.getInputStream().read(ByteArray(4096))
                s.getOutputStream().write(response.toByteArray())
                s.close()
            }
        }
        return server.localPort
    }

    private fun http(status: String, body: String) =
        "HTTP/1.1 $status\r\nContent-Type: application/json\r\nContent-Length: ${body.length}\r\n\r\n$body"

    private val status = """{"version":"1.0","hostname":"sunnypilot.local","mdns":"avahi","urls":["http://sunnypilot.local:8088"],"mode":"live"}"""

    @Test
    fun recognizesTheHudServer() {
        val port = serve(http("200 OK", status))
        assertEquals(Device("127.0.0.1", port, "sunnypilot.local", "1.0"), Probe.status("127.0.0.1", port))
    }

    @Test
    fun rejectsOtherServers() {
        assertNull(Probe.status("127.0.0.1", serve(http("200 OK", """{"status":"ok"}"""))))
        assertNull(Probe.status("127.0.0.1", serve(http("404 Not Found", status))))
        assertNull(Probe.status("127.0.0.1", serve(http("200 OK", "<html>router</html>"))))
        assertNull(Probe.status("127.0.0.1", serve("SSH-2.0-OpenSSH_9.6\r\n")))
    }

    @Test
    fun closedPortFailsFast() {
        val port = ServerSocket(0).use { it.localPort }
        val t0 = System.nanoTime()
        assertNull(Probe.status("127.0.0.1", port))
        assertTrue((System.nanoTime() - t0) / 1_000_000 < 1000)
    }

    @Test
    fun sweepTellsOpenFromClosedPorts() {
        val port = serve(http("200 OK", status))
        val loopback = InetAddress.getByName("127.0.0.1")
        assertEquals(Probe.Sweep(listOf(loopback), emptyList()), Probe.sweep(listOf(loopback), port, 500))
        val closed = ServerSocket(0).use { it.localPort }
        assertEquals(Probe.Sweep(emptyList(), listOf(loopback)), Probe.sweep(listOf(loopback), closed, 500))
    }
}
