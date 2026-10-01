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
validity; objects are tracked with an alpha-beta filter. Lanes the cameras don't report are filled
in as a softer, inferred road following the last known lanes (width, count, oncoming lane) or the
car's own path. Ground texture and inferred road can be turned off under *Display*.

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
- **Objects:** `0x33B 0x34B 0x32D 0x33D 0x34D 0x32F 0x33F 0x34F` ADAS_Obj1..8 (position, size, heading, class, brake light). Highlights come from `0x31C` ACC primary/secondary target, `0x353` leading vehicle, `0x315` BSD/DOW threat IDs, `0x31A` AEB/rear-AEB/BACM threat IDs, `0x31B` ELKA threat.
- **ACC / assist:** `0x313` ACC state, TJA autosteer, ISA/TSR/TLR state; `0x31C` set speed, time gap (+ recommendation), icon, function type; `0x314` LKA/ELKA/ESA/LCA/APA/DOW/BSD/DCAA/AHBA states; `0x31B` lane-change trajectory and hands-on request; `0x342` HOD, haptic and turn-lamp requests.
- **Warnings:** `0x317` chimes, takeover request, cluster/mirror warnings, fault text; `0x31A` AEB warning/intervention and telltales; `0x311` degradation pop-ups.
- **Signs & lights:** `0x311` TSR speed limit (+ unit), `0x210` sign condition, no-passing, traffic light color/shape, `0x351` traffic light distance, lead turn signal/brake, `0x334` prohibition signs, camera blockage.
- **Parking:** `0x352` ultrasonic zones (front/rear/left/right × 4), `0x356/0x359` park-distance (cm), `0x2C7..0x2EA` APA slots, `0x2CD` curb warnings, `0x316` surround-view state.
- **Driver monitoring:** `0x527`. **Camera:** `0x32B`.
- **Vehicle (bus 0):** `VCU_0x214` gear/ready/pedal, `ICC_0x531` cluster speed + unit, `BCM_0x335` lamp outputs, `EPS_0x1C2` steering angle, `BCM_0x343` doors/locks/windows, `PLGM_0x471` liftgate, `ECC_0x373` outside temp, `VCU_0x358` regen/e-pedal, `ICC_0x52A`/`ICC_0x35B` the ICC's own settings (shown next to the overrides).

Not documented in the matrix, so exposed as display toggles (*Display → Geometry calibration*): the
sign of lane heading/curvature and of object heading. Verify them on a drive with good lane
confidence against the openpilot lanes (*Lane lines → Both*).

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
