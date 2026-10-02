# pulse_ocean_v0.10.glb

"Pulse Ocean" v0.10: a detailed Fisker Ocean model rigged for ADAS views (`Pulse-Ocean-ADAS.glb` from
the v0.10 package), used unmodified. Meters, +X forward, +Y up, -Z to the car's left; ground at
y = -0.684. The web HUD turns it to face its -Z and puts the front bumper at z = 0 at load time.

The package's integration files are folded into `sunnypilot/webhud/static/js/models.js`:
`paint-colours.json` (14 factory paints, digital approximations of the paint chips from
AutomotiveTouchup and Carwow, not measured formulas), `wheel-options.json` (F3/F5/F6 designs, alloy or
gloss black; F5 and F6 are modeled from photos) and `light-map.json` / `controls.json` (lamp materials
and lighting rules).
