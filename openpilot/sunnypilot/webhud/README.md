# sunnypilot web HUD

A Tesla-style car view for a browser on the same network as the comma device — built for the Fisker
Ocean's own center screen. Shows speed, gear, MADS steering state, ACC set speed and time gap, speed
limit, alerts, the ADAS module's lane lines and object list in 3D, parking sensors, and lets you edit
the CAN overrides in `opendbc/car/fisker/values.py` and replay recorded routes.

The ego car mirrors the real one: a detailed, rigged Ocean model (Pulse Ocean v0.10, at its true
size in meters) in any of the factory paints and five wheel options (Settings > Display). A fine
textured ground moves under it with speed and steering (dead-reckoned about the rear axle with the
bicycle model from `steeringAngleDeg`), the wheels roll and the front pair steers, and the model's own
lamps light up, following the BCM's lamp outputs (`BCM_0x335`, falling back to carState): DRLs,
headlights, the lower front strips (white DRL, amber while indicating), quarter-panel and rear turn
indicators, tail, brake, third brake light and reversing lamps (`static/js/lamps.js`). The red and amber
lamps get a soft glow so they read from the chase camera. The car reflects a soft studio environment of its own
(`studioEnvironment` in `scene.js`), so its glossy paint, glass and chrome trim catch highlights.

Lanes and objects are filtered before drawing (`static/js/road.js`, `scene.js`): lane lines are
carried with the car's motion and eased toward each measurement by confidence, with hysteresis on
validity; objects are tracked with an alpha-beta filter. The default *Blended* lane source takes
the ADAS lines and refines each with openpilot's matching line where they agree, adding lines only
openpilot sees when it's confident. Lanes neither reports are filled in as a softer, inferred road:
lane count and width from ADAS lines/lane info and openpilot's outer lines and road edges (the road
between the edges is split into lanes and the car put in its slot), held for a while, else the
car's own path. A lane count drops only after 8 s without the lane, since the outer lines flicker.
The cameras name lines by where they are from the car, so a lane change renames every line at once.
That's recognized (both ego lines a lane over from where the carried lane puts them), and the carried
road is renamed with them, so it stays put on the ground instead of sliding a lane sideways.

Lanes are drawn only when the HUD is confident of them. *Lane confidence* is spatio-temporal: it's
kept on stations fixed to the road every 5 m of distance driven, from just behind the car to 100 m
ahead, so what was learned about a stretch of road stays with it as the car drives onto it. Each
station eases toward how much stable lane evidence there is at its distance: the ego lane's lines
where they're plausible (on their side of the car, a lane's width apart, along our heading),
weighted by their confidence, by how far ahead they can be trusted, and by how stable they've been
(a running mean of how far each new measurement lands from where the carried line predicted it), or
else openpilot's road edges. It rises within a second or so and falls slowly: over 10 s standing
still, faster with distance driven (2 s in Park), so a lane has to hold steady to be trusted and a
short dropout doesn't lose it. The lanes show once the stations over the next 30 m average past the
threshold (*Display → Lane confidence*, 50% by default, with a live readout), and hide below 80% of
it. On the logged drive, clean highway lanes show 1–2 s after they appear and settle at 90–97%.

The ground (`static/js/ground.js`) is drawn as one field with the road. With no lanes to show (at
start, in a parking lot, at low speed without lines) it's a disc of about 10 m radius around the car
that fades out over its outer half. Once the lanes show, the disc grows out into the road, first
across to the outer lines plus a shoulder, then down the road as far as the lane confidence reaches
(70–80 m on the highway), fading out at the far end. Disc and road are signed distance fields joined
with a smooth minimum, the road's computed in its own coordinates (station along it and offset across
it, exact for the arcs the lines are drawn as), and every part of the shape is eased on springs. So
any change morphs: lanes found or lost, a lane added or dropped, the road bending. The edge is
roughened with noise fixed to the ground, which ripples and flows while the shape is changing and
holds still when it isn't. Lane lines, stop lines, crosswalks and the headlight throw are cut by the
same field, so they grow, bend and dissolve with the road. Ground texture and inferred road can be
turned off under *Display*.

Traffic lights, signs and road markings (`static/js/furniture.js`) come from the car's ADAS camera
only; sunnypilot adds map speed limits (`liveMapDataSP`) but no signs or lights. The camera reports
what it saw and, for lights and markings, how far ahead, never where across the road: the ego-lane
traffic light (color, arrow, solid/blinking, lamp count, orientation) floats over our lane at its
distance (else the stop line's or a landmark's, else an estimate); a speed-limit sign the camera
just read (`ADAS_TSRSts` Vision mode or a new value) or a prohibition sign (`ADAS_FobdSign`) goes up
at the roadside a little ahead, beyond the outer lane on our side; stop lines and crosswalks are
drawn across the road at their distance. All of them are anchored to the road, not to the ground: a
station down the road (distance driven) and an offset across it, placed each frame on the road as
it's drawn then (`RoadModel.place`). A sign 50 m down a road drawn curving left that turns out to
run straight is, 10 m later, 40 m down the straight road and still beside it. The camera doesn't
classify stop or yield signs. The ICC also
sends an ADASIS v2 map horizon (`ICC_0x250`..`0x255`, `0x361`) with map signs and lanes per
direction; its sign type table isn't in the matrix, so it isn't used yet.

*Power trails* (`static/js/tracks.js`, *Display*): the rear tires leave trails of fine glowing
particles on the road, a dense bright band as wide as each tire with a soft glow about it and
sparser dust that spreads out behind, colored by how hard the motors are asked to pull when each is
laid: blue at a light load through the spectrum to red at full power (150 kW demanded, or 6000 Nm of
wheel torque for a hard launch; regen counts as light), and denser with more dust the harder the car
pulls. Laid particles keep their color, so a burst of power slides back behind the car as a red
stretch. The trail grows with speed to one car length at 70 mph and fades out toward its end. The
load is the
driver's torque request per axle (`VCU_0x102`, wheel torque) times motor speed (`MCU_F_0x150`,
`MCU_R_0x151`) over the ~11.5:1 drive ratio; on other cars it's estimated from openpilot's
acceleration. The chase camera also backs off with speed, up to 1.5x its distance at 70 mph,
keeping any zoom you set. In every view the camera's heading follows the car's on a critically
damped spring (`CAM_YAW_W` in `scene.js`, at most 0.6 rad behind): in a sharp low-speed turn the car
swings round in the frame and the camera catches up as it straightens out; on the highway the lag
is a degree or two.

*Radar objects* (*Display*, off by default): the tracks of the car's mid-range radar, read from its
private CAN-FD link on panda bus 1 (`fisker_radar.py`), drawn as see-through teal cars with a ring on
the ground at the point each track reports. It's there to check the radar decoding against the
camera's cars before the radar feeds openpilot. The radar's messages aren't in the FM29 matrix:
`opendbc/dbc/fisker_ocean_mrr.dbc` is reverse-engineered from a drive, and its comments
say how each scale was checked and which are still open. Tracks are drawn close to raw (each 65 ms
cycle's position, carried on the radar's own velocity for at most a cycle), so a scale or sign error
shows up as an offset from the camera's car; like those cars, a car ahead sits with its rear on the
reported point. A chip at the top right shows the radar's track count, or *no bus 1 data* when the log (or harness)
has no radar frames.

*Objects* (*Display*): the default *World model* (`world_model.py`) fuses the radar, the ADAS camera list
and openpilot's leads into one object set in a ground-fixed frame: each measurement is placed at the
time it was taken (radar MeasTime from the bus's time sync; the others by typical latency) using an
ego pose dead-reckoned from ESP wheel speed and the YRS yaw-rate gyro, and weighted by its source's
noise model (radar: range and Doppler; camera: bearing, class, size; openpilot leads only corroborate
on this car). The view anchors the objects to the ground, so parked cars stay put through turns; the
scene's own ego motion now uses the gyro too. *Raw sources* draws each source as it reports. Radar
tracks younger than 1.3 s are hidden unless *All radar tracks* is on. A world object is drawn with its
center half a car length beyond the reported point along the car's own axis (half a width when seen
side-on), since every source reports the face nearest us.

Before fusing, each source is corrected by the *measured sensor calibration* (`MEASURED_CALIBRATION` in
`world_model.py`, *Display → Geometry calibration*, on by default). Its values come from replaying
`000000b5--bfe13ac451` and `000000b4--d0f733ebb2` against GPS, openpilot's leads and lane lines:
- The ADAS object list's range is 0.8× the radar's plus ~3 m (~0.25 m/bit from about the rear axle), so
  it's read as `x / 0.80 − 3.7`.
- Its lateral reads 1.35× too wide.
- Its latency is ~0.23 s.
- The radar's Doppler is 1/16 m/s per bit (not 0.06), and its output is turned 0.6° left.
- The wheel speed reads 3.1% under GPS, which the odometry and the view's ego motion correct.
- openpilot's leads read 0.2 m short (the camera is ~1.72 m behind the radar).

Uncorrected, a car the ADAS list and the radar both see splits in two at range and the copies cross at
~10–15 m. The switch applies to every viewer until the HUD restarts (`PUT /api/calibration`). The radar
sometimes sends a cycle twice, and `fisker_radar.py` hands each cycle out once. openpilot's `leadTwo`
(its lead 2 s from now) only counts when it's clearly another car than `leadOne`. Two tracks one radar or
ADAS id fed within a second are merged.

Each world-model object has a confidence, and the view fades it in between 35% and 65% and hides it
below that. The radar measures no elevation (nothing decoded so far gives height), so overhead
traffic lights, sign gantries and bridges read as stopped cars in our lane until it passes under
them and drops the track (radar track 791 on `000000b5--bfe13ac451--12` at 0:45–0:48: a traffic
light the radar called a 3 m wide, 0.6 m long car, dropped 24 m out). A camera positively
classifying an object (an ADAS class, or an openpilot lead) settles it at 100%. The radar alone
never shows a point target it hasn't classified: that takes a second, camera detection (anything in
the ADAS list, or an openpilot lead). A class counts once the radar has given it for 5 cycles, since
a class can flicker on for a single cycle (radar track 468). A radar-only object it has classified
stays hidden until its radar track has lasted 1.3 s. After that it gets 85% if it moves over the
ground and 60% (drawn a little see-through) if it stands. A standing object drops to about 33% if
the radar has drawn it at least 4 times wider than long and 1.5 m wide, and to 15% once openpilot's
model has missed it for 0.5 s in plain view: standing within 1.5 m of our path, 8–80 m ahead, above
5 m/s, with no camera-seen or moving object in front of it. Once no source has reported an object for
0.3 s it can't rise; a moving one fades out (*coasting*) rather than carry on along a velocity that's
now a guess, while a standing one waits (a parked car the radar loses in a turn). *Low-confidence objects*
(*Display*, off by default) draws the hidden ones faintly, and *Object stats* gives each object's
confidence and the reason for it (*vision*, *moving*, *standing*, *thin*, *unseen*, *young*,
*unclassified*, *coasting*). Paused, each object shows its settled confidence.

*Object stats* (*Display*, off by default, `static/js/labels.js`): a debug tag over every object the
view draws, giving its source (the ADAS camera's list, an openpilot lead, the radar), track ID and
class, position (x ahead, y left/right), speed over the ground and relative, heading and size, in m,
m/s and degrees. The ADAS list has no speeds; its tags show this view's tracking estimate (*est*). An
openpilot lead merged into an ADAS car is listed on that car's tag. Tags stack instead of overlapping,
so an object two sources report shows both.

Music and navigation (`static/js/infotainment.js`, *Display*, on): on the car's screen, the Android
app passes on what the head unit is playing and its navigation's next turn (see
[`android/`](android/README.md#music-and-navigation)). What's playing shows in a card at the bottom
with its art, progress and previous / play-pause / next, which control the head unit's player. The
next turn shows in a card at the top: the maneuver, its distance, the street and the trip (time,
distance, arrival). Within 160 m an arrow lies on the ego lane at the turn, bending the way it goes
(`static/js/navarrow.js`). The navigation app rounds its distances (0.3 mi is anywhere from 0.25 to
0.35), so the turn is pinned to the road when it's first given and carried along with the car, and
each later distance only nudges it back inside what that distance allows. In a plain browser, without
the app, neither card shows. *Display → Debug → Demo music & navigation* plays a made-up playlist and
route (the turns come nearer as the car drives), for trying them without the car.

Frame rate (`static/js/perf.js`, *Display → Debug*, on for now): a counter under the status card,
over the car controls' panel. Tap it for the slowest frame of the last second, the HUD's own script
time per frame, draw calls, triangles and the render resolution. *Render resolution* is *Auto* by
default: while frames come slower than the screen refreshes (88% of it, two seconds running), it first
drops the blur behind the HUD's cards, then lowers the 3D view's resolution in steps to 60%, and brings
them back a step at a time once frames have kept up for 8 s (a step that slows things straight down
again waits a minute). *Full*, *75%* and *50%* fix it, for comparing on the car.

Loading: static files carry an `ETag`/`Last-Modified`, and the server answers a current copy with
`304`. The page's service worker (`static/sw.js`) keeps the car model, three.js and the app's files
in Cache Storage and checks them on each load, so the ~25 MB model crosses the network once. It
needs a secure context, such as the Android app's `http://127.0.0.1` or `localhost`. A plain
`http://sunnypilot.local` browser tab uses the HTTP cache instead. The day/night theme is applied
from the saved setting before the first paint.

**Open:** `http://sunnypilot.local:8088` (or `http://<device-ip>:8088`; port 80 is also served when
the process is allowed to bind it). Toggle: *Settings → Developer → Web HUD* (`EnableWebHud`, on by
default). On the car's own screen, where the comma joins the head unit's hotspot and `.local` names
don't resolve, use the Android app in [`android/`](android/README.md): it finds the comma on the
hotspot, runs the HUD full screen and rides out dropouts.

## Car controls mockup

A look at fuller car controls on top of the HUD (this branch only). Nothing in it reaches the car: the
settings live in the page, in memory, and its modules (`static/js/carcontrols.js`, `carcatalog.js`,
`cutaway.js`, `apamock.js`) make no requests. The panels and the ribbon say so, so its driver-assistance switches
aren't mistaken for the *CAN settings* tab.

Tap the car. A ribbon of categories slides up, the camera goes to a top view with the roof (everything
between the side rails above the doors, and the rear window) faded to a faint outline so the cabin
shows, and the part of the car each category is about pulses in turn under a badge. A badge, a part or
a ribbon item opens its category; a tap on the background goes back, and from there (or with ✕)
closes it and restores the car and your view. Auto view and the replay bar wait while it's open.

The car's parts come first: Lighting, Climate, Seats, Driving, Assist, Energy, Audio, Doors & Windows,
Service and Display; then Connectivity, Profiles & Keys, Navigation, General and Software. Lighting and Seats put
their settings on cards beside the lamps and seats (in a panel when the screen is too narrow for them);
the rest open a half-screen panel, beside the car in landscape and under it in portrait, with the car
framed in what's left. Each category moves the camera to its part and shows its settings on the car:
the lighting preview drives the model's lamps; seat heat glows orange, and the seat's adjusters (the
cushion slides, its front and rear edges rise and drop, the back reclines) move the model's seat;
Climate blows air from the vents, tinted by each side's temperature; Seats
and Driving turn the rest of the car see-through; Driving shows the drive units in x-ray, and a drive
mode change sends a ring of particles out from the car in the mode's color (Earth green, Fun blue,
Hyper orange), styled like the tire trails; Assist draws the sensors' coverage on the ground; Energy
opens a charge-port door on the left front fender and fills an x-ray battery to the charge level;
Audio lights the trunk amplifier and rings over the seats of the chosen sound stage; Doors & Windows
locks and unlocks, swings the doors and the liftgate open, winds each of the four door windows, the two
quarter (doggie) windows and the rear window down to where its slider says (its own top edge, curved or
slanted, sinking into the door), opens or tilts the sunroof (its front panel lifts and slides back over
the rear one), and California Mode opens all eight windows at once. Each door's chip on the car has a
button for the door and one for its window, and rides on the door. Display's Hollywood Mode turns the
center screen to landscape.

*Mock APA* (*Assist → Parking*) demos automated parking in a parking lot drawn around the car. The car
scans along the aisle and reports the open spaces it passes; you pick one (on the ground or in the
panel), the ADAS confirms it, and *Start parking* backs it in (or drives it in nose first) on its own.
`apamock.js` plays both sides of the CAN exchange from `fisker_ocean_adas_world.dbc`: the head unit's
`ICC_0x35B` (`ICC_APAActivation`, `ICC_APAParkSelect`, `ICC_APAParkInDirSetting`) and the ADAS's slots
(`ADAS_APASlot1..6`), state (`ADAS_APASts`), confirmed slot (`ADAS_APASlotSel*`), gear and standstill
requests (`ADAS_0x117`) and chime. The panel shows every signal's value and a log of each change. The
DBC doesn't say in what order these come, so the sequence is our reading of it, not a recorded drive.
While it runs, its simulated drive replaces the live data in the HUD, decoded as `fisker_world.py` would,
so the HUD's own parking drawing (slot outlines, parking-sensor arcs, closest distance per bumper) and
the status card show it.

The menus follow the Ocean user guide where it shows them. Lighting, locking, windows and driver
assistance use the option values the head unit sends on CAN (`carcatalog.js` names each list's DBC signal); the rest are
plausible values for a mockup.

The model's roof, sunroof, seats (cushion and back apart), windows, vents, screens and console are meshes
of their own in `pulse_ocean_v0.10_parts.glb`. `tools/export_ocean_glb.py` splits them out of the Pulse
Ocean package's glb, which merges every part into one mesh per material: it matches each triangle to the
part it came from in the package's master .blend (and, for parts made of several pieces, which piece),
puts the seat backs and the screen on pivots of their own, leaves out the bent caps the package added
to close the seats (they cut through the cushions and backs as dark wedges), and leaves everything else
(rig, materials, textures, animations) as it was:

```
blender -b Pulse-Ocean-Master.blend --python openpilot/sunnypilot/webhud/tools/export_ocean_glb.py -- \
  --glb Pulse-Ocean-ADAS.glb --out openpilot/third_party/webhud/models/pulse_ocean_v0.10_parts.glb
```

## Pieces

| File | Role |
|------|------|
| `server.py` | Process entry point (`webhud` in process_config). stdlib `http.server` + WebSocket, 20 Hz state stream, REST API, static files. Niced; reads nothing while no browser is connected. |
| `mdns.py` | Publishes `sunnypilot.local` as an alias + `_http._tcp` service through avahi's D-Bus API (jeepney); falls back to a built-in A-record responder. Doesn't change the device hostname. |
| `fisker_world.py` | Realtime world model from ADASBUS (see below). |
| `fisker_radar.py` | Mid-range radar tracks from its private CAN (bus 1), decoded with the reverse-engineered `fisker_ocean_mrr.dbc`. Kept apart from ADASBUS: the radar reuses its IDs. |
| `world_model.py` | Ego odometry and the multi-source object tracker behind the *World model* view. |
| `extract.py`, `state.py` | openpilot/sunnypilot services → compact JSON, merged with the Fisker world into one snapshot. |
| `sources.py` | Live (cereal `can` + services) and rlog/qlog replay (zst/bz2, multi-segment, seek, speed). |
| `demo.py` | Synthetic drive that encodes real ADASBUS frames — `server.py --demo` or *Playback → Play demo drive*. |
| `dbc.py` | Small DBC reader/decoder that keeps value tables, comments and cycle times. |
| `../selfdrive/car/can_overrides.py` | Validates/applies `FiskerCanOverrides`; card polls it at 10 Hz and updates the dicts carcontroller reads, in place. |
| `static/` | The app (plain ES modules, no build step). three.js, the Ocean model and the DBC subset live in `openpilot/third_party/webhud/`. |
| `tools/export_ocean_glb.py` | Rebuilds the Ocean model with its roof, sunroof, seats, windows and dash parts split out, for the car controls mockup (run in Blender). |
| `android/` | Head-unit app: finds the comma on the hotspot and shows the HUD full screen through a local relay. Not shipped to the device. |

## ADASBUS signals used

Bus 2 (ADAS module) unless noted; the full set is in the *Signals* tab.

- **Lanes:** `0x339` LeLine1, `0x20A/0x20B` LeLine2/3, `0x20C/0x20D/0x20E` RiLine1/2/3 (offset, heading, curvature radius, type, color, confidence); `0x20F` lane width + lane types; `0x340` what the cluster draws (blue while lane centering, red/flash on departure); `0x350` adjacent lane widths/types, oncoming lanes, landmarks, crosswalk/stop line, construction; `0x210` curbs.
- **Objects:** `0x33B 0x34B 0x32D 0x33D 0x34D 0x32F 0x33F 0x34F` ADAS_Obj1..8 (position, size, heading, class, brake light). Highlights come from `0x31C` ACC primary/secondary target, `0x353` leading vehicle, `0x315` BSD/DOW threat IDs, `0x31A` AEB/rear-AEB/BACM threat IDs, `0x31B` ELKA threat. Positions decode at 0.2 m/bit, not the matrix's 0.5 (checked against openpilot's leads; corrected in `tools/gen_world_dbc.py`), so the list reaches ~50 m. Against the radar the range fits ~0.25 m/bit from about the rear axle instead; the world model's sensor calibration corrects for that, and the raw view shows the list as decoded. Cars are drawn from this list; openpilot's two leads (from the comma camera; the Fisker port has no radar) fill in only where the ADAS has no car, and a re-IDed ADAS track is merged rather than shown twice.
- **ACC / assist:** `0x313` ACC state, TJA autosteer, ISA/TSR/TLR state; `0x31C` set speed, time gap (+ recommendation), icon, function type; `0x314` LKA/ELKA/ESA/LCA/APA/DOW/BSD/DCAA/AHBA states; `0x31B` lane-change trajectory and hands-on request; `0x342` HOD, haptic and turn-lamp requests.
- **Warnings:** `0x317` chimes, takeover request, cluster/mirror warnings, fault text; `0x31A` AEB warning/intervention and telltales; `0x311` degradation pop-ups.
- **Signs & lights:** `0x311` TSR speed limit (+ unit), `0x210` sign condition, no-passing, traffic light color/shape, `0x351` traffic light distance, lead turn signal/brake, `0x334` prohibition signs, camera blockage.
- **Parking:** `0x352` ultrasonic zones (front/rear/left/right × 4), `0x356/0x359` park-distance (cm), `0x2C7..0x2EA` APA slots, `0x2CD` curb warnings, `0x316` surround-view state.
- **Driver monitoring:** `0x527`. **Camera:** `0x32B`.
- **Vehicle (bus 0):** `VCU_0x102` driver torque request per axle, `MCU_F_0x150`/`MCU_R_0x151` motor torque + speed, `VCU_0x214` gear/ready/pedal, `ICC_0x531` cluster speed + unit, `BCM_0x335` lamp outputs, `EPS_0x1C2` steering angle, `BCM_0x343` doors/locks/windows, `PLGM_0x471` liftgate, `ECC_0x373` outside temp, `VCU_0x358` regen/e-pedal, `ICC_0x52A`/`ICC_0x35B` the ICC's own settings (shown next to the overrides).

Not documented in the matrix, so exposed as display toggles (*Display → Geometry calibration*): the
sign of lane curvature and of object heading (lane heading grows to the right, verified on the car).
Verify them on a drive with good lane confidence against the openpilot lanes (*Lane lines → Both*).

## API

`GET /api/status`, `GET /api/routes`, `POST /api/replay {action: load|play|pause|toggle|seek|step|speed|live|demo, ...}`,
`PUT /api/upload?name=<file>` (raw rlog/qlog body), `GET /api/dbc`, `GET|PUT /api/params` (personality,
experimental mode, units), `GET|PUT|DELETE /api/overrides`, `GET|PUT /api/calibration {on}` (the world
model's sensor calibration). WebSocket `/ws`: server sends
`{type: hello|state|raw}`; client sends `{type: raw, addrs}`, `{type: replay, ...}`.

Writes are accepted from private addresses only, never cross-origin, and CAN override changes and
replay are refused while the car is moving (replay also stops itself if the car starts moving).

## Development

```
python -m openpilot.sunnypilot.webhud.server --demo            # synthetic drive
python -m openpilot.sunnypilot.webhud.server --replay <rlog.zst | segment dir | route dir>
python -m openpilot.sunnypilot.webhud.tools.gen_world_dbc FM29_ADASBUS_Matrix_CANFD_V390.8_20230524.dbc
pytest openpilot/sunnypilot/webhud/tests
```

On a PC without the native params library, settings are kept in `~/.comma/webhud_dev_params.json`.
