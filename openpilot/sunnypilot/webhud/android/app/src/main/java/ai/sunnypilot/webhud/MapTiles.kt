package ai.sunnypilot.webhud

import android.util.Log
import java.io.BufferedInputStream
import java.io.Closeable
import java.io.File
import java.io.FileOutputStream
import java.io.IOException
import java.io.InputStream
import java.io.OutputStream
import java.net.HttpURLConnection
import java.net.URL
import java.util.concurrent.ConcurrentHashMap
import java.util.zip.GZIPInputStream

/**
 * The OSM road tiles the page's map matcher reads (static/js/world/osmtile.js): the files sunnypilot's
 * mapd uses, one packed Cap'n Proto message per 0.25 deg tile, in 2 x 2 deg cells named by their
 * south-west corner on the even grid. The page asks the local server for `/map/tile/<lat>/<lon>/<name>`;
 * a tile not under [root] has its whole cell downloaded from pfeiferj's server (20-50 MB, once) and
 * unpacked there, so the next drive through the area works without the network.
 */
class MapTiles(private val root: File) {
    private val locks = ConcurrentHashMap<String, Any>()
    private val failedAt = ConcurrentHashMap<String, Long>()

    /** The tile's file, downloading its cell first when needed; null when it can't be had. */
    fun tile(lat: Int, lon: Int, name: String): File? {
        if (!NAME.matches(name) || lat % 2 != 0 || lon % 2 != 0 || lat !in -90 until 90 || lon !in -180 until 180) return null
        val file = File(File(File(root, lat.toString()), lon.toString()), name)
        if (file.isFile) return file
        val key = "$lat/$lon"
        synchronized(locks.getOrPut(key) { Any() }) {
            if (file.isFile) return file
            val failed = failedAt[key]
            if (failed != null && System.currentTimeMillis() - failed < RETRY_MS) return null
            try {
                fetchCell(lat, lon)
            } catch (e: Exception) {
                Log.w(TAG, "map cell $key download failed: ${e.message}")
                failedAt[key] = System.currentTimeMillis()
                return null
            }
        }
        return if (file.isFile) file else null
    }

    private fun fetchCell(lat: Int, lon: Int) {
        val dest = File(File(root, lat.toString()), lon.toString())
        dest.mkdirs()
        val url = URL("$BASE_URL/$lat/$lon.tar.gz")
        Log.i(TAG, "downloading map cell $url")
        val conn = url.openConnection() as HttpURLConnection
        conn.connectTimeout = CONNECT_TIMEOUT_MS
        conn.readTimeout = READ_TIMEOUT_MS
        try {
            if (conn.responseCode != 200) throw IOException("HTTP ${conn.responseCode}")
            val prefix = "offline/$lat/$lon/"
            var files = 0
            TarReader(GZIPInputStream(BufferedInputStream(conn.inputStream, 1 shl 16))).use { tar ->
                while (true) {
                    val entry = tar.next() ?: break
                    if (!entry.isFile || !entry.name.startsWith(prefix)) continue
                    val name = entry.name.removePrefix(prefix)
                    if (!NAME.matches(name)) continue
                    val part = File(dest, "$name.part")
                    FileOutputStream(part).use { tar.copyTo(it) }
                    if (!part.renameTo(File(dest, name))) throw IOException("could not place $name")
                    files++
                }
            }
            Log.i(TAG, "map cell $lat/$lon: $files tiles in $dest")
        } finally {
            conn.disconnect()
        }
    }

    companion object {
        private const val TAG = "WebHud"
        const val BASE_URL = "https://map-data.pfeifer.dev/offline"
        private const val RETRY_MS = 60_000L
        private const val CONNECT_TIMEOUT_MS = 15_000
        private const val READ_TIMEOUT_MS = 60_000
        val NAME = Regex("^-?\\d{1,3}\\.\\d{6}_-?\\d{1,3}\\.\\d{6}_-?\\d{1,3}\\.\\d{6}_-?\\d{1,3}\\.\\d{6}$")

        /** `/map/tile/<lat>/<lon>/<name>` -> (lat, lon, name), or null. */
        fun parsePath(path: String): Triple<Int, Int, String>? {
            val parts = path.split('/')
            if (parts.size != 6 || parts[1] != "map" || parts[2] != "tile") return null
            val lat = parts[3].toIntOrNull() ?: return null
            val lon = parts[4].toIntOrNull() ?: return null
            return Triple(lat, lon, parts[5])
        }
    }
}

/** Just enough of the tar format for the cells: ustar headers, regular files, sizes in octal. */
private class TarReader(private val input: InputStream) : Closeable {
    class Entry(val name: String, val size: Long, val isFile: Boolean)

    private var left = 0L   // bytes of the current entry (data and padding) not yet consumed
    private var data = 0L   // of which file data

    fun next(): Entry? {
        skipFully(left)
        left = 0
        data = 0
        val header = ByteArray(512)
        if (!readFully(header)) return null
        if (header.all { it == 0.toByte() }) return null   // the end-of-archive blocks
        val name = text(header, 0, 100)
        val prefix = if (text(header, 257, 6).startsWith("ustar")) text(header, 345, 155) else ""
        val sizeText = text(header, 124, 12).trim()
        val size = if (sizeText.isEmpty()) 0L else sizeText.toLong(8)
        val type = header[156].toInt().toChar()
        data = size
        left = size + (512 - size % 512) % 512
        return Entry(if (prefix.isEmpty()) name else "$prefix/$name", size, type == '0' || type == '\u0000')
    }

    /** The current entry's data to [out] (once, right after [next]). */
    fun copyTo(out: OutputStream) {
        val buf = ByteArray(1 shl 16)
        while (data > 0) {
            val n = input.read(buf, 0, minOf(buf.size.toLong(), data).toInt())
            if (n < 0) throw IOException("archive ended early")
            out.write(buf, 0, n)
            data -= n
            left -= n
        }
    }

    private fun text(h: ByteArray, off: Int, len: Int): String {
        var end = off
        while (end < off + len && h[end] != 0.toByte()) end++
        return String(h, off, end - off, Charsets.ISO_8859_1)
    }

    private fun readFully(buf: ByteArray): Boolean {
        var got = 0
        while (got < buf.size) {
            val n = input.read(buf, got, buf.size - got)
            if (n < 0) return false
            got += n
        }
        return true
    }

    private fun skipFully(n: Long) {
        var toSkip = n
        while (toSkip > 0) {
            val skipped = input.skip(toSkip)
            if (skipped <= 0) {
                if (input.read() < 0) throw IOException("archive ended early")
                toSkip -= 1
            } else {
                toSkip -= skipped
            }
        }
    }

    override fun close() = input.close()
}
