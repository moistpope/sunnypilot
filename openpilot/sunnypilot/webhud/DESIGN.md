# Ocean controls: design language

The rules for the car-controls interface on the Fisker Ocean's portrait center screen, 1080 × 1920.
Tesla's in-car interface (its Controls, Climate and Energy screens) is the reference. The language
extends the interactive 3D car view of the car-controls mockup (`CAR_CONTROLS_PLAN.md`): the car stays,
and the panels of rows, switches and segmented buttons under it become the sheet and cells described here.

The living version is `static/design.html` (open `/design.html` on the HUD's server), with every token
and component rendered at frame size, four category screens, and a day/night toggle. `static/design.css`
holds the tokens and component classes; nothing in `app.css` or `carcontrols.js` uses them yet.

## What Tesla's screens do, and what this copies

Looked at closely, Tesla's interface is made of very little:

- **A flat ground.** Near-black at night, a warm light grey by day. No gradients, no glass, no shadows
  on panels.
- **Cells, not fills.** A button, a tile, a setting group is a rectangle with a hairline border on the
  ground, white (or a shade lighter than the ground) inside. Groups are not boxed; a heading in regular
  type separates them.
- **Small radii.** About 8 px on everything; the panel's corners a little more.
- **Regular type.** The hierarchy is in size and grey, not in weight. Labels sit a little open.
- **Thin line icons,** white or grey, one color.
- **Almost no color.** A chosen thing turns its glyph blue. A segmented control lifts a pale pill. A
  screen has at most one blue-filled button (FRONT FOG, the brightness Auto). Everything else is grey.
- **One number per screen** that matters, set large and light: the energy figure, the set temperature.

## Principles

1. **The car is the interface.** The 3D Ocean stays on screen in every view. The sheet holds only what
   the car can't show by itself. Doors swing, windows sink, seats glow and the port opens on the model;
   the sheet never repeats that in a read-out block, so the "From the car" section goes: a control's
   value simply *is* the car's when the car reports it.
2. **Choose, don't toggle.** A choice between named states is a segmented control (Off · Parking · On ·
   Auto). A switch is for a preference you set once.
3. **Cells for what you do while driving.** A tile is a 120 px cell you can hit without looking: A/C,
   defrost, heated wheel, fold mirrors. Rows are for settings you reach when parked.
4. **The number first.** A category opens on the one number that matters, light and 72 px: the set
   temperatures, the charge level, the lock. Then the controls, then the preferences.
5. **Group by what it does to the car,** not by which module sends the message. Climate holds the seat
   heaters, as Tesla's does. Doors & Windows holds the lock, the windows, the liftgate and the mirrors.
6. **One language for live, sent and off.** An unavailable control is greyed, not hidden, and says why on
   tap. The dock says whether changes reach the car.
7. **Scale by frame, not by pixel.** Everything is in rem against a 1080-wide frame, so one layout serves
   the Pulse display, the AVD (1080 × 1920 at 120 dpi, so not 1080 CSS px) and a browser. No backdrop
   blur over the 3D view: the car's GPU would pay for it every frame.

## Scale

`html.fo { font-size: calc(100vw / 67.5) }` in portrait, so 1 rem = 16 frame px and 4.5 rem is 72 frame
px whatever `devicePixelRatio` the WebView reports. Sizes below are frame px; `design.css` carries the rem.

## Layout, 1080 × 1920

| Zone | Height | Holds |
|---|---|---|
| Status strip | 96 | Gear, speed and telltales on the left; time, outside temperature and the link state on the right. Replaces the floating status card while the controls are open. |
| Stage | what's left | The 3D car. Badges in the overview; chips on parts in a category. The camera refits on every detent change (`freeRect`). |
| Sheet | 448 · 848 · 1360 | Ground color, a 12 px radius and a hairline at the top, no shadow. Handle, head, body. |
| Dock | 112 | A flat bar at the very bottom, like Tesla's taskbar: ground color, a hairline on top. The ten car-part categories as icon over a 14 px label (80 × 96 each), a divider, *More* for the five system categories, the state tag at the left edge, ✕ at the right. The sheet sits on it; nothing overlaps. |

**Sheet detents.** *Peek* (448) shows the handle, the title and the hero. *Half* (848) is the default for
a category. *Full* (1360) is for long lists (Assist, Locking) and leaves 352 px of car. Drag the handle,
or tap it to step through. The height animates (not a transform) so the stage refits with it.

**Space.** 40 at the screen edges, 8 between cells, 12 inside a group, 32 between groups. The 8 px grid.

## Color

| Token | Day | Night | Use |
|---|---|---|---|
| `--fo-ground` | #f4f4f4 | #171717 | The sheet and the dock |
| `--fo-cell` | #ffffff | #1f1f1f | A cell: tile, button, slider thumb, a chosen segment |
| `--fo-cell-2` | #e8e8e8 | #303030 | Pressed; a segmented control's track |
| `--fo-line` | black 10 % | white 12 % | Hairlines: cell borders, row dividers |
| `--fo-line-2` | black 20 % | white 30 % | A chosen cell's border |
| `--fo-ink` | #393c41 | #f0f0f0 | Text and icons (Tesla's grey, not black) |
| `--fo-ink-2` | #8a8d91 | #9a9a9a | Secondary text, resting glyphs |
| `--fo-ink-3` | #c2c4c7 | #5a5a5a | Disabled |
| `--fo-accent` | #3e6ae1 | #4d7ff0 | A chosen glyph, a slider's fill, an open window's figure, the one primary button |
| `--fo-heat` / `--fo-cool` | #e0452c / #2f8fe6 | same | Seat and wheel heat; A/C and defog |
| `--fo-ok` | #2e9e4f | same | Charging, locked, live |
| `--fo-warn` / `--fo-bad` | #e8a317 / #d93a2f | same | Link down; destructive |
| `--fo-earth` / `--fo-fun` / `--fo-hyper` | #2e9e4f / #3e6ae1 / #e8582c | same | Drive-mode dots and the pulse on the car |
| `--fo-on-stage` | black 72 % | black 82 % | A chip's or toast's ground over the 3D view |

## Type

The system face (Roboto on the car). Weights 300, 400 and 500 only; labels carry .02 em of tracking.
Tabular numerals wherever a value changes.

| Style | Size / weight | Use |
|---|---|---|
| display | 72 / 300 | The set temperature, the charge level |
| hero | 48 / 300 | A stepper's value |
| title | 32 / 500 | The sheet's title |
| heading | 24 / 400 | Group headings (with a small grey icon, like Tesla's "Exterior Lights"), a hero's line |
| body | 24 / 400 | Row labels |
| label | 22 / 400, 500 when chosen | Tiles, segments, buttons, chips |
| caption | 18 / 400 | Second lines, notes |

## Measure

| | Frame px |
|---|---|
| Minimum hit | 72 (icon buttons, segments, slider rail) |
| Row | 80 |
| Tile, heat glyph | 120 |
| Switch | 64 × 36 on a 72 hit |
| Dock item | 80 × 96 |
| Slider thumb | 88 × 52 pill, carrying the value |
| Radius | 8 on every cell; 12 on the sheet's top |
| Icons | 24-grid line icons at a 1.6 stroke (the HUD's `ICONS`, drawn thinner). 32 in tiles and the dock, 28 in a segment, 24 in a row. Grey at rest, blue when chosen; never two-tone. |

## Components

Each is a class in `design.css`; `design.html` shows them with their states wired.

| Component | Class | Use |
|---|---|---|
| Segmented control | `.fo-seg` | One choice from two to five. A grey track; the chosen segment is a lifted white pill (a lighter grey at night). `.stack` puts an icon over a short label (airflow). A segment may carry a color dot (drive modes). |
| Tiles | `.fo-tiles .fo-tile` | Equal cells, four to a row (`.cols-3`, `.cols-2`, `.wide`), icon over label. On: the glyph goes blue (red for heat, blue for cool), the label firms to 500, the border darkens a touch; the cell stays white. `.primary` is the one blue-filled button a screen may have. `.off` is greyed. |
| Rows and switch | `.fo-rows .fo-row`, `.fo-switch` | Preferences. Hairline dividers, nothing filled. Label, optional second line, control at the end: a slim switch, a value with a chevron, or a segmented control (`.stack` under the label when it has more than three options). |
| Slider | `.fo-slider`, `.fo-steps` | Tesla's brightness slider: a hairline track and a pill thumb that carries the value, glyphs at the ends. Discrete values (fan 1–7) are `.fo-steps`, a segmented track. |
| Temperature | `.fo-temps .fo-temp` | Driver and passenger set points as 72 light numerals, minus and plus as bare glyphs beside them. Power and Sync as small cells between. A synced passenger side greys its number. |
| Heat glyph | `.fo-heat` | A seat with three waves above the cushion (Tesla's heated-seat symbol); each level fills one wave red. Tap cycles Off → 1 → 2 → 3 → Off. The same glyph is the rear seats' chip and the wheel's. |
| Hero | `.fo-hero` | The one number in display weight, its unit small, a line in the state's color, a caption, a thin bar with a marker. No box; it sits on the ground. `.inline` for the lock: icon, state, one button. |
| Hold buttons | `.fo-hold` | Cells that fill blue while held; the car's reported position at the end. |
| Windows | `.fo-wins .fo-win` | The eight openings as cells in two rows of four, front row first, left to right as in the car. An open one shows its percentage in blue with a thin line along the cell's bottom for how far. Tap: all the way the other way; hold: jog. Replaces seven Up/Down rows. |
| Equalizer | `.fo-eq .fo-band` | Hairline rails, zero marked, a small round thumb, the value above. |
| Seat adjuster | `.fo-seatpos .fo-jogs` | The seat from the side as a line drawing in its position; the four jog pairs beside it. `.compact` for a card. |
| Chips | `.fo-chip` | Tesla labels the car with grey text on a thin leader line; over the moving 3D view the text needs a ground, so a chip is a dark translucent cell with a hairline leader. `.badge` is the icon alone; `.pair` has the door and its window, divided by a hairline; a chosen glyph is blue. `.text` is a bare label where the ground is calm. |
| Buttons | `.fo-btn` | A cell. `.primary` is the one blue fill. |
| Dock | `.fo-dock .fo-dock__item` | See Layout. The open category's glyph is blue and its label dark. |
| Toast | `.fo-toast` | The chip's dark cell, bottom center above the dock, 2.5 s. |

## States

| State | Means | Looks |
|---|---|---|
| Rest | Not chosen, not on | White cell, hairline border, grey glyph and label |
| On / chosen | The state the car is in | Blue glyph (red heat, blue cool), label at 500, border a touch darker; a chosen segment lifts a white pill |
| Primary | The one thing a screen is for | Blue fill, white text. At most one per screen |
| Pressed / held | Finger down; a hold button keeps sending | The cell goes light grey; a hold button fills blue while held |
| Live | The value is the car's (`carstate.js`) | No mark on the control. The dock tag reads *On the car*, green |
| Pending | Sent, waiting for the car's answer | The control keeps its old value; its glyph fades to 50 % for up to 1.5 s, then settles on what the car reports |
| Off | No message for it, or the head unit owns it | Light grey text and glyph, a small lock at the end of a row; a tap shows the reason as a toast and nothing changes |
| Mock | No car: values live in the page | Nothing is greyed for being mock; the dock tag reads *Mockup* |

## Motion

| What | Duration | Easing |
|---|---|---|
| Sheet open, close, detent; dock in and out | 380 ms | `cubic-bezier(.2,.8,.2,1)`; the camera eases over the same time |
| State change (on, chosen) | 180 ms | ease; color and border only, the segment's pill is a background and shadow fade, not a slide |
| Press | 80 ms | the cell goes light grey; no scaling |
| Switch knob | 180 ms | the same bezier |
| Pending | 1.5 s max | fade to 50 %, stops when the car answers |
| Chips | 200 ms fade | then they follow their part every frame with no transition |
| Reduced motion | 0 | `prefers-reduced-motion` turns every transition off |

## The categories, regrouped

What each category's sheet holds, top to bottom. The signals and `live` / `tx` / `off` behavior stay as
`carcatalog.js` defines them; only the presentation changes.

**Climate.** The two set temperatures with On and Sync between. Cells: Auto, A/C (cool), Recirculate,
Air purifier; Front defrost (cool), Rear defrost (cool), Heated wheel (heat), Pet mode (off). *Fan*:
steps 1–7. *Airflow*: two stacked icon segments, front and rear. *Seat heat*: four heat glyphs (shared
with Seats). *Departure*: rows, off (telematics).

**Doors & Windows.** The lock as an inline hero (icon, Locked, Unlock as the primary). *Windows*: the
eight window cells, then California Mode (primary), Close all, and the sunroof as a segment (Closed · Tilt ·
Open). The door chips on the car do the same per door. *Liftgate*: hold buttons. Cells: Fold mirrors,
Child locks (off), Rear window lock (off). *Locking*: rows (Unlock segment, walk-away, unlock when off,
close windows when locking, fold mirrors when locking, close the sunroof in rain).

**Seats.** In landscape, a card beside each front seat: heat glyph with Memory 1 2 3 and Save, the
compact seat adjuster, Easy entry. In portrait the cards don't fit beside the car (two 432 px cards in
1080), so the same groups go in the sheet, *Driver* then *Passenger*, and only the heat chips stay on the
seats, rear ones included.

**Lighting.** *Exterior lights*: the segment (Off · Auto · Parking · Low; Auto is the stalk's own position),
then cells: Auto high beam (off), Adaptive beam, Welcome lights, Ambient (off). Ambient brightness slider
(off). *After you lock*: Follow me home and Interior lights off after as stacked segments in rows.

**Energy.** Hero: charge, range, status, the limit marked on the bar. *Charging*: the charge-limit slider
(green fill), current as a stepper, Stop / Start charging as the one primary. *Schedule*: rows, off.
*Power out*: V2L as a wide cell (off), the stop-at slider.

**Driving.** Drive mode as a segment with color dots. Regen, accelerator and steering as segments in
rows, as Tesla's Pedals & Steering is. Cells: Creep, Auto hold, Traction control, Hill descent, Special
terrain mode (wide).

**Assist.** Rows as today, at the new sizes, opened at *Full*; groups collapsible. These are greyed on
the car (they go through the comma's CAN settings), so density matters less than completeness.

**Audio.** Preset segment, the equalizer, Sound stage as a stacked segment, cells for HyperSound and the
three announcement kinds.

**Display.** Brightness slider with moon and sun at its ends; cells Auto brightness, Hollywood Mode, Clean
screen; Appearance and Driver display as segments in rows.

**Service.** Tire chips on the wheels as today; the sheet keeps its info rows and buttons.

**Connectivity, Profiles & Keys, Navigation, General, Software.** Under *More*, a list sheet; inside,
rows as today.

## Where it stands

Adopted in `carcontrols.js`, `carcatalog.js`, `app.css` and `cutaway.js` (2026-10-05). The sheet, the dock,
the on-car drag controls, the climate bar, the liquid battery and the power bar are in the HUD; `design.html`
remains the component reference. Decisions taken with the user on that day:

- **Climate** mirrors Tesla's climate screen: three rows of borderless buttons on a 12-column grid, so every
  button keeps its place (`carcontrols.js` `climate()`). Row 1: power, Auto, A/C; the three vents (windshield,
  face, feet) as toggles with Front / Rear under them; Schedule. Row 2: heated wheel, front and rear
  defrost; the fan between its arrows (LO · 2–6 · HI); recirculation, purifier. The seat heaters stay under
  Seats, and the Ocean has no keep-climate or pet mode. Row 3: the set temperatures between their arrows, Sync
  between, as Tesla's taskbar shows them. No title: the dock says where you are. The camera sits between the
  front seats looking at the dash, and the air from the vents shows as particles colored by each side's
  temperature.
- **Doors & Windows** keeps its controls on the car. Each window the head unit can move, the sunroof and
  the liftgate get a drag control pinned to the glass: a knob between two arrows, dragged down to open a
  window (up to open the liftgate), an arrow tapped to go all the way. No percentages: the glass itself
  shows how far open. The sheet holds the lock, California Mode, Close all, the mirrors and the locking
  preferences.
- **Energy** shows the charge as the pack filling with liquid from the rear forward; while charging the
  fill's front face runs in waves. No charge number, no port chip: the port door is manual and the model
  shows it. One status line, then the charge settings.
- **Driving** is segments (drive mode with color dots, regen, accelerator, steering) and cells for the assists.
- **No "From the car" blocks.** A live control shows the car's value; the dock tag says whether changes go
  to the car.
- **Power bar** on the status card: Tesla's bar without graduations, origin in the middle, regeneration
  left in green, consumption right in the text color; a tap opens the last minute as a trace (`hud.js` Econ).

Open: the on-car cards in landscape still use the old card layout in the new colors; the status strip in
car mode is not built (the HUD's status card stays); the airflow particle colors deserve a pass with the
car's real temperatures.
