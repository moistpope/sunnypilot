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

class LocalProxyTest {
    private val unreachable = AtomicInteger()
    private val proxy = LocalProxy { unreachable.incrementAndGet() }
    private val servers = mutableListOf<ServerSocket>()

    init {
        proxy.start()
    }

    @After
    fun tearDown() {
        proxy.stop()
        servers.forEach { it.close() }
    }

    /** A device that answers each line with "<name>:<line>". */
    private fun echo(name: String): InetSocketAddress {
        val server = ServerSocket(0, 50, InetAddress.getLoopbackAddress())
        servers += server
        thread(isDaemon = true) {
            while (!server.isClosed) {
                val s = runCatching { server.accept() }.getOrNull() ?: break
                thread(isDaemon = true) {
                    runCatching {
                        val out = s.getOutputStream()
                        s.getInputStream().bufferedReader().forEachLine { out.write("$name:$it\n".toByteArray()) }
                    }
                    s.close()
                }
            }
        }
        return InetSocketAddress("127.0.0.1", server.localPort)
    }

    private fun open() = Socket("127.0.0.1", proxy.port).apply { soTimeout = 2000 }

    private fun Socket.ask(line: String): String? {
        getOutputStream().write("$line\n".toByteArray())
        return getInputStream().bufferedReader().readLine()
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
        proxy.setDevice(echo("a"))
        open().use { s ->
            assertEquals("a:hello", s.ask("hello"))
            assertTrue(nowMs() - proxy.lastDeviceData < 1000)
        }
    }

    @Test
    fun refusesWithoutADevice() {
        open().use { assertTrue(it.closedByPeer()) }
        proxy.setDevice(echo("a"))
        proxy.paused = true
        open().use { assertTrue(it.closedByPeer()) }
    }

    @Test
    fun switchingDevicesDropsOldConnections() {
        proxy.setDevice(echo("a"))
        open().use { s ->
            assertEquals("a:1", s.ask("1"))
            proxy.setDevice(echo("b"))
            assertTrue(s.closedByPeer())
        }
        open().use { assertEquals("b:2", it.ask("2")) }
    }

    @Test
    fun idleConnectionsAreDropped() {
        proxy.setDevice(echo("a"))
        open().use { s ->
            assertEquals("a:1", s.ask("1"))
            Thread.sleep(50)
            proxy.closeIdle(10)
            assertTrue(s.closedByPeer())
        }
    }

    @Test
    fun unreachableDeviceIsReported() {
        val gone = ServerSocket(0).use { it.localPort }
        proxy.setDevice(InetSocketAddress("127.0.0.1", gone))
        open().use { assertTrue(it.closedByPeer()) }
        assertEquals(1, unreachable.get())
    }
}
