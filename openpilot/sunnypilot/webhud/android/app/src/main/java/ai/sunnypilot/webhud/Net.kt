package ai.sunnypilot.webhud

import java.net.Inet4Address
import java.net.InetAddress
import java.net.NetworkInterface

/** An IPv4 network this device is on, such as the hotspot the comma joins. */
data class Subnet(val iface: String, val address: Inet4Address, val prefix: Int) {

    /** Wi-Fi interfaces (where the hotspot is) are searched before any others. */
    val wireless: Boolean get() = WIRELESS.any { iface.startsWith(it) }

    /** Bigger networks are only searched in the /22 around this device: 1022 hosts at most. */
    private val searchedPrefix: Int get() = maxOf(prefix, MIN_SEARCHED_PREFIX)

    /** The searched range, e.g. "192.168.43.0/24". */
    val searched: String get() = "${toInet(toLong(address) and mask(searchedPrefix)).hostAddress}/$searchedPrefix"

    /** Every host address in the searched range except this device's own. */
    fun hosts(): List<Inet4Address> {
        val p = searchedPrefix
        if (p >= 31) return emptyList()
        val self = toLong(address)
        val net = self and mask(p)
        val broadcast = net or (mask(p) xor 0xFFFFFFFFL)
        return (net + 1 until broadcast).filter { it != self }.map(::toInet)
    }

    companion object {
        const val MIN_SEARCHED_PREFIX = 22
        // hotspot interfaces: wlan1/ap0 (AOSP), swlan0 (Samsung), softap0 (Qualcomm), wigig0
        private val WIRELESS = listOf("wlan", "swlan", "ap", "softap", "wl", "wifi", "wigig")

        private fun mask(prefix: Int): Long = (0xFFFFFFFFL shl (32 - prefix)) and 0xFFFFFFFFL

        private fun toLong(a: Inet4Address): Long =
            a.address.fold(0L) { acc, b -> (acc shl 8) or (b.toLong() and 0xFF) }

        private fun toInet(v: Long): Inet4Address = InetAddress.getByAddress(
            byteArrayOf((v shr 24).toByte(), (v shr 16).toByte(), (v shr 8).toByte(), v.toByte())
        ) as Inet4Address
    }
}

object Net {
    // cellular, VPN and translation interfaces never lead to the hotspot
    private val SKIPPED = listOf("rmnet", "ccmni", "r_rmnet", "tun", "ppp", "ipsec", "clat", "v4-", "dummy")

    /** Private IPv4 networks this device is on, Wi-Fi first. */
    fun subnets(): List<Subnet> {
        val ifaces = try {
            NetworkInterface.getNetworkInterfaces()?.toList().orEmpty()
        } catch (e: Exception) {
            emptyList()
        }
        val out = mutableListOf<Subnet>()
        for (ni in ifaces) {
            try {
                if (!ni.isUp || ni.isLoopback || SKIPPED.any { ni.name.startsWith(it) }) continue
            } catch (e: Exception) {
                continue
            }
            for (ia in ni.interfaceAddresses) {
                val a = ia.address as? Inet4Address ?: continue
                if (a.isSiteLocalAddress) out += Subnet(ni.name, a, ia.networkPrefixLength.toInt())
            }
        }
        return out.sortedWith(compareBy({ !it.wireless }, { it.iface }))
    }

    /** "host" or "host:port" as typed by hand; null if it isn't one. */
    fun parseAddress(text: String, defaultPort: Int): Pair<String, Int>? {
        val t = text.trim().removePrefix("http://").trimEnd('/')
        if (t.isEmpty() || t.any { it.isWhitespace() || it == '/' }) return null
        val colon = t.lastIndexOf(':')
        if (colon < 0) return t to defaultPort
        val port = t.substring(colon + 1).toIntOrNull()?.takeIf { it in 1..65535 } ?: return null
        val host = t.substring(0, colon)
        return if (host.isEmpty()) null else host to port
    }
}
