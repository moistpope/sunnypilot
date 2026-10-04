package ai.sunnypilot.webhud

import android.app.Notification
import android.app.NotificationManager
import android.content.ComponentName
import android.content.Context
import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.drawable.BitmapDrawable
import android.graphics.drawable.Drawable
import android.media.MediaMetadata
import android.media.session.MediaController
import android.media.session.MediaSession
import android.media.session.MediaSessionManager
import android.media.session.PlaybackState
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.os.Process
import android.os.SystemClock
import android.provider.Settings
import android.service.notification.NotificationListenerService
import android.service.notification.StatusBarNotification
import android.util.Log
import org.json.JSONObject
import kotlin.concurrent.thread

/**
 * Reads the head unit's media sessions and its navigation's turn-by-turn notification for the HUD
 * (through [Infotainment]). A notification listener is what may see other apps' media sessions and
 * notifications; the app turns itself on as one through root ([grant]).
 *
 * Media: every active session is followed, and the card shows the one playing (else the most recent).
 * Navigation: a notification in the navigation category, or an ongoing one from a known navigation app.
 * Every notification's app and category is logged (not its words), so `adb logcat -s WebHud` shows
 * which app on the head unit gives the turns, should it be none of these.
 */
class HudListener : NotificationListenerService() {

    private val main = Handler(Looper.getMainLooper())
    private val sessions = HashMap<MediaSession.Token, Pair<MediaController, MediaController.Callback>>()
    private var showing: MediaController? = null
    private var navKey: String? = null

    private val manager get() = getSystemService(MediaSessionManager::class.java)
    private val me get() = ComponentName(this, HudListener::class.java)

    private val sessionsChanged = MediaSessionManager.OnActiveSessionsChangedListener { list -> follow(list.orEmpty()) }

    override fun onListenerConnected() {
        Log.i(TAG, "notification listener connected")
        manager.addOnActiveSessionsChangedListener(sessionsChanged, me, main)
        follow(manager.getActiveSessions(me))
        try {
            activeNotifications?.forEach(::posted)
        } catch (e: SecurityException) {
            Log.w(TAG, "can't list notifications: ${e.message}")
        }
    }

    override fun onListenerDisconnected() {
        Log.i(TAG, "notification listener disconnected")
        manager.removeOnActiveSessionsChangedListener(sessionsChanged)
        follow(emptyList())
        navKey = null
        Infotainment.setNav(null, null)
    }

    override fun onNotificationPosted(sbn: StatusBarNotification) = posted(sbn)

    override fun onNotificationRemoved(sbn: StatusBarNotification) {
        if (sbn.key != navKey) return
        navKey = null
        Infotainment.setNav(null, null)
    }

    // ---- media ------------------------------------------------------------------------------------

    private fun follow(list: List<MediaController>) {
        val tokens = list.map { it.sessionToken }.toSet()
        sessions.keys.filter { it !in tokens }.forEach { t -> sessions.remove(t)?.let { (c, cb) -> c.unregisterCallback(cb) } }
        for (c in list) {
            if (c.sessionToken in sessions) continue
            val cb = object : MediaController.Callback() {
                override fun onPlaybackStateChanged(state: PlaybackState?) = pick(list = null)
                override fun onMetadataChanged(metadata: MediaMetadata?) = pick(list = null)
                override fun onSessionDestroyed() = pick(list = null)
            }
            c.registerCallback(cb, main)
            sessions[c.sessionToken] = c to cb
        }
        pick(list)
    }

    /** The session to show: the one playing, else the first in [list] (most recently active first). */
    private fun pick(list: List<MediaController>?) {
        val all = list ?: sessions.values.map { it.first }
        val c = all.firstOrNull { it.playbackState?.state == PlaybackState.STATE_PLAYING }
            ?: showing?.takeIf { s -> all.any { it.sessionToken == s.sessionToken } }
            ?: all.firstOrNull()
        if (c?.sessionToken != showing?.sessionToken) Log.i(TAG, "media: showing ${c?.packageName ?: "nothing"}")
        showing = c
        Infotainment.controller = c
        publishMedia(c)
    }

    private fun publishMedia(c: MediaController?) {
        val md = c?.metadata
        val ps = c?.playbackState
        val title = md?.getString(MediaMetadata.METADATA_KEY_TITLE) ?: md?.getString(MediaMetadata.METADATA_KEY_DISPLAY_TITLE)
        if (c == null || md == null || title.isNullOrBlank()) {
            Infotainment.setMedia(null, null)
            return
        }
        val playing = ps?.state == PlaybackState.STATE_PLAYING
        var position = ps?.position ?: 0L
        val speed = ps?.playbackSpeed?.takeIf { it > 0f } ?: 1f
        if (playing && ps != null && ps.lastPositionUpdateTime > 0) {
            position += ((SystemClock.elapsedRealtime() - ps.lastPositionUpdateTime) * speed).toLong()
        }
        val artist = md.getString(MediaMetadata.METADATA_KEY_ARTIST) ?: md.getString(MediaMetadata.METADATA_KEY_ALBUM_ARTIST)
            ?: md.getString(MediaMetadata.METADATA_KEY_DISPLAY_SUBTITLE)
        val album = md.getString(MediaMetadata.METADATA_KEY_ALBUM)
        val bitmap = md.getBitmap(MediaMetadata.METADATA_KEY_ALBUM_ART) ?: md.getBitmap(MediaMetadata.METADATA_KEY_ART)
            ?: md.getBitmap(MediaMetadata.METADATA_KEY_DISPLAY_ICON)
        val artKey = bitmap?.let { "$title|$artist|${it.width}x${it.height}|${it.generationId}" } ?: ""
        val actions = ps?.actions ?: 0L
        val j = JSONObject()
            .put("pkg", c.packageName)
            .put("app", label(c.packageName))
            .put("title", title)
            .put("artist", artist ?: "")
            .put("album", album ?: "")
            .put("duration", md.getLong(MediaMetadata.METADATA_KEY_DURATION))
            .put("position", position)
            .put("speed", speed.toDouble())
            .put("at", System.currentTimeMillis())
            .put("playing", playing)
            .put("artKey", artKey)
            .put("actions", JSONObject()
                .put("prev", actions and PlaybackState.ACTION_SKIP_TO_PREVIOUS != 0L)
                .put("next", actions and PlaybackState.ACTION_SKIP_TO_NEXT != 0L))
        // the art only when it's new: Infotainment sends it to the page only then anyway
        val art = if (artKey.isNotEmpty() && artKey != lastArtKey) bitmap?.let { Infotainment.dataUrl(it, ART_PX, png = false) } else lastArt
        lastArtKey = artKey
        lastArt = art
        Infotainment.setMedia(j, art)
    }

    private var lastArtKey = ""
    private var lastArt: String? = null

    // ---- navigation -------------------------------------------------------------------------------

    private fun posted(sbn: StatusBarNotification) {
        val n = sbn.notification
        val ongoing = n.flags and Notification.FLAG_ONGOING_EVENT != 0
        Log.d(TAG, "notification: ${sbn.packageName} category=${n.category} ongoing=$ongoing")
        val nav = n.category == Notification.CATEGORY_NAVIGATION || (ongoing && sbn.packageName in NAV_APPS)
        if (!nav) return
        val x = n.extras
        val text = { key: String -> x.getCharSequence(key)?.toString().orEmpty() }
        val j = JSONObject()
            .put("pkg", sbn.packageName)
            .put("app", label(sbn.packageName))
            .put("title", text(Notification.EXTRA_TITLE))
            .put("text", text(Notification.EXTRA_TEXT))
            .put("subText", text(Notification.EXTRA_SUB_TEXT))
            .put("bigText", text(Notification.EXTRA_BIG_TEXT))
            .put("info", text(Notification.EXTRA_INFO_TEXT))
            .put("at", sbn.postTime)
        Log.d(TAG, "navigation: ${j.optString("title")} | ${j.optString("text")} | ${j.optString("subText")}")
        // the turn's picture (Google Maps draws the maneuver as the large icon)
        val icon = try {
            n.getLargeIcon()?.loadDrawable(this)?.let { Infotainment.dataUrl(toBitmap(it), ICON_PX, png = true) }
        } catch (e: Exception) {
            null
        }
        j.put("iconKey", icon?.hashCode()?.toString() ?: "")
        navKey = sbn.key
        Infotainment.setNav(j, icon)
    }

    // ---- helpers ----------------------------------------------------------------------------------

    private val labels = HashMap<String, String>()
    private fun label(pkg: String) = labels.getOrPut(pkg) {
        try {
            packageManager.getApplicationLabel(packageManager.getApplicationInfo(pkg, 0)).toString()
        } catch (e: Exception) {
            pkg
        }
    }

    private fun toBitmap(d: Drawable): Bitmap {
        if (d is BitmapDrawable && d.bitmap != null) return d.bitmap
        val w = d.intrinsicWidth.takeIf { it > 0 } ?: ICON_PX
        val h = d.intrinsicHeight.takeIf { it > 0 } ?: ICON_PX
        val b = Bitmap.createBitmap(w, h, Bitmap.Config.ARGB_8888)
        d.setBounds(0, 0, w, h)
        d.draw(Canvas(b))
        return b
    }

    companion object {
        private const val TAG = "WebHud"
        private const val ART_PX = 256
        private const val ICON_PX = 96

        /** Navigation apps whose ongoing notification is the route, should they not mark it navigation. */
        val NAV_APPS = setOf(
            "com.google.android.apps.maps", "com.waze", "com.here.app.maps", "com.sygic.aura",
            "net.osmand", "net.osmand.plus", "com.mapquest.android.ace", "app.organicmaps",
        )

        fun allowed(context: Context): Boolean {
            val me = ComponentName(context, HudListener::class.java)
            if (Build.VERSION.SDK_INT >= 27) return context.getSystemService(NotificationManager::class.java).isNotificationListenerAccessGranted(me)
            val list = Settings.Secure.getString(context.contentResolver, "enabled_notification_listeners").orEmpty()
            return list.split(':').any { it == me.flattenToString() }
        }

        /**
         * Turns the app on as a notification listener through root, if it isn't already. Blocks (su can
         * wait for the grant prompt): call it off the main thread.
         */
        fun grant(context: Context, root: RootShell) {
            if (allowed(context)) return
            val me = ComponentName(context, HudListener::class.java).flattenToString()
            val user = Process.myUid() / 100_000   // the Android user this runs as (10 on Android Automotive)
            val out = root.run("cmd notification allow_listener $me $user")
            if (out == null) {
                Log.w(TAG, "can't turn on notification access without root: music and navigation stay off " +
                    "(adb shell cmd notification allow_listener $me $user)")
                return
            }
            Log.i(TAG, "notification access: ${if (allowed(context)) "on" else "still off ($out)"}")
            if (allowed(context)) requestRebind(ComponentName(context, HudListener::class.java))
        }

        /** Starts [grant] on a thread of its own. */
        fun grantInBackground(context: Context, root: RootShell) {
            val app = context.applicationContext
            thread(name = "webhud-grant", isDaemon = true) { grant(app, root) }
        }
    }
}
