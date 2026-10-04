# sunnypilot HUD for the car's screen

An Android app that shows the [web HUD](../README.md) full screen on the car's own screen (Pulse,
the add-on board). Pulse runs the Wi-Fi hotspot the comma joins. The page and everything it needs
(its scripts, three.js, the car model, the DBCs) ship inside the APK and are served by the app
itself, so the HUD is up the moment the app starts and runs with or without the comma: the decoding
of the ADAS bus and the world model happen in the page. The app finds the comma on the hotspot by
itself (a browser there can't resolve `sunnypilot.local`), relays its API and its 20 Hz stream to
the page, keeps the HUD up through dropouts, and needs no changes on the comma beyond *Web HUD*
being on (*Settings → Developer*). Without the comma the page shows the car, the car controls (with
the live read-out from IBUS1/IBUS2), the music and the navigation, and keeps the driving data off
the screen (*offline*); the CAN settings, driving settings, playback and signal browser say they need
the comma. A foreground service (`HudService`) keeps the process -- the CAN reader, the link and the
local server -- alive while the HUD isn't on screen.

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

The page is served by the app at `http://127.0.0.1:18088` (`LocalServer`): its files from the APK's
assets (`assets/www/`, copied in from the repo at build time), and `/api/...` and the `/ws` stream
relayed to the comma byte for byte (HTTP and the WebSocket alike). So:

- the page's origin never changes, and its settings (kept in `localStorage`, per origin) survive the
  comma getting a new address;
- when the comma moves, the relay switches under the loaded page, which only reconnects its WebSocket;
- the relay sees the 20 Hz stream, so a healthy link costs no extra requests. When the stream stops,
  the app polls `/api/status`. Three misses in a row (about 9 s after a silent Wi-Fi drop) count as
  lost, and searching starts again with the last address first;
- the page drops a socket that has been silent for 6 s (a Wi-Fi drop can leave it half open) and
  reconnects. When the app finds the device again it tells the page (`webhud:reconnect`) to skip its
  retry backoff;
- a page that failed to load is reloaded with backoff, and a crashed WebView renderer is replaced;
- with the screen off or another app in front the app lets go of the comma, so `webhud` stops reading
  the bus, and reconnects when the HUD is shown again (the CAN reader and the server carry on).

A *Reconnecting…* pill shows at the top while the page is up but the comma isn't. The page's own
chip says *offline*. Back opens a menu: reload, search again, set the address, close.

The screen stays on and the system bars are hidden. Rotation keeps the page. The page's *auto* theme
follows the car's day/night mode.

## Loading fast

Nothing crosses Wi-Fi to start: the page, its scripts, three.js, the ~25 MB car model and the DBCs
are in the APK (`build.gradle.kts` copies them from `webhud/static`, `openpilot/third_party/webhud`
and opendbc into the assets at build time, stored uncompressed so the server streams them from a file
descriptor). Each file carries an `ETag` that changes with every install, and the WebView's cache
checks it with a `304` in between. The service worker a plain browser uses (`static/sw.js`) is not
registered in the app, and one left by an earlier version is unregistered.

The page also tells the app its theme setting (`window.WebHudApp.setTheme`). With *Day* or *Night*
picked in the HUD, the app starts in that mode next time: its window, the WebView behind the page
and the connecting card. So it no longer flashes the car's mode before the page loads. *Auto* keeps
following the car. The page sets its own theme before its first paint.

## Music and navigation

The HUD shows what the head unit is playing (a card at the bottom, with previous, play/pause and next)
and its navigation's next turn (a card at the top, and an arrow on the road once the turn is near).
The app gets them as a notification listener (`HudListener`), which Android lets see other apps'
media sessions and notifications:

- **Media:** every active media session is followed, and the card shows the one playing, else the most
  recent: title, artist, album, art, position and length. Its buttons go to that session's controls.
- **Navigation:** the notification in the *navigation* category, or an ongoing one from a known
  navigation app (Google Maps, Waze, HERE, Sygic, OsmAnd, MapQuest, Organic Maps). Its words go to the
  page as they are (title, text, sub text), and the page reads the distance, the maneuver and the street
  from them, along with the maneuver's picture (Google Maps draws it as the large icon). So the reading
  can be fixed by updating openpilot, without reinstalling the app.

Notification access is turned on at start through the root shell (`cmd notification allow_listener`,
for the Android user the app runs as). Without root, turn it on once by hand:

```
adb shell cmd notification allow_listener ai.sunnypilot.webhud/ai.sunnypilot.webhud.HudListener 10
```

(`10` is the user on Android Automotive; `0` on a phone.) The page asks for everything when it loads
(`window.WebHudApp.infotainment()`), then gets each change as a `webhud:media` or `webhud:nav` event;
album art and the turn's picture go along only when they change. Not tested on the car's head unit yet:
which app gives the turns there (the built-in navigation, or Android Auto / CarPlay from the phone) is
unknown. `adb logcat -s WebHud` lists every notification's app and category (not its words), and the
navigation ones in full at debug level, so it shows which app to add if none of these is it.

## Live car state

Pulse (the add-on SBC the app runs on) has two MCP251x CAN controllers wired to the car: `can1` =
IBUS1, `can2` = IBUS2, both 500 kbit/s. The gateway broadcasts the body, climate, powertrain and
battery status on these buses all the time. The app reads the messages the car-control menus show and
forwards each changed frame to the page, which decodes them (`static/js/carstate.js`) and fills a
"From the car" read-out in those menus.

**Receive only.** The reading is done by a bundled helper, `libcanbridge.so` (`canbridge/main.go`),
which opens the sockets with a receive-only CAN filter and has no transmit path at all — it never
constructs a sendable frame or writes to a socket. `CanBridge.kt` only starts it and reads its stdout.
Nothing in the app or the helper writes to the bus.

The helper is a plain executable shipped as a `.so` so Android installs it into the app's
`nativeLibraryDir`, the one directory an app may exec from (`android:extractNativeLibs="true"`,
`useLegacyPackaging`). It needs no root: an app can open CAN sockets here, the same way Pulse's own app
does. It reads about ten status IDs per bus (kept in step with `static/js/carsignals.js`), forwards
only frames whose payload changed, and the app coalesces them to ~15 Hz. The page asks for the current
state when it loads (`window.WebHudApp.canState()`), then gets changes as `webhud:can` events.

Rebuild the helper (needs only the Go toolchain) with `canbridge/build.sh`. `adb logcat -s WebHud`
shows `CAN helper: ready` and `CAN frames flowing` when it's up.

Pulse drops a large share of received frames (about half on IBUS1, two-thirds on IBUS2): both CAN
controllers share one SPI bus and every interrupt lands on CPU 0. Status messages repeat, so the
read-out still settles; it just lags. Reducing the loss (RT priority on the `mcp251x`/SPI IRQ threads,
or the SoC's own CAN controller) would help this and Pulse's own app.

## Build and install

Needs JDK 17+ and the Android SDK (`ANDROID_HOME`, or `sdk.dir` in `local.properties`).

```
cd openpilot/sunnypilot/webhud/android
./gradlew assembleRelease        # app/build/outputs/apk/release/app-release.apk, ~28 MB (the page and the car model are in it)
./gradlew testDebugUnitTest      # JVM tests: subnet math, ARP parsing, status probe, sweep, relay
adb install -r app/build/outputs/apk/release/app-release.apk
```

Release builds are signed with the debug key, since the app is sideloaded, not published.

The APK must be rebuilt for a change to the page (its files are copied in at build time); the comma
serves the same files to a plain browser, so the two come from one checkout.

On Android Automotive, an app that isn't *distraction optimized* is blocked while driving. The
activity declares `distractionOptimized`, but on user builds the car service only honors that for
system apps or apps from an allowlisted store. If the HUD is blocked when the car moves, install it
as a system app on the rooted head unit (e.g. under `/system/priv-app`).

## Debugging

`adb logcat -s WebHud` shows how the comma was found, sweeps (debug level), losses and reloads, and
the media session and navigation notification the HUD is showing. The
WebView can be inspected from `chrome://inspect` on a computer with adb access to the head unit.
