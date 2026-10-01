# sunnypilot web HUD

A Tesla-style car view for a browser on the same network as the comma device — built for the Fisker
Ocean's own center screen. Shows speed, gear, MADS steering state, ACC set speed and time gap, speed
limit, alerts, the ADAS module's lane lines and object list in 3D, parking sensors, and lets you edit
the CAN overrides in `opendbc/car/fisker/values.py` and replay recorded routes.

The ego car mirrors the real one: a fine textured ground moves under it with speed and steering
(dead-reckoned about the rear axle with the bicycle model from `steeringAngleDeg`), the wheels roll
and the front pair steers, and its lamps light on the body itself, following the BCM's lamp
outputs (`BCM_0x335`, falling back to carState): DRL bar, headlights, front/mirror/rear turn
indicators, tail, brake, third brake light, rear-quarter markers (lit with the tail, bright when
braking, flashing with the indicator) and reversing lamps (`static/js/lamps.js`).

Lanes and objects are filtered before drawing (`static/js/road.js`, `scene.js`): lane lines are
carried with the car's motion and eased toward each measurement by confidence, with hysteresis on
validity; objects are tracked with an alpha-beta filter. The default *Blended* lane source takes
the ADAS lines and refines each with openpilot's matching line where they agree, adding lines only
openpilot sees when it's confident. Lanes neither reports are filled in as a softer, inferred road:
lane count and width from ADAS lines/lane info and openpilot's outer lines and road edges (the road
between the edges is split into lanes and the car put in its slot), held for a while, else the
car's own path. The inferred road only appears once there's lane evidence and fades after ~150 m
without any, or in Park; the ground fades out with distance from the car. Ground texture and
inferred road can be turned off under *Display*.

Traffic lights, signs and road markings (`static/js/furniture.js`) come from the car's ADAS camera
only; sunnypilot adds map speed limits (`liveMapDataSP`) but no signs or lights. The camera reports
what it saw and, for lights and markings, how far ahead, never where across the road: the ego-lane
traffic light (color, arrow, solid/blinking, lamp count, orientation) floats over our lane at its
distance (else the stop line's or a landmark's, else an estimate); a speed-limit sign the camera
just read (`ADAS_TSRSts` Vision mode or a new value) or a prohibition sign (`ADAS_FobdSign`) goes up
at the roadside a little ahead and stays put as the car passes; stop lines and crosswalks are drawn
across the road at their distance. The camera doesn't classify stop or yield signs. The ICC also
sends an ADASIS v2 map horizon (`ICC_0x250`..`0x255`, `0x361`) with map signs and lanes per
direction; its sign type table isn't in the matrix, so it isn't used yet.

*Power trails* (`static/js/tracks.js`, *Display*) lay glowing tire tracks behind the rear wheels,
colored by how hard the motors are asked to pull when each bit is laid: blue at a light load through
the spectrum to red at full power (150 kW demanded, or 6000 Nm of wheel torque for a hard launch;
regen counts as light). Laid track keeps its color, so a burst of power slides back behind the car
as a red stretch. The trail grows with speed to one car length at 70 mph and fades out toward its
end, and light motes kick up off the tires, more of them the harder the car pulls. The load is the
driver's torque request per axle (`VCU_0x102`, wheel torque) times motor speed (`MCU_F_0x150`,
`MCU_R_0x151`) over the ~11.5:1 drive ratio; on other cars it's estimated from openpilot's
acceleration. The chase camera also backs off with speed, up to 1.5x its distance at 70 mph,
keeping any zoom you set. In every view the camera's heading follows the car's on a critically
damped spring (`CAM_YAW_W` in `scene.js`, at most 0.6 rad behind): in a sharp low-speed turn the car
swings round in the frame and the camera catches up as it straightens out; on the highway the lag
is a degree or two.

**Open:** `http://sunnypilot.local:8088` (or `http://<device-ip>:8088`; port 80 is also served when
the process is allowed to bind it). Toggle: *Settings → Developer → Web HUD* (`EnableWebHud`, on by
default).

## Pieces

| File | Role |
|------|------|
| `server.py` | Process entry point (`webhud` in process_config). stdlib `http.server` + WebSocket, 20 Hz state stream, REST API, static files. Niced; reads nothing while no browser is connected. |
| `mdns.py` | Publishes `sunnypilot.local` as an alias + `_http._tcp` service through avahi's D-Bus API (jeepney); falls back to a built-in A-record responder. Doesn't change the device hostname. |
| `fisker_world.py` | Realtime world model from ADASBUS (see below). |
| `extract.py`, `state.py` | openpilot/sunnypilot services → compact JSON, merged with the Fisker world into one snapshot. |
| `sources.py` | Live (cereal `can` + services) and rlog/qlog replay (zst/bz2, multi-segment, seek, speed). |
| `demo.py` | Synthetic drive that encodes real ADASBUS frames — `server.py --demo` or *Playback → Play demo drive*. |
| `dbc.py` | Small DBC reader/decoder that keeps value tables, comments and cycle times. |
| `../selfdrive/car/can_overrides.py` | Validates/applies `FiskerCanOverrides`; card polls it at 10 Hz and updates the dicts carcontroller reads, in place. |
| `static/` | The app (plain ES modules, no build step). three.js, the Ocean model and the DBC subset live in `openpilot/third_party/webhud/`. |

## ADASBUS signals used

Bus 2 (ADAS module) unless noted; the full set is in the *Signals* tab.

- **Lanes:** `0x339` LeLine1, `0x20A/0x20B` LeLine2/3, `0x20C/0x20D/0x20E` RiLine1/2/3 (offset, heading, curvature radius, type, color, confidence); `0x20F` lane width + lane types; `0x340` what the cluster draws (blue while lane centering, red/flash on departure); `0x350` adjacent lane widths/types, oncoming lanes, landmarks, crosswalk/stop line, construction; `0x210` curbs.
- **Objects:** `0x33B 0x34B 0x32D 0x33D 0x34D 0x32F 0x33F 0x34F` ADAS_Obj1..8 (position, size, heading, class, brake light). Highlights come from `0x31C` ACC primary/secondary target, `0x353` leading vehicle, `0x315` BSD/DOW threat IDs, `0x31A` AEB/rear-AEB/BACM threat IDs, `0x31B` ELKA threat. Positions are 0.2 m/bit, not the matrix's 0.5 (checked against openpilot's leads; corrected in `tools/gen_world_dbc.py`), so the list reaches ~50 m. Cars are drawn from this list; openpilot's two leads (from the comma camera; the Fisker port has no radar) fill in only where the ADAS has no car, and a re-IDed ADAS track is merged rather than shown twice.
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
experimental mode, units), `GET|PUT|DELETE /api/overrides`. WebSocket `/ws`: server sends
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
