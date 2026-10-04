package ai.sunnypilot.webhud

import org.junit.Assert.assertTrue
import org.junit.Test

class HwFilterTest {
    @Test
    fun everyReceivedIdPassesTheHardwareFilters() {
        for ((bus, ids) in CanIds.RX) {
            val f = CanIds.HW_FILTERS[bus] ?: error("no filter plan for $bus")
            val blocked = ids.filterNot { f.passes(it) }
            assertTrue("$bus blocks ${blocked.map { "0x%03X".format(it) }}", blocked.isEmpty())
        }
    }

    @Test
    fun theChipsAreTheRightWayRound() {
        assertTrue(CanIds.HW_FILTERS["IBUS1"]!!.chip == 0 && CanIds.HW_FILTERS["IBUS2"]!!.chip == 1)
    }
}
