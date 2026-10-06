package ai.sunnypilot.webhud

import android.util.Log
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import kotlin.math.cos
import kotlin.math.floor
import kotlin.math.hypot
import kotlin.math.max
import kotlin.math.min

/**
 * Downloads every road tile ([MapTiles]) and feature tile ([MapFeatures]) within a radius of a point, in the
 * background, once asked (`POST /map/prefetch {lat, lon, radius_km}` from the page as the car moves; the
 * page's own copy of the logic is maptiles.py MapPrefetch). Nothing fetched is ever dropped: the next drive
 * through the area needs no network.
 */
class MapPrefetch(private val tiles: MapTiles, private val features: MapFeatures) {
    private val lock = Any()
    private val wake = Object()
    @Volatile private var want: Triple<Double, Double, Double>? = null
    private var busy = false
    private var errors = 0
    private var updated = 0L
    private var thread: Thread? = null

    /** The tile indices (tlat, tlon) of TILE_DEG tiles whose box comes within [radiusM] of the point, nearest first. */
    fun tilesWithin(lat: Double, lon: Double, radiusM: Double): List<Pair<Int, Int>> {
        val mLat = 111_320.0
        val mLon = mLat * max(0.05, cos(Math.toRadians(lat)))
        val dLat = radiusM / mLat
        val dLon = radiusM / mLon
        val out = ArrayList<Triple<Double, Int, Int>>()
        for (tlat in floor((lat - dLat) / TILE).toInt()..floor((lat + dLat) / TILE).toInt()) {
            for (tlon in floor((lon - dLon) / TILE).toInt()..floor((lon + dLon) / TILE).toInt()) {
                val s = tlat * TILE
                val w = tlon * TILE
                if (s < -90 || s >= 90 || w < -180 || w >= 180) continue
                val dy = (max(s, min(lat, s + TILE)) - lat) * mLat
                val dx = (max(w, min(lon, w + TILE)) - lon) * mLon
                val d = hypot(dx, dy)
                if (d <= radiusM) out.add(Triple(d, tlat, tlon))
            }
        }
        out.sortBy { it.first }
        return out.map { Pair(it.second, it.third) }
    }

    fun request(lat: Double, lon: Double, radiusKm: Double): JSONObject {
        require(lat in -90.0..90.0 && lon in -180.0..180.0) { "bad position" }
        val r = radiusKm.coerceIn(0.0, MAX_KM)
        synchronized(lock) {
            want = Triple(lat, lon, r)
            if (thread == null) thread = Thread({ run() }, "webhud-map-prefetch").apply { isDaemon = true; start() }
        }
        synchronized(wake) { wake.notifyAll() }
        return status()
    }

    fun status(): JSONObject {
        val w = want
        val out = JSONObject()
        synchronized(lock) {
            out.put("busy", busy).put("errors", errors).put("updated", updated)
        }
        if (w == null) return out.put("center", JSONObject.NULL).put("radius_km", JSONObject.NULL).put("tiles", 0).put("roads_ready", 0).put("features_ready", 0)
        val list = tilesWithin(w.first, w.second, w.third * 1000.0)
        return out.put("center", JSONArray().put(w.first).put(w.second)).put("radius_km", w.third).put("tiles", list.size)
            .put("roads_ready", list.count { roadFile(it).isFile })
            .put("features_ready", list.count { features.haveTile(it.first, it.second) })
    }

    /** The road tile file for a tile index, as MapTiles names it (downloaded when missing by [MapTiles.tile]). */
    private fun roadFile(t: Pair<Int, Int>): File {
        val (cLat, cLon, name) = roadName(t)
        return File(File(File(tiles.root, cLat.toString()), cLon.toString()), name)
    }

    private fun roadName(t: Pair<Int, Int>): Triple<Int, Int, String> {
        val lat = t.first * TILE + 0.01
        val lon = t.second * TILE + 0.01
        val tLat = floor(lat * 4) / 4
        val tLon = floor(lon * 4) / 4
        val name = "%.6f_%.6f_%.6f_%.6f".format(java.util.Locale.ROOT, tLat, tLon, tLat + 0.25, tLon + 0.25)
        return Triple(floor(lat / 2).toInt() * 2, floor(lon / 2).toInt() * 2, name)
    }

    private fun run() {
        while (true) {
            synchronized(wake) { while (want == null) wake.wait() }
            val w = want ?: continue
            synchronized(lock) { busy = true }
            try {
                for (t in tilesWithin(w.first, w.second, w.third * 1000.0)) {
                    if (want != w) break   // a newer position: start over from there
                    val (cLat, cLon, name) = roadName(t)
                    try {
                        tiles.tile(cLat, cLon, name)   // downloads the 2 deg cell when missing
                    } catch (e: Exception) {
                        Log.w(TAG, "prefetch road tile $name: ${e.message}")
                        synchronized(lock) { errors++ }
                    }
                    if (!features.haveTile(t.first, t.second)) {
                        if (!features.ensureTile(t.first, t.second)) synchronized(lock) { errors++ }
                        Thread.sleep(PAUSE_MS)
                    }
                }
            } finally {
                synchronized(lock) { busy = false; updated = System.currentTimeMillis() / 1000 }
            }
            if (want == w) synchronized(wake) { wake.wait(IDLE_WAIT_MS) }
        }
    }

    companion object {
        private const val TAG = "WebHud"
        private const val TILE = MapFeatures.TILE_DEG
        private const val MAX_KM = 200.0
        private const val PAUSE_MS = 1_000L
        private const val IDLE_WAIT_MS = 60_000L
    }
}
