package ai.sunnypilot.webhud

import android.util.Log
import java.io.File

/**
 * Pulse's CAN driver (an out-of-tree mcp251x) programs the two chips' hardware acceptance filters from
 * module parameters under /sys/module/mcp251x/parameters: per chip (0 = can1 = IBUS1, 1 = can2 = IBUS2)
 * `rxb_mask_<chip>` = "mask for buffer 0,mask for buffer 1", `rxb_filter_<chip>` = the six filters, and
 * `apply_filters` to program them. Its defaults pass only parts of the ID range and lose the steering
 * angle, yaw rate, seat and liftgate positions, battery current and charging times. This writes the plan
 * from [CanIds.HW_FILTERS] (generated: the tightest filters letting every received ID through) at start:
 * through the root shell when the files aren't writable by the app, and it reports what the driver
 * ended up with. Nothing here touches what is sent.
 */
object HwFilters {
    private const val TAG = "WebHud"
    private const val DIR = "/sys/module/mcp251x/parameters"

    /** The parameter files, or null when this device has no such driver. */
    private fun dir(): File? = File(DIR).takeIf { it.isDirectory }

    fun current(): Map<String, String> {
        val d = dir() ?: return emptyMap()
        return listOf("rxb_mode_0", "rxb_mode_1", "rxb_mask_0", "rxb_mask_1", "rxb_filter_0", "rxb_filter_1")
            .associateWith { runCatching { File(d, it).readText().trim() }.getOrDefault("?") }
    }

    /** Whether the driver already passes everything we receive. */
    fun satisfied(): Boolean {
        val now = current()
        return CanIds.HW_FILTERS.all { (_, f) ->
            now["rxb_mask_${f.chip}"] == "${f.mask0},${f.mask1}" && now["rxb_filter_${f.chip}"] == (f.filters0 + f.filters1).joinToString(",")
        }
    }

    /**
     * Apply the plan. Returns null when the driver reports the wanted values afterwards, else why not.
     * Blocks (the root shell can take a moment): not on the main thread.
     */
    fun apply(root: RootShell?): String? {
        val d = dir() ?: return "no mcp251x driver parameters on this device"
        if (satisfied()) return null
        val script = StringBuilder()
        for ((_, f) in CanIds.HW_FILTERS) {
            script.append("echo '${f.mask0},${f.mask1}' > $DIR/rxb_mask_${f.chip}; ")
            script.append("echo '${(f.filters0 + f.filters1).joinToString(",")}' > $DIR/rxb_filter_${f.chip}; ")
        }
        script.append("echo 1 > $DIR/apply_filters")
        var how = "directly"
        val wrote = runCatching {
            for ((_, f) in CanIds.HW_FILTERS) {
                File(d, "rxb_mask_${f.chip}").writeText("${f.mask0},${f.mask1}\n")
                File(d, "rxb_filter_${f.chip}").writeText((f.filters0 + f.filters1).joinToString(",") + "\n")
            }
            File(d, "apply_filters").writeText("1\n")
            true
        }.getOrDefault(false)
        if (!wrote) {
            how = "through root"
            val out = root?.run(script.toString()) ?: return "the parameters aren't writable and there's no root shell"
            if (out.contains("denied", ignoreCase = true) || out.contains("Permission", ignoreCase = true)) return "root refused: ${out.trim()}"
        }
        val now = current()
        Log.i(TAG, "CAN hardware filters set $how: $now")
        return if (satisfied()) null else "the driver kept its own values: $now"
    }
}
