# Car controls mockup: plan and status

Handoff notes for the `fisker-car-controls-mockup` branch. The approved plan is below; the status
section says what's in the branch so far.

## Status

Done:
- The view bar became a camera dock: camera button with a Chase/Top/Close/Wide menu, and the gear
  (`index.html`, `app.css`, `main.js` `bindViewdock`). Double-tap recenter now counts only taps.
- All car-mode CSS (ribbon, panel, callouts, on-car cards, control widgets) in `app.css`.
- `scene.js` studio camera: `enterStudio`, `exitStudio`, `focus({at, az, el, fit|r})`, `setFrame`,
  `pickEgo`, `pickZone`, `lampOverride`; `viewAnim` animates target and x/y offsets.
- `models.js` exposes `userData.model/mats/meshes`; `tracks.js` exports `SPECK_FRAGMENT` and
  `speckBlending`.
- `cutaway.js` is a placeholder with the hooks `scene.js` calls.

Next:
1. Export the parts glb from `FiskerOcean.blend` (this needs the file, hence the move to a local session).
2. `cutaway.js`: roof fade, zone glow shader, ghosting, built parts (drive units, battery, charge-port door,
   amp), door tweens, airflow, sound rings, sensor fans, `ModePulse`.
3. `carcatalog.js` and `carcontrols.js` (ribbon, panels, callouts, cards, mock state), wired into
   `main.js`: tap-to-enter, autoView suspended, layout to `scene.setFrame`, replay bar hidden in car mode.
4. Verify with screenshots, update README, commit and push.

## Plan

### Context
The user wants a visual mockup of a fuller car-control interface on top of the current HUD, on its own
branch. Nothing in it may act on the car: it's look-and-feel only, with state kept in the page. The default
screen stays the current visualization. The camera-view buttons shrink to a camera icon, and a bottom ribbon
of car categories, hidden by default, slides up when the car model is tapped. The view then zooms to a
top-down view of the car with the roof parts made transparent so the interior shows, and parts of the car
are highlighted for each category. Picking a category either opens a half-screen panel, with the 3D view
moved into the other half, or moves the camera and places the settings directly on the model.

Two changes from review of the first draft:
- **Roof:** split out the geometry that forms the roof (roof panel, SolarSky glass, roof frame, windshield,
  headliner, visors) and fade it to transparent, instead of cutting the car with a clipping plane. "The
  roof" means everything between the two side rails above the doors.
- **Drive mode:** changing the drive mode sends a ring of particles out from the car, styled like the tire
  trails, in the new mode's color.

Content sources:
- **The uploaded manual (X297 user guide, 36 pages).** Its screenshots give the head unit's real settings
  menu: General, Driving, Audio, Connectivity, Display, Lighting, Doors and Mirrors, Profiles and Keys,
  Software, Vehicle and Service. It documents:
  - Audio: three EQ presets, High Treble/Treble/Mid/Bass/Sub Bass sliders from −10 to +10, Sound Stage
    (All/Driver/Passenger/Front/Rear), Fisker HyperSound, and the radio announcement options.
  - Navigation: Buildings in 3D, Downloaded maps, and the Avoid list.
  - Connectivity: Bluetooth, paired devices, Wi-Fi, hotspot.
  - Software: version, release notes, Schedule / Install Now, cellular downloads, Reset Vehicle Settings.
  - Vehicle and Service: vehicle info, Owner's Manual, Roadside Mode, Reset Tire Pressure.
  - Alexa is ignored, as asked.
- **The repo's Fisker CAN definitions** (`fisker_ocean_adas.dbc` and the world DBC) fill in the menus the
  manual doesn't show, using the real option values the head unit sends:
  - Lighting: headlight switch Off/Auto/Position/Low beam; follow-me-home Off/15/30/45/60 s; interior-lamp
    delay; adaptive driving beam; auto high beam.
  - Doors: unlock driver's door or all doors; auto-unlock when powered off; close windows on lock; close
    the sunroof in rain; auto-fold mirrors on lock.
  - Driver assistance (every `ICC_*` setting with its value table): ACC, LKA/ELKA, BSD/DOW, FACM/AEB
    sensitivity, BACM/FCTA, ISA/TSR/TLR, DCAA, ESA, APA/RAP, trained parking, curb protection.
- **Ocean features**, plausible values for a mockup: Earth/Fun/Hyper drive modes, regen, California Mode,
  Hollywood Mode, charge limit and scheduling, and seat heat/ventilation/memory.

### Model: start from the user's `FiskerOcean.blend`, which keeps every part as its own mesh

The current `pulse_ocean_v0.10.glb` merges each material into one mesh per rig group. For example,
`Body__PBR_glass_dark` is the roof glass, windshield and quarter windows together. The `.blend` keeps the
parts separate, so the roof can be picked by name instead of split by geometry.

1. **Get the file into the container.** It's on the user's computer (`~/Downloads`); this cloud session
   can't read that. The user attaches it in the chat. If it's too large to attach, they push it to a
   scratch branch for me to fetch; it won't be committed to the mockup branch.
2. **Inspect it with headless Blender.** Install `bpy` (5.0.1 or 4.5.x, from PyPI, which is reachable;
   Python 3.11 is installed) into a venv in the scratchpad, never the repo. List objects, the hierarchy,
   materials and empties, and check them against the current glb's rig and part names (`glassDark_roof`,
   `carpaintBlack_roof`, `tex_roof`, `blue_seat_f`, …).
3. **Export a new glb with `tools/export_ocean_glb.py`**, a bpy script committed so the model can be
   rebuilt:
   - **Keep the contract `models.js` relies on:**
     - node names `Steer_/Wheel_<corner>`, `Rim_<F3|F5|F6>_<corner>`, `Door_*`, `Tailgate`;
     - material names `Light_*`, `PBR_carpaint`, `Wheel_Face`, `PBR_tire`;
     - the axes and units, so lamps, paint, wheels and the trails keep working unchanged.
   - **Merge by material as before for speed, except named part groups:**
     - `Roof`: everything between the side rails above the doors, i.e. the roof panel, SolarSky glass, roof
       frame, windshield, rear window, headliner, visors and rear-view mirror;
     - `Seat_FL`, `Seat_FR`, `Seat_Rear`;
     - `Dash_Vents`, `Center_Screen`;
     - `ChargePort` and `Amplifier`, if the `.blend` models them.
   - **Write it as `models/pulse_ocean_v0.10_parts.glb`.** Point `scene.js` at it and update
     `models/LICENSE.md` with its provenance. The package's terms need checking: the current notes say the
     glb is "used unmodified".
4. **Fallback** if the `.blend` turns out to be a different model or can't be shared: split the merged glb
   at load, triangle by triangle (the method in the cutaway section below).

Work that doesn't depend on the model goes ahead on the current glb while the file is pending: the camera
dock, ribbon, panels, catalog, on-car cards, zone highlights and drive-mode pulse. The roof fade lands once
the parts glb exists.

### Branch
`fisker-car-controls-mockup`:
- Branched from the latest `origin/fisker-sunnypilot-visualization`, which includes the user's 728ad58.
- Pushed with `git push -u origin fisker-car-controls-mockup`.
- The visualization branch is left untouched.

### UX

**Default screen.** The view bar is replaced by a bottom-right cluster of two round buttons:
- **Camera** (`#btn-camera`) opens a small popover menu with Chase / Top / Close / Wide. The current view is
  marked, and the existing `setView`/`markView` code drives it.
- **Gear** opens the existing HUD settings sheet, as it does now.
- The replay bar keeps using `--viewbar-w`, now measured from the cluster, so it gains room.

**Entering.** A tap on the car (under 8 px of movement, under 300 ms, a ray hit on the car's bounding box):
- The ribbon slides up and the camera cluster hides.
- The camera animates to a top-down view, nose up, fitted to the free screen area.
- While the camera moves, the roof parts (everything between the side rails above the doors) fade to
  transparent. They end as a faint glassy outline, so the cabin is open to view but the car keeps its shape.

**Overview (car mode home).**
- Each category with a part of the car gets a softly pulsing highlight on that part, plus a small icon badge
  pinned over it.
- Tapping a badge, the highlighted part, or a ribbon item opens that category.
- Tapping empty space, the ribbon's ✕, or the camera button exits. The roof comes back, the camera returns to
  the user's view, the ribbon slides down and the camera cluster returns.
- Auto view (the parking top view) is suspended while car mode is open.

**Category views.** Each category has a camera framing, optional on-car cards and an optional panel.
- **Panel:** in portrait, a sheet from the bottom taking half the height, with the 3D view moved into the top
  half. In landscape, a sheet on the right taking about 45% of the width, with the car centered in the area
  between the status card and the sheet.
- **On-car cards:** HTML cards placed beside 3D anchor points, with leader lines. They are re-projected every
  frame, so they track the car when it's orbited.
- A back chevron returns to the overview.
- A small "Mockup: nothing here changes the car" note sits in the ribbon and the panel footer, so the
  driver-assistance switches can't be mistaken for the real CAN settings tab.

| Category | Highlighted part | Camera | Presentation |
|---|---|---|---|
| Lighting | headlights, DRLs | close-up from the front | **on-car**: headlight mode, auto high beam and ADB beside the left lamp; follow-me-home, welcome lights, interior delay and ambient color/brightness beside the right lamp; the model's lamps preview the chosen mode |
| Climate | dash vents and console | top-down on the front cabin | panel: L/R temperature, sync, auto, A/C, fan, airflow, recirculation, front and rear defrost, heated wheel, preconditioning; tinted airflow particles from the vents |
| Seats | front seats | 10 o'clock (front-left, high), rest of the car translucent | **on-car**: per seat heat 0–3, vent 0–3, position pad, lumbar, memory 1/2/3 + save, profile, easy entry; rear-seat heater chips; heat/vent glow on the seats |
| Driving | rear seats, with the powertrain under them shown x-ray | side x-ray | panel: Earth/Fun/Hyper (the motors glow green/blue/orange), regen, creep, steering feel, traction, hill descent, auto hold; **a mode change pulses a particle ring out from the car in the new mode's color** |
| Assist | windshield camera, front radar | high front 3/4 | panel: all `ICC_*` settings with their DBC options; sensor coverage fans drawn on the ground |
| Energy | charge-port door, front left | front-left 3/4 | panel: SoC/range, charge limit, current, schedule, V2L, SolarSky; the door swings open and the x-ray battery fills to SoC |
| Audio | amplifier, rear right of the trunk | rear 3/4, high | panel (manual): EQ presets and 5 sliders, Sound Stage, HyperSound, radio announcements; the Sound Stage choice lights those seats with sound rings |
| Doors | doors and tailgate | rear-left 3/4, roof on | panel: lock/unlock, unlock mode, walk-away lock, auto-unlock, close windows/sunroof, auto-fold mirrors, child and window locks, California Mode; door/tailgate chips **open the real door nodes**, and California Mode lowers the door glass |
| Service | wheels | top-down | panel (manual): vehicle info, Owner's Manual, Roadside Mode, Reset Tire Pressure; pressure chips at each wheel |
| Display | center screen | in the cabin looking at the dash | panel: brightness, auto, appearance, Hollywood Mode, driver display layout |
| Connectivity, Profiles & Keys, Navigation, General, Software | none | stays on the overview | panel only (Connectivity, Navigation and Software follow the manual) |

The ribbon lists the car-part categories first, a divider, then the system ones. It scrolls sideways when
narrow.

### Technical design

### New files under `static/js/`

**`carcontrols.js`, the `CarControls` UI controller.**
- Owns the ribbon, the panel, the overview badges and the on-car cards.
- Builds panel and card DOM from the catalog with `el()`, reusing the existing classes `.rows .row`,
  `.seg`, `.switch`, the range-input styles and `.btn`.
- Keeps mock state in a plain object keyed by control id, in memory only. It never calls `api()` or
  `app.send()`, and the file header says so.
- Projects 3D anchors to the screen the same way `labels.js` does (`Vector3.project` after render). One
  full-screen SVG draws the leader lines.

**`carcatalog.js`, the data.**
- `CATEGORIES`: id, label, icon SVG, zone(s), focus, `cut`, `ghost`, cards and sections.
- Each control is one of toggle, seg, slider, stepper, select, button, list, info or swatches, with its
  default value.
- The DBC option lists are copied in with a comment naming each signal.

**`cutaway.js`, the 3D side, attached to the ego model once it loads.**
- **Roof isolation.** With the parts glb exported from the `.blend`, the `Roof` group is looked up by name.
  Its materials are cloned and made transparent with `depthWrite` off, and car mode tweens their opacity
  from 1 down to about 0.08 (a faint glassy edge) and back. The seat, dash-vent and screen groups are also
  found by name for highlighting and ghosting. Only if that export isn't possible (the fallback in the Model
  section) is the merged glb's roof split out at load, triangle by triangle, in the car frame:
  - **Glass meshes:** `Body__PBR_glass_dark` and the tailgate glass. The roof glass, windshield and rear
    window are split out; the side and quarter glass (normals mostly sideways) stay.
  - **Shell meshes:** `PBR_plasticGlossy` (the black roof frame), `roof` (the SolarSky panel),
    `PBR_carpaint`, `PBR_plasticblack` and `PBR_chrome`. A triangle is split out when its centroid is above
    the side-rail height and inside the rails' inner edge.
  - **Headliner and interior trim:** `Interior_Liner`, `Interior_Black_Alcantara`, `Interior_Black_Trim`,
    `black` and `reflect`. A triangle is split out when it's above about head height and between the rails.
    That catches the headliner, visors and rear-view mirror. The seat mesh, dash and steering wheel are
    never candidates.
  - **Tuning:** the rail line, heights and normal thresholds are measured from the model's vertex data
    (a numpy pass over the glb) and checked in screenshots.
  - **Result:** each split-out part becomes a sibling mesh with its own cloned materials, made transparent
    with `depthWrite` off. Car mode tweens their opacity from 1 down to about 0.08 (a faint glassy edge) and
    back. The rest of the car is unchanged, and the lamps, paint and wheel code keep working because their
    materials aren't touched.
- **One `onBeforeCompile` injection** shared by all ego materials, with a shared cache key:
  - A world-position varying (the ego sits at the scene origin, so world = car frame).
  - A box-zone glow added to `totalEmissiveRadiance`: up to 10 boxes, each with color and level uniforms,
    and a per-material mask so a zone lights only its own materials. For example, the front-seat box tints
    only the seats; the seat mesh gets its own cloned materials so it can be masked separately.
  - A ghost factor: fresnel-rim translucency for the "rest of the car translucent" views, such as Seats.
- **Drive-mode pulse** (`ModePulse`):
  - A `THREE.Points` ring that starts on the car's footprint, a rounded rectangle about 2 × 4.8 m, and
    expands about 7 m over about 1.2 s. Its specks thin, twinkle and fade as it goes, and a few rise
    slightly.
  - Its color is the new mode's: Earth green, Fun blue, Hyper orange-red. The motors' x-ray glow
    cross-fades to the same color.
  - Particles are spawned once per pulse into a small pool of about 6000, and age is computed on the GPU
    from a time uniform.
  - The speck/halo fragment shader and the theme blending (additive at night, ink-like by day) are reused
    from the tire trails. `tracks.js` exports them as `SPECK_FRAGMENT` and `speckBlending(dark)`; its
    behavior is unchanged.
- **Built parts the model lacks:**
  - front and rear drive units, and the battery pack as an x-ray additive material with no depth test;
  - the charge-port door, placed by a raycast against `PBR_carpaint` on the front-left fender, with a
    hinge animation;
  - the trunk amplifier;
  - airflow particles, sound rings, sensor coverage fans, and the window-down animation for door glass.
- **Doors:** `Door_*` and `Tailgate` nodes are already hinged (node translation = hinge), so opening is a
  rotation tween.
- **Picking:** invisible proxy boxes per zone, plus the car's bounding box for entering.

### Changes to existing files

**`scene.js`**
- `this.cutaway = new Cutaway(...)` is attached when the glTF loads and updated in `frame()`.
- Studio camera API: `enterStudio()`, `exitStudio()`, `focus({target, r, phi, theta, fit}, instant)` and
  `setFrame(rect)`.
- `viewAnim` gains a target and an x offset, so a camera move can go to any point on the car, not only the
  car's center.
- While in the studio:
  - the recenter spring uses the focus target;
  - camera lag and the chase dolly are suspended;
  - `controls.minDistance` drops to 1.2;
  - `setViewOffset` centers the focus target in the free rectangle.
- Fit: compute the distance so a given width × length of the car fills about 80% of the free rectangle,
  using the current fov (60 in portrait, 42 in landscape).
- `pickEgo(x, y)` and `pickZone(x, y)` helpers.
- `_ego()` takes an optional lamp override (the Lighting preview) in place of `vs.lamps`.

**`models.js`**
- `loadEgoModel` also exposes `userData.model`, `userData.meshes` (by name) and `userData.mats`, so the
  cutaway can find the seat mesh, door nodes, glass and materials.

**`tracks.js`**
- Export the existing particle fragment shader and theme blending, for the drive-mode pulse to share.
  No change to how the trails look or behave.

**`main.js`**
- Bind the camera menu in place of `bindViewbar`.
- Tap-to-enter on `#scene`, keeping double-tap recenter outside car mode.
- `autoView()` returns early while car mode is open.
- `updateLayout()` measures the cluster for `--viewbar-w` and passes the free rectangle (status card,
  panel, ribbon) to `scene.setFrame` while car mode is open.
- Hide the replay bar while car mode is open.

**`index.html`**
- The viewbar becomes `#viewdock` (camera and gear buttons plus a `#viewmenu` popover).
- Add `#carribbon`, `#carpanel` and `#caranchors` (cards, badges and the leader-line SVG).

**`app.css`**
- Styles for the dock, popover, ribbon (slide-up), panel (bottom sheet in portrait, side sheet in
  landscape), cards with leader lines, pulsing badges, seat pad and heat/vent level buttons.
- Everything uses the existing theme tokens, so day and night both work.

**`util.js`**
- Add the camera and category icons to `ICONS`.

**`README.md`**
- A short section on the car controls mockup: how to open it, what it shows, and that it's local-only.

**New `tools/export_ocean_glb.py`, plus a new model file**
- The bpy export script (see the Model section) and `third_party/webhud/models/pulse_ocean_v0.10_parts.glb`.
- `test_server.py`'s model path is updated to the new glb.

Untouched: the server, the Android app and the CAN override settings.

### Verification
- Run `python -m openpilot.sunnypilot.webhud.server --demo --no-mdns --no-port80` in its own Bash call,
  separate from any call that stops it.
- Use headless Playwright (chromium `/opt/pw-browsers/chromium-1194/chrome-linux/chrome`,
  `--use-gl=swiftshader`) at 1920×1080, 1080×1920, 844×390 and 390×844, in both themes. For each size:
  1. On the default screen, check that only the camera and gear cluster shows, and that the camera menu
     switches views.
  2. Tap the car: the ribbon slides up, the view goes top-down and the roof fades out. Screenshot this to
     tune the split (roof, windshield, headliner and visors gone; rails, pillars and side glass kept), the
     zone boxes and the framing against the real model. Check that exiting restores the roof fully opaque.
     Also check the paint and wheel options and the lamps still work on the split model.
  3. Open every category. Screenshot the panel layouts, both on-car layouts (Lighting, Seats) and the
     door/charge-port animations. Switch Earth → Fun → Hyper and capture frames of each pulse ring, in both
     themes, to confirm it expands and fades in the mode's color. Confirm the tire trails look the same as
     before.
  4. Check that the background tap and ✕ exit, and the car is restored.
  5. Check there are no console errors.
  6. Drive the demo while in car mode: no auto view jump, and the camera stays on its framing.
  7. Exit car mode and check chase and top views behave as before.
- For the new glb, check that:
  - the front wheels steer and all four roll;
  - all 14 paints and 5 wheel options apply;
  - every lamp lights;
  - the doors and tailgate pivot at their hinges;
  - the file is about the size of the current 24.5 MB (it's served gzipped and cached by `sw.js`).
- Grep the new modules for `api(`, `fetch`, `send(` and `WebSocket` to confirm they contain no network
  calls.
- `pytest openpilot/sunnypilot/webhud/tests` (the static-file tests still find `CarScene` and the title),
  and `codespell` on the changed files.
- Send the user a few screenshots (overview, Lighting, Seats, a panel in portrait). Then commit in logical
  steps (camera dock, cutaway and zones, catalog and panels, on-car views, docs) and push the new branch.
