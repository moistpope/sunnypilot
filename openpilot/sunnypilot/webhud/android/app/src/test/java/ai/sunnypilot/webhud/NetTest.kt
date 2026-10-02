package ai.sunnypilot.webhud

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.net.InetAddress
import java.net.Inet4Address

class NetTest {
    private fun ip(s: String) = InetAddress.getByName(s) as Inet4Address

    @Test
    fun hotspotSubnetListsEveryOtherHost() {
        val net = Subnet("wlan1", ip("192.168.43.1"), 24)
        val hosts = net.hosts().map { it.hostAddress }
        assertEquals(253, hosts.size)
        assertEquals("192.168.43.2", hosts.first())
        assertEquals("192.168.43.254", hosts.last())
        assertFalse("192.168.43.1" in hosts)   // ourselves
        assertEquals("192.168.43.0/24", net.searched)
        assertTrue(net.wireless)
    }

    @Test
    fun bigNetworksAreNarrowedToTheSlash22AroundUs() {
        val net = Subnet("eth0", ip("10.0.2.15"), 8)
        assertEquals("10.0.0.0/22", net.searched)
        val hosts = net.hosts()
        assertEquals(1021, hosts.size)
        assertEquals("10.0.0.1", hosts.first().hostAddress)
        assertEquals("10.0.3.254", hosts.last().hostAddress)
        assertFalse(net.wireless)
    }

    @Test
    fun highAddressesDontOverflow() {
        val hosts = Subnet("ap0", ip("192.168.255.254"), 24).hosts()
        assertEquals("192.168.255.1", hosts.first().hostAddress)
        assertEquals("192.168.255.253", hosts.last().hostAddress)
    }

    @Test
    fun pointToPointLinksHaveNoOtherHosts() {
        assertTrue(Subnet("wlan0", ip("10.1.2.3"), 31).hosts().isEmpty())
        assertTrue(Subnet("wlan0", ip("10.1.2.3"), 32).hosts().isEmpty())
    }

    @Test
    fun parsesTypedAddresses() {
        assertEquals("192.168.43.57" to 8088, Net.parseAddress(" 192.168.43.57 ", 8088))
        assertEquals("192.168.43.57" to 80, Net.parseAddress("192.168.43.57:80", 8088))
        assertEquals("comma.local" to 8088, Net.parseAddress("http://comma.local:8088/", 8088))
        assertNull(Net.parseAddress("", 8088))
        assertNull(Net.parseAddress("192.168.43.57:99999", 8088))
        assertNull(Net.parseAddress("192.168.43.57:", 8088))
        assertNull(Net.parseAddress("a b", 8088))
    }

    @Test
    fun arpTableSkipsIncompleteAndPublicEntries() {
        val arp = """
            IP address       HW type     Flags       HW address            Mask     Device
            192.168.43.57    0x1         0x2         3c:22:fb:01:02:03     *        wlan1
            192.168.43.80    0x1         0x0         00:00:00:00:00:00     *        wlan1
            10.0.2.2         0x1         0x2         52:55:0a:00:02:02     *        wlan0
            8.8.8.8          0x1         0x2         52:55:0a:00:02:09     *        rmnet0
        """.trimIndent()
        assertEquals(setOf("192.168.43.57", "10.0.2.2"), Neighbors.parseArp(arp))
    }
}
