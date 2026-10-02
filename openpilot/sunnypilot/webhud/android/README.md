# sunnypilot HUD for the car's screen

An Android app that shows the [web HUD](../README.md) full screen on the car's own head unit. The
head unit runs the Wi-Fi hotspot the comma joins. The app finds the comma there by itself (a browser
on the head unit can't resolve `sunnypilot.local`), keeps the HUD up through dropouts, and needs no
changes on the device beyond *Web HUD* being on (*Settings → Developer*).

## How it finds the comma

Every 1.5 s while searching, all of these are asked for `/api/status` (port 8088) at once. The first
to answer as the HUD server (a 200 with its `version`, `hostname`, `urls`) wins:

1. an address set by hand (back → *Device address…*), and the last one that worked;
2. every host in the ARP table. The comma is listed as soon as it gets a DHCP lease. Apps can't read
   `/proc/net/arp` on Android 10+, so it's read through one long-lived `su` shell: grant it once on
   the rooted head unit. Without root this step is skipped and the sweep does the work;
3. hosts an earlier sweep found up but not serving port 8088 yet: a comma that has joined the hotspot
   while openpilot is still starting. These are polled until it answers.

Then every private IPv4 network the head unit is on is swept: Wi-Fi interfaces (the hotspot) first,
networks bigger than /22 narrowed to the /22 around the head unit. All connects to port 8088 go out
at once (non-blocking), so a /24 takes about a second. Sweeps repeat 2, 3, 5, 8, then every 10 s
while nothing answers, and right away when the head unit joins or leaves a network (Android can pick
a new hotspot subnet each time the hotspot starts).

## Staying connected

The page comes through a relay inside the app at `http://127.0.0.1:18088`, which passes HTTP and the
WebSocket to the comma byte for byte. So:

- the page's origin never changes, and its settings (kept in `localStorage`, per origin) survive the
  comma getting a new address;
- when the comma moves, the relay switches under the loaded page, which only reconnects its WebSocket;
- the relay sees the 20 Hz stream, so a healthy link costs no extra requests. When the stream stops,
  the app polls `/api/status`. Three misses in a row (about 9 s after a silent Wi-Fi drop) count as
  lost, and searching starts again with the last address first;
- the page drops a socket that has been silent for 6 s (a Wi-Fi drop can leave it half open) and
  reconnects. When the app finds the device again it tells the page (`webhud:reconnect`) to skip its
  retry backoff;
- a part of the page that failed to load (script, model) triggers a reload with backoff, and a
  crashed WebView renderer is replaced;
- in the background the app lets go of the comma, so `webhud` stops reading the bus, and reconnects
  when it's shown again.

A *Reconnecting…* pill shows at the top while the page is up but the comma isn't. The page's own
chip says *offline*. Back opens a menu: reload, search again, set the address, close.

The screen stays on and the system bars are hidden. Rotation keeps the page. The page's *auto* theme
follows the car's day/night mode.

## Build and install

Needs JDK 17+ and the Android SDK (`ANDROID_HOME`, or `sdk.dir` in `local.properties`).

```
cd openpilot/sunnypilot/webhud/android
./gradlew assembleRelease        # app/build/outputs/apk/release/app-release.apk, ~50 KB
./gradlew testDebugUnitTest      # JVM tests: subnet math, ARP parsing, status probe, sweep, relay
adb install -r app/build/outputs/apk/release/app-release.apk
```

Release builds are signed with the debug key, since the app is sideloaded, not published.

On Android Automotive, an app that isn't *distraction optimized* is blocked while driving. The
activity declares `distractionOptimized`, but on user builds the car service only honors that for
system apps or apps from an allowlisted store. If the HUD is blocked when the car moves, install it
as a system app on the rooted head unit (e.g. under `/system/priv-app`).

## Debugging

`adb logcat -s WebHud` shows how the comma was found, sweeps (debug level), losses and reloads. The
WebView can be inspected from `chrome://inspect` on a computer with adb access to the head unit.
