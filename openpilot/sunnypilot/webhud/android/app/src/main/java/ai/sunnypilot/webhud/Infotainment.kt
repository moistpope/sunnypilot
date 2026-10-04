package ai.sunnypilot.webhud

import android.graphics.Bitmap
import android.media.session.MediaController
import android.media.session.PlaybackState
import android.util.Base64
import org.json.JSONObject
import java.io.ByteArrayOutputStream
import java.util.concurrent.CopyOnWriteArraySet

/**
 * What the head unit is playing and the next turn its navigation gives, for the HUD's music and
 * navigation cards (static/js/infotainment.js). [HudListener] fills it in, [MainActivity] passes it to
 * the page. It's kept close to how it came: the notification's own words go to the page, which parses
 * them, so that can change without reinstalling the app. Pictures (album art, the turn's icon) go
 * along only when they change; the page keeps the last one by its key. Main thread.
 */
object Infotainment {

    interface Listener {
        /** [kind] "media" or "nav" changed; [json] is it as the page takes it, or "null" */
        fun onInfotainment(kind: String, json: String)
    }

    private val listeners = CopyOnWriteArraySet<Listener>()
    private var media: JSONObject? = null
    private var art: String? = null       // data URL
    private var nav: JSONObject? = null
    private var icon: String? = null      // data URL
    private var sentArt: String? = null   // the art key / icon key the page has
    private var sentIcon: String? = null

    /** The session the card shows, for its buttons. */
    @Volatile var controller: MediaController? = null

    fun addListener(l: Listener) = listeners.add(l)
    fun removeListener(l: Listener) = listeners.remove(l)

    /** Everything, pictures included: the page asks when it loads. */
    @Synchronized
    fun snapshot(): String {
        sentArt = media?.optString("artKey")
        sentIcon = nav?.optString("iconKey")
        return JSONObject().put("media", withPicture(media, "art", art) ?: JSONObject.NULL)
            .put("nav", withPicture(nav, "icon", icon) ?: JSONObject.NULL).toString()
    }

    /** The page is new (reloaded): it has no pictures yet. */
    @Synchronized
    fun pageReset() {
        sentArt = null
        sentIcon = null
    }

    @Synchronized
    fun setMedia(m: JSONObject?, artUrl: String?) {
        media = m
        art = artUrl
        val key = m?.optString("artKey")
        val send = withPicture(m, "art", if (key != sentArt) artUrl else null)
        sentArt = key
        emit("media", send)
    }

    @Synchronized
    fun setNav(n: JSONObject?, iconUrl: String?) {
        nav = n
        icon = iconUrl
        val key = n?.optString("iconKey")
        val send = withPicture(n, "icon", if (key != sentIcon) iconUrl else null)
        sentIcon = key
        emit("nav", send)
    }

    /** A button on the music card: toggle, next or prev. Any thread. */
    fun command(action: String) {
        val c = controller ?: return
        val t = c.transportControls
        when (action) {
            "toggle" -> if (c.playbackState?.state == PlaybackState.STATE_PLAYING) t.pause() else t.play()
            "next" -> t.skipToNext()
            "prev" -> t.skipToPrevious()
        }
    }

    private fun withPicture(j: JSONObject?, key: String, url: String?): JSONObject? {
        if (j == null) return null
        return if (url != null) JSONObject(j.toString()).put(key, url) else j
    }

    private fun emit(kind: String, j: JSONObject?) {
        val json = j?.toString() ?: "null"
        for (l in listeners) l.onInfotainment(kind, json)
    }

    /** A picture for the page: scaled to fit [max] px, as a data URL. */
    fun dataUrl(b: Bitmap, max: Int, png: Boolean): String {
        val k = minOf(1f, max.toFloat() / maxOf(b.width, b.height))
        val s = if (k < 1f) Bitmap.createScaledBitmap(b, maxOf(1, (b.width * k).toInt()), maxOf(1, (b.height * k).toInt()), true) else b
        val out = ByteArrayOutputStream()
        s.compress(if (png) Bitmap.CompressFormat.PNG else Bitmap.CompressFormat.JPEG, 82, out)
        if (s !== b) s.recycle()
        val type = if (png) "png" else "jpeg"
        return "data:image/$type;base64," + Base64.encodeToString(out.toByteArray(), Base64.NO_WRAP)
    }
}
