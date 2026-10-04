// Car controls mockup, the content: the categories in the ribbon, how each frames the car and what it
// lights up, and its controls. The menus follow the Ocean head unit's settings (the X297 user guide)
// where the guide shows them; Lighting, Doors and Driver assistance use the option values the head
// unit sends on CAN (the signal is named beside each list, from fisker_ocean_adas.dbc and the world
// DBC); the rest are plausible values for a mockup. Nothing here is sent anywhere (carcontrols.js).
//
// A category: id, label, icon (util.js), zone (cutaway.js ZONES: what glows and where a tap picks it),
// focus (the camera: at [x, y, z] car frame, az deg from ahead clockwise seen from above, el deg above
// the horizon, fit [across, up] m to fill the free screen area (fitP: in portrait), or r m), roof (fade the roof), ghost
// (parts kept solid while the rest turns see-through), and either cards (on-car) or sections (panel).
//
// A control: { id, type, label, sub, def, ... } with type
//   toggle, seg (options), slider (min max step unit), stepper (min max step unit), select (options),
//   levels (max, kind: heat | vent | plain), swatches (options [value, label, css color]), modes,
//   checks (options, def = [values]), pad (seat position), button (style, toast), list (items), info
//   (items [key, value]), hero (energy summary), note (text).

const T = (id, label, def, sub) => ({ id, type: 'toggle', label, def, sub });
const S = (id, label, options, def, sub) => ({ id, type: 'seg', label, options, def, sub });
const R = (id, label, min, max, step, def, unit, sub) => ({ id, type: 'slider', label, min, max, step, def, unit, sub });
const SEL = (id, label, options, def, sub) => ({ id, type: 'select', label, options, def, sub });
const B = (label, toast, style, sub) => ({ type: 'button', label, toast, style, sub });

// ---- option lists from the DBCs (raw value -> label) --------------------------------------------------
const OFF_WARN_BRAKE = [[0, 'Off'], [1, 'Warn'], [2, 'Warn + brake']];             // ICC_FACM_Setting, ICC_BACM_Setting, ICC_FCTA_Setting
const SENSITIVITY = [[2, 'Late'], [0, 'Normal'], [1, 'Early']];                     // ICC_AEB_Sensitivity, ICC_BACM_Sensitivity, ICC_FCTA_Sensitivity, ICC_BSD_Sensitivity
const ALERT_LEVELS = [[0, 'Off'], [1, 'Visual'], [2, '+ Sound'], [3, '+ Vibration']];   // ICC_BSDSetting, ICC_WarnTypeSetting

export const DRIVE_MODES = [   // Ocean drive modes, with the color the car shows for each
  ['earth', 'Earth', 'Range first, gentle response', '#2fa84f'],
  ['fun', 'Fun', 'Balanced, livelier pedal', '#3e8bff'],
  ['hyper', 'Hyper', 'Full power, sport steering', '#ff5a2a'],
];

export const CATEGORIES = [
  {
    id: 'lighting', label: 'Lighting', icon: 'beam', zone: 'lamps', roof: false,
    focus: { at: [0, 0.78, 0.2], az: 0, el: 9, fit: [4.8, 1.7] },
    cards: [
      {
        title: 'Headlights', anchor: 'lampL',
        controls: [
          S('light.mode', 'Headlights', [[0, 'Off'], [1, 'Auto'], [2, 'Parking'], [3, 'Low']], 1),   // BCM_ExtLampSwtSts
          T('light.ahb', 'Auto high beam', true),               // ICC_AHBA_Setting
          T('light.adb', 'Adaptive driving beam', false),       // BCM_EnaReq_ADB
        ],
      },
      {
        title: 'Welcome & interior', anchor: 'lampR',
        controls: [
          S('light.home', 'Follow me home', [[0, 'Off'], [1, '15 s'], [2, '30'], [3, '45'], [4, '60']], 2),   // BCM_FolwMeSetStsFb
          T('light.welcome', 'Welcome lights', true),
          S('light.interior', 'Interior lights off after', [[1, '0 s'], [2, '15'], [3, '30'], [4, '45'], [5, '60']], 3),   // BCM_IntLampTiSetSts
          { id: 'light.ambient', type: 'swatches', label: 'Ambient', def: 'blue',
            options: [['white', 'White', '#e9eef5'], ['blue', 'Ocean blue', '#3e8bff'], ['teal', 'Teal', '#18b6a4'], ['amber', 'Amber', '#f0a020'], ['magenta', 'Magenta', '#d63f9a']] },
          R('light.ambientLevel', 'Ambient brightness', 0, 100, 5, 60, '%'),
        ],
      },
    ],
  },
  {
    id: 'climate', label: 'Climate', icon: 'fan', zone: 'vents', roof: true,
    focus: { at: [0, 0.95, 2.05], az: 180, el: 62, fit: [2.1, 2.3] },
    sections: [
      { controls: [{ id: 'climate.temps', type: 'temps' }] },
      {
        title: 'Air',
        controls: [
          T('climate.on', 'Climate on', true),
          T('climate.auto', 'Auto', true, 'Fan and airflow follow the set temperature'),
          T('climate.ac', 'A/C', true),
          R('climate.fan', 'Fan', 1, 7, 1, 3, ''),                        // ECC_WindSpdSts gears 1..7
          S('climate.flow', 'Airflow', [['face', 'Face'], ['both', 'Face + feet'], ['feet', 'Feet'], ['windshield', 'Windshield']], 'face'),   // ECC_DrvrAirOutlMod
          S('climate.recirc', 'Air intake', [[1, 'Fresh'], [0, 'Recirculate']], 1),   // ECC_CircSts
          T('climate.purify', 'Air purifier', false),                     // ECC_AirClnSts
          S('climate.rear', 'Rear vents', [[0, 'Face'], [1, 'Face + feet'], [2, 'Feet'], [3, 'Off']], 0),   // ECC_BackRowAirOutlModSts
        ],
      },
      {
        title: 'Defrost & heating',
        controls: [
          T('climate.defrostF', 'Max front defrost', false),             // ECC_MaxFrntDefrst
          T('climate.defrostR', 'Rear defrost', false),                  // BCM_ReDefrstHeatgCmd
          T('climate.wheel', 'Heated steering wheel', false),
        ],
      },
      {
        title: 'Preconditioning',
        controls: [
          T('climate.precond', 'Precondition before departure', false),
          SEL('climate.depart', 'Departure', [['06:30', '6:30 AM'], ['07:00', '7:00 AM'], ['07:30', '7:30 AM'], ['08:00', '8:00 AM'], ['17:30', '5:30 PM']], '07:30'),
          T('climate.dog', 'Keep cabin climate when parked', false, 'For a pet left in the car; the screen says so'),
        ],
      },
    ],
  },
  {
    id: 'seats', label: 'Seats', icon: 'seat', zone: 'seats', roof: true, ghost: ['Seat_FL', 'Seat_FR', 'Seat_Rear', 'Console'],
    focus: { at: [0, 0.82, 2.6], az: -38, el: 38, fit: [3.2, 2.4], fitP: [3.6, 2.8] },
    cards: [
      { title: 'Driver', anchor: 'seatFL', seat: 'FL', controls: seatControls('FL', true) },
      { title: 'Passenger', anchor: 'seatFR', seat: 'FR', controls: seatControls('FR', false) },
    ],
    chips: [
      { anchor: 'seatRL', id: 'seat.RL.heat', kind: 'heat', label: 'Rear left' },
      { anchor: 'seatRR', id: 'seat.RR.heat', kind: 'heat', label: 'Rear right' },
    ],
  },
  {
    id: 'driving', label: 'Driving', icon: 'gauge', zone: 'drive', roof: false, ghost: ['Seat_FL', 'Seat_FR', 'Seat_Rear'],
    focus: { at: [0, 0.62, 2.4], az: -90, el: 10, fit: [5.4, 1.9] },
    sections: [
      { title: 'Drive mode', controls: [{ id: 'drive.mode', type: 'modes', options: DRIVE_MODES, def: 'earth' }] },
      {
        controls: [
          S('drive.regen', 'Regenerative braking', [['low', 'Low'], ['medium', 'Medium'], ['high', 'High']], 'medium', 'High is close to one-pedal driving'),
          T('drive.creep', 'Creep', true, 'Moves off slowly when the brake is released'),
          S('drive.steer', 'Steering feel', [['comfort', 'Comfort'], ['standard', 'Standard'], ['sport', 'Sport']], 'standard'),
          T('drive.hold', 'Auto hold', true, 'Holds the car at a stop until you press the accelerator'),
          T('drive.traction', 'Traction control', true),
          T('drive.hdc', 'Hill descent control', false),
          T('drive.terrain', 'Special terrain mode', false),             // VCU_SpclTerrainModEnaSig
        ],
      },
    ],
  },
  {
    id: 'assist', label: 'Assist', icon: 'radar', zone: 'sensors', roof: false,
    focus: { at: [0, 0.4, -0.7], az: 32, el: 34, fit: [6.4, 4.4] },
    sections: [
      {
        note: 'The settings the car really uses are under the gear → CAN settings. These are for show.',
        controls: [T('icc.global', 'Active safety', true)],   // ICC_ActvStyGlblSetting (0 = On)
      },
      {
        title: 'Cruise',
        controls: [
          T('icc.acc', 'Adaptive cruise', true),                                                       // ICC_ACCSwt
          S('icc.accType', 'Cruise type', [[1, 'Basic'], [2, 'Advanced'], [3, 'ISA']], 2),            // ICC_ACCFuncTyp
          S('icc.gap', 'Following distance', [[1, '1'], [2, '2'], [3, '3'], [4, '4']], 3),             // ICC_UsrProfTiGapSet
          T('icc.autoSpeed', 'Set speed follows the limit', false),                                    // ICC_ACCAutoSpdSts
          S('icc.offsetType', 'Over the limit', [[0, 'Never'], [1, 'Percent'], [2, 'Fixed']], 1),      // ICC_ACCSpdLimOffsTyp
          S('icc.step', 'Set-speed step', [[0, '1'], [1, '5']], 1),                                    // ICC_ACCSpdStepSize
          T('icc.terrain', 'Slow for curves and hills', true),                                         // ICC_ACCTerrainSetting
          T('icc.lcAssist', 'Lane change assist', true),                                               // ICC_EnbLnChgAsst
          T('icc.trajectory', 'Show the planned path', true),                                          // ICC_LaneTrajectorySetting
        ],
      },
      {
        title: 'Lane keeping',
        controls: [
          S('icc.lka', 'Lane keeping (LKA)', [[0, 'Off'], [1, 'Warn'], [2, 'Warn + steer']], 2),      // ICC_LKA_Setting
          S('icc.lkaWarn', 'Warning', [[0, 'Sound, visual + haptic'], [1, 'Sound + visual']], 0),     // ICC_LKA_SettingWrnTyp
          T('icc.elka', 'Emergency lane keeping (ELKA)', true),                                        // ICC_ELKASteeringInterventionSet
          T('icc.esa', 'Evasive steering assist (ESA)', true),                                         // ICC_ESA_Setting
          T('icc.vibrate', 'Steering wheel vibration', true),                                          // ICC_SteerWhlVibrSet
        ],
      },
      {
        title: 'Collisions',
        controls: [
          S('icc.facm', 'Forward collision (FACM)', OFF_WARN_BRAKE, 2),                                // ICC_FACM_Setting
          S('icc.aebSens', 'Forward warning timing', SENSITIVITY, 0),                                  // ICC_AEB_Sensitivity
          T('icc.dynSens', 'Adapt timing to driving', true),                                           // ICC_FACM_DynmcSenstvty (0 = On)
          T('icc.jerk', 'Brake pulse warning', true),                                                  // ICC_AEB_JerkSetReq
          S('icc.bacm', 'Reversing collision (BACM)', OFF_WARN_BRAKE, 2),                              // ICC_BACM_Setting
          S('icc.bacmSens', 'Reversing warning timing', SENSITIVITY, 0),                               // ICC_BACM_Sensitivity
          S('icc.fcta', 'Front cross traffic (FCTA)', OFF_WARN_BRAKE, 1),                              // ICC_FCTA_Setting
          S('icc.fctaSens', 'Cross traffic timing', SENSITIVITY, 0),                                   // ICC_FCTA_Sensitivity
          T('icc.dcaa', 'DCAA', true),                                                                 // ICC_DCAASetting
        ],
      },
      {
        title: 'Blind spot',
        controls: [
          S('icc.bsd', 'Blind spot (BSD)', ALERT_LEVELS, 2),                                           // ICC_BSDSetting
          S('icc.bsdSens', 'Timing', SENSITIVITY, 0),                                                  // ICC_BSD_Sensitivity
          S('icc.dow', 'Door open warning (DOW)', [[0, 'Off'], [1, 'Visual'], [2, '+ Sound']], 2),     // ICC_DOW_Setting
        ],
      },
      {
        title: 'Speed and signs',
        controls: [
          SEL('icc.isa', 'Speed assist (ISA)', [[0, 'Off'], [1, 'Display warning'], [2, 'Display + chime'], [3, 'Display + control'], [4, 'Display, chime + control']], 2),   // ICC_ISASetting
          T('icc.tsr', 'Traffic sign recognition', true),                                              // ICC_TSR_Setting
          SEL('icc.tlr', 'Traffic lights', [[0, 'Off'], [1, 'On'], [2, 'Chime'], [3, 'Chime on red'], [4, 'Chime on green']], 4),   // ICC_TLR_Setting
          S('icc.warnType', 'Warnings', ALERT_LEVELS, 2),                                              // ICC_WarnTypeSetting
        ],
      },
      {
        title: 'Parking',
        controls: [
          T('icc.apa', 'Automated parking (APA)', true),                                               // ICC_APA_Setting (2 = Enabled)
          S('icc.parkIn', 'Park in', [[0, 'Nose in'], [1, 'Back in']], 1),                             // ICC_APAParkInDirSetting
          S('icc.parkOut', 'Pull out to the', [[1, 'Left'], [0, 'Right']], 1),                         // ICC_APAParkOutDirSetting
          T('icc.rap', 'Remote parking (RAP)', false),                                                 // ICC_RAP_Setting
          T('icc.tp', 'Trained parking', false),                                                       // ICC_TP_Setting
          S('icc.curb', 'Curb protection', [[0, 'Off'], [1, 'Warn'], [2, 'Brake']], 1),                // ICC_WSPPA_Setting
          T('icc.chime', 'Parking sensor chime', true),                                                // ICC_ParkAsstChmAlrt
          T('icc.autoView', 'Camera view when parking', true),                                         // ICC_AutomaticViewReq
          T('icc.overlay', 'Camera guide lines', true),                                                // ICC_GraphicOverlayReq
        ],
      },
    ],
  },
  {
    id: 'energy', label: 'Energy', icon: 'bolt', zone: 'port', roof: false,
    focus: { at: [-0.6, 0.62, 1.6], az: -52, el: 22, fit: [3.2, 1.9] },
    chips: [{ anchor: 'port', id: 'energy.port', kind: 'port', label: 'Charge port', toward: [-0.6, -0.8] }],
    sections: [
      { controls: [{ type: 'hero' }] },
      {
        title: 'Charging',
        controls: [
          R('energy.limit', 'Charge limit', 50, 100, 5, 80, '%', 'Daily use; 100% before a long trip'),
          R('energy.amps', 'Charge current', 8, 48, 1, 32, 'A'),
          T('energy.charging', 'Charging', false, 'Plugged in, as if at home'),
          T('energy.schedule', 'Scheduled charging', true, 'Starts when off-peak rates do'),
          SEL('energy.start', 'Start at', [['21:00', '9:00 PM'], ['23:00', '11:00 PM'], ['00:00', '12:00 AM'], ['01:00', '1:00 AM']], '23:00'),
        ],
      },
      {
        title: 'Power out',
        controls: [
          T('energy.v2l', 'Vehicle to load (V2L)', false, 'Powers devices from the charge port'),
          R('energy.v2lMin', 'Stop powering devices at', 10, 50, 5, 20, '%'),
        ],
      },
      {
        title: 'SolarSky',
        controls: [{ type: 'info', items: [['Today', '1.4 mi of range'], ['This month', '38 mi'], ['Since new', '612 mi']] }],
      },
    ],
  },
  {
    id: 'audio', label: 'Audio', icon: 'speaker', zone: 'amp', roof: true,
    focus: { at: [0, 0.75, 3.1], az: 152, el: 46, fit: [2.6, 2.6] },
    sections: [
      {
        title: 'Equalizer',
        controls: [
          S('audio.preset', 'Preset', [[1, 'Preset 1'], [2, 'Preset 2'], [3, 'Preset 3']], 1),
          R('audio.htreble', 'High treble', -10, 10, 1, 0, ''),
          R('audio.treble', 'Treble', -10, 10, 1, 2, ''),
          R('audio.mid', 'Mid', -10, 10, 1, 0, ''),
          R('audio.bass', 'Bass', -10, 10, 1, 3, ''),
          R('audio.sub', 'Sub bass', -10, 10, 1, 4, ''),
        ],
      },
      {
        title: 'Sound',
        controls: [
          S('audio.stage', 'Sound stage', [['all', 'All'], ['driver', 'Driver'], ['passenger', 'Passenger'], ['front', 'Front'], ['rear', 'Rear']], 'all'),
          T('audio.hyper', 'Fisker HyperSound', true),
        ],
      },
      {
        title: 'Radio',
        controls: [{ id: 'audio.announce', type: 'checks', label: 'Announcements', options: [['traffic', 'Traffic'], ['news', 'News'], ['alarm', 'Emergency alerts']], def: ['traffic', 'alarm'] }],
      },
    ],
  },
  {
    id: 'doors', label: 'Doors', icon: 'door', zone: 'doors', roof: false,
    focus: { at: [0, 0.75, 2.6], az: -138, el: 24, fit: [4.7, 2.2] },
    chips: [
      { anchor: 'doorFL', id: 'door.Door_Front_L', kind: 'door', label: 'Front left' },
      { anchor: 'doorFR', id: 'door.Door_Front_R', kind: 'door', label: 'Front right' },
      { anchor: 'doorRL', id: 'door.Door_Rear_L', kind: 'door', label: 'Rear left' },
      { anchor: 'doorRR', id: 'door.Door_Rear_R', kind: 'door', label: 'Rear right' },
      { anchor: 'tailgate', id: 'door.Tailgate', kind: 'door', label: 'Liftgate' },
    ],
    sections: [
      { controls: [{ id: 'doors.locked', type: 'lock', def: true }] },
      {
        title: 'Locking',
        controls: [
          S('doors.unlock', 'Unlock', [[0, "Driver's door"], [1, 'All doors']], 1),     // BCM_DoorUnlockSetFb
          T('doors.walkaway', 'Lock when walking away', true),
          T('doors.offUnlock', 'Unlock when powered off', false),                         // BCM_OffAutoUnlckSetSts
          T('doors.closeWin', 'Close windows when locking', true),                        // BCM_ArmedClsWinSetSts
          T('doors.rain', 'Close the sunroof in rain', true),                             // BCM_RainClsSunroofSetSts
          T('doors.fold', 'Fold mirrors when locking', true),                             // BCM_MirrLockAutoSetSts
        ],
      },
      {
        title: 'Windows',
        controls: [
          T('doors.california', 'California Mode', false, 'Every window down at once'),
          T('doors.child', 'Rear child locks', false),
          T('doors.winLock', 'Lock rear window switches', false),
        ],
      },
    ],
  },
  {
    id: 'service', label: 'Service', icon: 'wrench', zone: 'wheels', roof: true,
    focus: { at: [0, 0.4, 2.38], az: 180, el: 90, fit: [3.4, 5.6] },
    chips: [
      { anchor: 'wheelFL', kind: 'tire', label: '42 psi' }, { anchor: 'wheelFR', kind: 'tire', label: '42 psi' },
      { anchor: 'wheelRL', kind: 'tire', label: '41 psi' }, { anchor: 'wheelRR', kind: 'tire', label: '42 psi' },
    ],
    sections: [
      {
        title: 'Vehicle',
        controls: [{ type: 'info', items: [['Model', 'Fisker Ocean Extreme'], ['Model year', '2023'], ['VIN', 'VCF1 •••• •••• 0042'], ['Odometer', '18,402 mi'], ['Software', 'FiskerOS 2.4']] }],
      },
      {
        title: 'Tires',
        controls: [
          { type: 'info', items: [['Recommended', '42 psi cold'], ['Last reset', 'Mar 14']] },
          B('Reset tire pressure', 'Tire pressure monitoring reset (mockup)'),
        ],
      },
      {
        title: 'Help',
        controls: [
          T('service.roadside', 'Roadside Mode', false, 'Keeps the car in neutral for towing'),
          B("Owner's manual", "The owner's manual would open here (mockup)"),
          B('Schedule service', 'A service request would be sent here (mockup)'),
        ],
      },
    ],
  },
  {
    id: 'display', label: 'Display', icon: 'screen', zone: 'screen', roof: true,
    focus: { at: [0, 0.9, 1.84], az: 180, el: 14, r: 1.3 },
    sections: [
      {
        controls: [
          R('display.bright', 'Brightness', 0, 100, 5, 70, '%'),
          T('display.auto', 'Auto brightness', true),
          S('display.theme', 'Appearance', [['auto', 'Auto'], ['light', 'Light'], ['dark', 'Dark']], 'auto'),
          T('display.hollywood', 'Hollywood Mode', false, 'Turns the screen sideways, for video when parked'),
          S('display.cluster', 'Driver display', [['minimal', 'Minimal'], ['standard', 'Standard'], ['map', 'Map']], 'standard'),
          T('display.clean', 'Clean screen', false, 'Locks the screen for 30 s to wipe it'),
        ],
      },
    ],
  },
  // ---- system: no part of the car ----
  {
    id: 'connectivity', label: 'Connectivity', icon: 'wifi', system: true,
    sections: [
      {
        title: 'Bluetooth',
        controls: [
          T('conn.bt', 'Bluetooth', true),
          { type: 'list', items: [['Phone', 'Connected · phone, music', 'ok'], ['Work phone', 'Last used 3 days ago'], ['Headphones', 'Not connected']] },
          B('Pair a new device', 'The car would be visible as "Fisker Ocean" now (mockup)'),
        ],
      },
      {
        title: 'Wi-Fi',
        controls: [
          T('conn.wifi', 'Wi-Fi', true),
          { type: 'list', items: [['Home', 'Connected', 'ok'], ['Office guest', 'Saved']] },
        ],
      },
      {
        title: 'Hotspot',
        controls: [
          T('conn.hotspot', 'Hotspot', true, 'The comma joins this network'),
          { type: 'list', items: [['comma device', 'Connected · this HUD', 'ok']] },
          T('conn.cellular', 'Mobile data', true),
        ],
      },
    ],
  },
  {
    id: 'profiles', label: 'Profiles & Keys', icon: 'person', system: true,
    sections: [
      {
        title: 'Driver profiles',
        controls: [
          S('profile.active', 'Driving as', [[1, 'Driver 1'], [2, 'Driver 2'], [0, 'Guest']], 1),
          T('profile.recognize', 'Pick the profile from the key', true),
          B('Add a profile', 'A new profile would start here (mockup)'),
        ],
      },
      {
        title: 'Keys',
        controls: [
          { type: 'list', items: [['Phone key', 'Driver 1 · this phone', 'ok'], ['Key card', 'Driver 1'], ['Key fob', 'Driver 2']] },
          B('Add a key', 'Hold the new key to the reader (mockup)'),
          T('profile.valet', 'Valet mode', false, 'Limits speed and locks the glovebox and settings'),
        ],
      },
    ],
  },
  {
    id: 'navigation', label: 'Navigation', icon: 'pin', system: true,
    sections: [
      {
        controls: [
          T('nav.buildings', 'Buildings in 3D', true),
          S('nav.voice', 'Voice guidance', [['off', 'Off'], ['alerts', 'Alerts'], ['on', 'On']], 'on'),
          { id: 'nav.avoid', type: 'checks', label: 'Avoid', options: [['highways', 'Highways'], ['tolls', 'Tolls'], ['ferries', 'Ferries'], ['unpaved', 'Unpaved roads']], def: ['ferries'] },
        ],
      },
      {
        title: 'Downloaded maps',
        controls: [
          { type: 'list', items: [['California', '1.8 GB · up to date', 'ok'], ['Nevada', '0.6 GB · update available']] },
          B('Download more maps', 'The map list would open here (mockup)'),
        ],
      },
    ],
  },
  {
    id: 'general', label: 'General', icon: 'sliders', system: true,
    sections: [
      {
        controls: [
          S('general.distance', 'Distance', [['mi', 'Miles'], ['km', 'Kilometers']], 'mi'),
          S('general.temp', 'Temperature', [['f', '°F'], ['c', '°C']], 'f'),
          S('general.clock', 'Clock', [[12, '12 h'], [24, '24 h']], 12),
          SEL('general.language', 'Language', [['en-US', 'English (US)'], ['en-GB', 'English (UK)'], ['de', 'Deutsch'], ['fr', 'Français'], ['es', 'Español']], 'en-US'),
          R('general.chime', 'Chime volume', 0, 10, 1, 6, ''),
        ],
      },
    ],
  },
  {
    id: 'software', label: 'Software', icon: 'download', system: true,
    sections: [
      {
        controls: [
          { type: 'info', items: [['Version', 'FiskerOS 2.4.0'], ['Installed', 'Sep 18'], ['Update', '2.4.1 · 1.2 GB']] },
          B('Release notes', 'The release notes would open here (mockup)'),
          T('software.cellular', 'Download over mobile data', false),
        ],
      },
      {
        title: 'Install 2.4.1',
        controls: [
          { type: 'note', text: "The car can't be driven for about 25 minutes while it installs." },
          B('Schedule', 'The update would be scheduled for 2:00 AM (mockup)'),
          B('Install now', 'The update would start now (mockup)', 'primary'),
        ],
      },
      {
        title: 'Reset',
        controls: [B('Reset vehicle settings', 'Every setting would go back to its default (mockup)', 'danger')],
      },
    ],
  },
];

function seatControls(seat, driver) {
  return [
    { id: `seat.${seat}.heat`, type: 'levels', label: 'Heat', kind: 'heat', max: 3, def: driver ? 2 : 0 },
    { id: `seat.${seat}.vent`, type: 'levels', label: 'Ventilation', kind: 'vent', max: 3, def: 0 },
    { id: `seat.${seat}.pos`, type: 'pad', label: 'Position' },
    R(`seat.${seat}.lumbar`, 'Lumbar', 0, 10, 1, driver ? 4 : 2, ''),
    ...(driver ? [
      S('seat.memory', 'Memory', [[1, '1'], [2, '2'], [3, '3']], 1),
      T('seat.easy', 'Easy entry', true),
    ] : []),
  ];
}

// the default of every control by id
export function defaults() {
  const out = {};
  const add = (c) => { if (c.id && c.def !== undefined) out[c.id] = Array.isArray(c.def) ? [...c.def] : c.def; };
  for (const cat of CATEGORIES) {
    for (const card of cat.cards || []) card.controls.forEach(add);
    for (const sec of cat.sections || []) sec.controls.forEach(add);
  }
  Object.assign(out, {
    'climate.tempL': 21.5, 'climate.tempR': 21.5, 'climate.sync': true,
    'seat.RL.heat': 0, 'seat.RR.heat': 0, 'energy.soc': 72, 'energy.port': false,
    'door.Door_Front_L': false, 'door.Door_Front_R': false, 'door.Door_Rear_L': false, 'door.Door_Rear_R': false, 'door.Tailgate': false,
  });
  return out;
}
