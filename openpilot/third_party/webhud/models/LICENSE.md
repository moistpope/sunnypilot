# pulse_ocean_v0.10_parts.glb

"Pulse Ocean" v0.10: a detailed Fisker Ocean model rigged for ADAS views (`Pulse-Ocean-ADAS.glb` from
the v0.10 package). Meters, +X forward, +Y up, -Z to the car's left; ground at y = -0.684. The web HUD
turns it to face its -Z and puts the front bumper at z = 0 at load time.

Changed from the package's glb only in how its meshes are grouped: the car controls mockup needs the
roof, sunroof, seats, windows, dash vents, screens and console as meshes of their own, and the glb merges
every part into one mesh per material and rig node. `sunnypilot/webhud/tools/export_ocean_glb.py` matches
each triangle to its part in the package's `Pulse-Ocean-Master.blend` and moves those triangles into
nodes named for them (`Roof`, `Sunroof`, `Seat_FL` with `Seat_FL_Back` hanging from it, `Window_Front_L`,
...; each lists its source parts in its extras). The seat backs and the center screen sit on pivots of
their own (their vertices moved to be relative to them). Otherwise the geometry, materials, textures, rig
and animations are the package's own, and the file rebuilds the same byte for byte. The package states
no license; check it before redistributing.

The package's integration files are folded into `sunnypilot/webhud/static/js/models.js`:
`paint-colours.json` (14 factory paints, digital approximations of the paint chips from
AutomotiveTouchup and Carwow, not measured formulas), `wheel-options.json` (F3/F5/F6 designs, alloy or
gloss black; F5 and F6 are modeled from photos) and `light-map.json` / `controls.json` (lamp materials
and lighting rules).
