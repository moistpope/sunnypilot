// Car controls, the content: the categories in the ribbon, how each frames the car and what it lights
// up, and its controls. The menus follow the Ocean head unit's settings (the X297 user guide) where the
// guide shows them.
//
// On the car (the Android app on Pulse, wired to IBUS1 and IBUS2) a control can be live, sent, or off:
//   live   its value follows what the car reports (carstate.js over the app's CAN link): the signal is
//          named beside it. The 3D car follows the same values.
//   tx     setting it sends the head unit's own control message (cancmd.js, ibus_tables.js): the car acts
//          as if the head unit's screen had been touched, and the live value shows the result.
//   off    there's no message for it, or the head unit sends that message itself every second with its own
//          values (drive mode, charging, brightness...), which would undo ours at once. Shown greyed, with why.
// In a plain browser nothing is live and nothing is sent: the mockup values stand.
//
// A category: id, label, icon (util.js), zone (cutaway.js ZONES: what glows and where a tap picks it),
// focus (the camera: at [x, y, z] car frame, az deg from ahead clockwise seen from above, el deg above
// the horizon, fit [across, up] m to fill the free screen area (fitP: in portrait), or r m), roof (fade the roof), ghost
// (parts kept solid while the rest turns see-through), and either cards (on-car) or sections (panel).
//
// A section: { kind, title, note, controls }. kind 'rows' (the default) lists the controls; 'tiles' lays
// toggles and actions out as cells; 'climate' is the Tesla climate bar (carcontrols.js climate());
// 'status' is Energy's one line; 'hidden' holds controls the 3D car and the chips need (live readers,
// defaults) that the sheet doesn't show. A control may carry an icon (util.js ICONS) for a tile or a bar.
//
// A control: { id, type, label, sub, def, live, tx, off, icon, ... } with type
//   toggle, seg (options), slider (min max step unit), select (options), levels (max, kind), swatches, modes,
//   checks, seatpos (a seat's adjusters), hold (buttons held: down/up), button (style, toast), action (does
//   something on the car: action), list (items), info (items [key, value]), hero (energy summary), lock
//   (locked / unlocked), note (text).

// ---- the head unit's messages the HUD sends (ibus_tables.js TX_MESSAGES) ------------------------------
export const MSG = { BODY: 0x4E, CLIMATE: 0x530, CLIMATE2: 0x534, PROFILE: 0x90, SEATHEAT: 0x528, SEATMOVE: 0x533, LIFTGATE: 0x52 };
const AUDIO_FRAME = 'Its message (ICC_0x46) also carries every audio volume and the mute, with nothing to copy the current ones from: sending it would reset the audio';
const ON_OFF = { true: 1, false: 2 };   // the 0x4E "1 On / 2 Off" convention (0 = inactive)

// tx helpers: (cmd, value, carState) -> sends
const req = (addr, sig, map) => (cmd, v) => cmd.request(addr, { [sig]: typeof map === 'function' ? map(v) : map[v] });
const pulse = (addr, sig, map) => (cmd, v) => cmd.pulse(addr, { [sig]: typeof map === 'function' ? map(v) : map[v] });
/** A button the head unit sends as one "press" that toggles the car's state: pressed only when the car isn't there yet. */
const press = (addr, sig, val, liveFn) => (cmd, v, cs) => { const cur = liveFn(cs); if (cur === undefined || !!cur !== !!v) cmd.request(addr, { [sig]: val }); };
// live helpers: (carState) -> value or undefined
const raw = (sig) => (cs) => cs.rawOf(sig);
const bool = (sig) => (cs) => { const r = cs.rawOf(sig); return r === undefined ? undefined : r === 1; };
const map = (sig, table) => (cs) => { const r = cs.rawOf(sig); return r === undefined ? undefined : table[r]; };
const HEAT_FROM_CAR = { 1: 3, 2: 2, 3: 1, 4: 0 };   // DSMC/PSM heat status: High/Med/Low/Off -> levels 3..0
const HEAT_TO_CAR = { 0: 4, 1: 3, 2: 2, 3: 1 };

const OWNED = 'The head unit sends this setting itself every second; a request of ours would be undone at once';
const NO_MSG = 'The car has no message for this';
const MOCK = 'Mockup: nothing on the car for this';
const ADAS = 'Set under the gear menu → CAN settings (the comma sends the driver-assistance settings)';

const T = (id, label, def, sub, x = {}) => ({ id, type: 'toggle', label, def, sub, ...x });
const S = (id, label, options, def, sub, x = {}) => ({ id, type: 'seg', label, options, def, sub, ...x });
const R = (id, label, min, max, step, def, unit, sub, x = {}) => ({ id, type: 'slider', label, min, max, step, def, unit, sub, ...x });
const SEL = (id, label, options, def, sub, x = {}) => ({ id, type: 'select', label, options, def, sub, ...x });
const B = (label, toast, style, sub) => ({ type: 'button', label, toast, style, sub, off: MOCK });
const ACT = (label, action, style, sub, x = {}) => ({ type: 'action', label, action, style, sub, ...x });   // carcontrols.js actions

// ---- option lists from the DBCs (raw value -> label) --------------------------------------------------
const OFF_WARN_BRAKE = [[0, 'Off'], [1, 'Warn'], [2, 'Warn + brake']];             // ICC_FACM_Setting, ICC_BACM_Setting, ICC_FCTA_Setting
const SENSITIVITY = [[2, 'Late'], [0, 'Normal'], [1, 'Early']];                     // ICC_AEB_Sensitivity, ICC_BACM_Sensitivity, ICC_FCTA_Sensitivity, ICC_BSD_Sensitivity
const ALERT_LEVELS = [[0, 'Off'], [1, 'Visual'], [2, '+ Sound'], [3, '+ Vibration']];   // ICC_BSDSetting, ICC_WarnTypeSetting

// The Ocean's seats heat (no ventilation) and adjust: the cushion slides, it goes up and down, its front
// edge tilts, and the back reclines (no lumbar). Positions: slide (+ forward), front and rear (+ up), m;
// recline (+ back), rad.
export const SEAT_LIMITS = { slide: [-0.12, 0.12], front: [-0.03, 0.04], rear: [-0.03, 0.05], recline: [-0.14, 0.45] };
export const SEAT_MEMORY = {   // memory positions, mock (the car keeps its own)
  1: { slide: 0, front: 0, rear: 0, recline: 0 },
  2: { slide: -0.08, front: 0.01, rear: -0.01, recline: 0.14 },
  3: { slide: 0.06, front: 0.02, rear: 0.03, recline: -0.06 },
};

/** The driver's seat as the car reports it (DSMC_0x4F5, 0..100 % each), in the model's units. */
export function seatFromCar(cs) {
  const track = cs.rawOf('DSMC_DrvrSeatTrackPosn'), hei = cs.rawOf('DSMC_DrvrSeatHeiPosn'), back = cs.rawOf('DSMC_DrvrSeatBackPosn');
  if (track === undefined && hei === undefined && back === undefined) return undefined;
  const lerp = (p, [lo, hi]) => lo + (hi - lo) * Math.max(0, Math.min(100, p)) / 100;
  return {
    slide: track === undefined ? 0 : lerp(100 - track, SEAT_LIMITS.slide),   // 0 % = all the way back
    front: hei === undefined ? 0 : lerp(hei, SEAT_LIMITS.front),
    rear: hei === undefined ? 0 : lerp(hei, SEAT_LIMITS.rear),
    recline: back === undefined ? 0 : lerp(back, SEAT_LIMITS.recline),
  };
}

export const DRIVE_MODES = [   // Ocean drive modes, with the color the car shows for each
  ['earth', 'Earth', 'Range first, gentle response', '#2fa84f'],
  ['fun', 'Fun', 'Balanced, livelier pedal', '#3e8bff'],
  ['hyper', 'Hyper', 'Full power, sport steering', '#ff5a2a'],
];
const DRIVE_MODE_FROM_CAR = { 0: 'earth', 1: 'fun', 2: 'hyper' };   // VCU_DrvModSigFb Eco / Normal / Sport

export const CATEGORIES = [
  {
    id: 'lighting',
 label: 'Lighting', icon: 'beam', zone: 'lamps', roof: false,
    focus: { at: [0, 0.78, 0.2], az: 0, el: 9, fit: [4.8, 1.7] },
    cards: [
      {
        title: 'Exterior lights', anchor: 'lampL',
        controls: [
          // BCM_ExtLampSwtSts is the stalk's position; the head unit's message switches the lamps themselves
          S('light.mode', 'Headlights', [[0, 'Off'], [1, 'Auto'], [2, 'Parking'], [3, 'Low']], 1, 'Auto is the stalk\'s own position: it can\'t be sent', {
            live: raw('BCM_ExtLampSwtSts'),
            tx: (cmd, v) => {
              if (v === 0) cmd.request(MSG.BODY, { ICC_LoBeamCtrl: 2, ICC_PosnLampCtrl: 4 });
              else if (v === 2) cmd.request(MSG.BODY, { ICC_LoBeamCtrl: 2, ICC_PosnLampCtrl: 3 });
              else if (v === 3) cmd.request(MSG.BODY, { ICC_LoBeamCtrl: 1, ICC_PosnLampCtrl: 3 });
              else cmd.app.toast('Auto: turn the stalk to Auto; the head unit has no message for it');
            },
          }),
          T('light.ahb', 'Auto high beam', true, null, { off: ADAS }),               // ICC_AHBA_Setting
          T('light.adb', 'Adaptive driving beam', false, null, { live: bool('BCM_EnaSts_ADB'), tx: req(MSG.BODY, 'ICC_abdEnaReq', ON_OFF) }),
        ],
      },
      {
        title: 'Welcome & interior', anchor: 'lampR',
        controls: [
          S('light.home', 'Follow me home', [[0, 'Off'], [1, '15 s'], [2, '30'], [3, '45'], [4, '60']], 2, null,
            { live: raw('BCM_FolwMeSetStsFb'), off: AUDIO_FRAME }),
          T('light.welcome', 'Welcome lights', true, null, { off: NO_MSG }),
          S('light.interior', 'Interior lights off after', [[1, '0 s'], [2, '15'], [3, '30'], [4, '45'], [5, '60']], 3, null,
            { live: raw('BCM_IntLampTiSetSts'), off: AUDIO_FRAME }),
          T('light.ambient', 'Ambient lighting', true, null, { off: OWNED }),   // ICC_0x336, with an E2E counter
          R('light.ambientLevel', 'Ambient brightness', 0, 100, 5, 60, '%', null, { off: OWNED }),
        ],
      },
    ],
  },
  {
    id: 'climate',
 label: 'Climate', icon: 'fan', zone: 'vents', roof: true, hvac: true,
    // from between the front seats, at the dash: the air from the vents shows, colored by each side's temperature
    focus: { at: [0, 1.0, 1.7], az: 180, el: 18, r: 1.75 },   // the whole dash, the front seats framing it
    // Tesla's climate screen (carcontrols.js climate()): every control has a fixed place in three rows of
    // borderless buttons. Row 1: power, Auto, A/C; the three vents (windshield, face, feet) with Front / Rear
    // under them; Schedule at the right. Row 2: the heated wheel and the defrosters; the fan between its
    // arrows; recirculation and the purifier. Row 3: the two set temperatures between their arrows, Sync
    // between. The seat heaters are under Seats; the Ocean has no keep-climate or pet mode.
    sections: [
      {
        kind: 'climate',
        controls: [
          { id: 'climate.temps', type: 'temps' },
          T('climate.on', 'Climate', true, null, { icon: 'power', live: (cs) => { const f = cs.rawOf('ECC_WindSpdSts'); return f === undefined ? undefined : f > 0; },
            tx: (cmd, v) => cmd.request(MSG.CLIMATE2, { ICC_ECCSysSwtCmd: v ? 1 : 2 }) }),
          T('climate.auto', 'Auto', true, 'Fan and airflow follow the set temperature', { icon: 'auto', live: bool('ECC_AUTOSts'), tx: press(MSG.CLIMATE, 'ICC_ECCAUTOReq', 1, bool('ECC_AUTOSts')) }),
          T('climate.ac', 'A/C', true, null, { icon: 'snow', live: bool('ECC_ACSts'), tx: press(MSG.CLIMATE, 'ICC_ACSwtReq', 1, bool('ECC_ACSts')) }),
          // the vents: the car knows five front patterns and four rear ones; the three vent buttons pick the nearest
          S('climate.flow', 'Front vents', [[1, 'Face'], [2, 'Face and feet'], [3, 'Feet'], [4, 'Feet and windshield'], [5, 'Windshield']], 1, null,
            { live: raw('ECC_DrvrAirOutlMod'), tx: (cmd, v) => cmd.request(MSG.CLIMATE2, { ICC_DrvrBlowModReq: v, ICC_PassBlowModReq: v }) }),
          S('climate.rear', 'Rear vents', [[0, 'Face'], [1, 'Face and feet'], [2, 'Feet'], [3, 'Off']], 0, null,
            { live: raw('ECC_BackRowAirOutlModSts'), tx: req(MSG.CLIMATE2, 'ICC_BackRowAirOutlModReq', v => v + 1) }),
          T('climate.precond', 'Schedule', false, 'Precondition before departure', { icon: 'clock', off: 'The telematics unit keeps the schedules' }),
          T('climate.wheel', 'Heated steering wheel', false, 'The car doesn\'t report whether it\'s on', { icon: 'wheelheat', heat: true, tx: (cmd, v) => cmd.pulse(MSG.SEATHEAT, { ICC_SWH_Req: 1 }) }),
          T('climate.defrostF', 'Front defrost', false, null, { icon: 'defrostF', live: bool('ECC_MaxFrntDefrst'), tx: press(MSG.CLIMATE, 'ICC_MaxFrntDefrstSet', 1, bool('ECC_MaxFrntDefrst')) }),
          T('climate.defrostR', 'Rear defrost', false, null, { icon: 'defrostR', live: bool('BCM_ReDefrstHeatgCmd'), tx: req(MSG.BODY, 'ICC_ReDefrstOpenReq', ON_OFF) }),
          R('climate.fan', 'Fan', 1, 7, 1, 3, '', null, { icon: 'fan', live: raw('ECC_WindSpdSts'), tx: req(MSG.CLIMATE, 'ICC_AirVolSet', v => v) }),
          S('climate.recirc', 'Recirculate', [[1, 'Fresh'], [0, 'Recirculate']], 1, null, { icon: 'recirc', live: raw('ECC_CircSts'), tx: press(MSG.CLIMATE, 'ICC_ECCIntExtCircReq', 1, raw('ECC_CircSts')) }),
          T('climate.purify', 'Air purifier', false, null, { icon: 'purify', live: bool('ECC_AirClnSts'), tx: req(MSG.CLIMATE, 'ICC_AirClnSwtReq', { true: 1, false: 0 }) }),
        ],
      },
    ],
  },
  {
    id: 'seats',
 label: 'Seats', icon: 'seat', zone: 'seats', roof: true, ghost: ['Seat_FL', 'Seat_FR', 'Seat_Rear', 'Console'],
    focus: { at: [0, 0.82, 2.6], az: -38, el: 38, fit: [3.2, 2.4], fitP: [3.6, 2.8] },
    cards: [
      { title: 'Driver', anchor: 'seatFL', seat: 'FL', controls: seatControls('FL', true) },
      { title: 'Passenger', anchor: 'seatFR', seat: 'FR', controls: seatControls('FR', false) },
    ],
    chips: [
      { anchor: 'seatRL', id: 'seat.RL.heat', kind: 'heat', label: 'Rear left', live: map('DSMC_RearLeSeatHeatgSts', HEAT_FROM_CAR), tx: pulse(MSG.SEATHEAT, 'ICC_RearLeSeatHeatgReq', HEAT_TO_CAR) },
      { anchor: 'seatRR', id: 'seat.RR.heat', kind: 'heat', label: 'Rear right', live: map('DSMC_RearRiSeatHeatgSts', HEAT_FROM_CAR), tx: pulse(MSG.SEATHEAT, 'ICC_RearRiSeatHeatgReq', HEAT_TO_CAR) },
    ],
  },
  {
    id: 'driving',
 label: 'Driving', icon: 'gauge', zone: 'drive', roof: false, ghost: ['Seat_FL', 'Seat_FR', 'Seat_Rear'],
    focus: { at: [0, 0.62, 2.4], az: -90, el: 10, fit: [5.4, 1.9] },
    sections: [
      { title: 'Drive mode', controls: [{ id: 'drive.mode', type: 'modes', options: DRIVE_MODES, def: 'earth', live: map('VCU_DrvModSigFb', DRIVE_MODE_FROM_CAR), off: OWNED }] },   // ICC_0x610
      {
        kind: 'rows',
        controls: [
          S('drive.regen', 'Regenerative braking', [['low', 'Low'], ['medium', 'Medium'], ['high', 'High']], 'medium', 'High is close to one-pedal driving',
            { live: map('VCU_RegenLvlFb', { 0: 'low', 1: 'medium', 2: 'high' }), off: OWNED }),
          T('drive.creep', 'Creep', true, 'Moves off slowly when the brake is released', { icon: 'creep', live: (cs) => { const r = cs.rawOf('VCU_EPedlStsFb'); return r === undefined ? undefined : r === 2; }, off: OWNED }),
          S('drive.accel', 'Accelerator response', [['low', 'Low'], ['medium', 'Medium'], ['high', 'High']], 'medium', null,
            { live: map('VCU_AccelModFb', { 0: 'low', 1: 'medium', 2: 'high' }), off: OWNED }),
          S('drive.steer', 'Steering feel', [['comfort', 'Comfort'], ['standard', 'Standard'], ['sport', 'Sport']], 'standard', null, { off: OWNED }),   // ICC_0x336
        ],
      },
      {
        kind: 'tiles',
        controls: [
          T('drive.hold', 'Auto hold', true, 'Holds the car at a stop until you press the accelerator', { icon: 'hold', off: NO_MSG }),
          T('drive.traction', 'Traction control', true, null, { icon: 'traction', off: OWNED }),   // ICC_0x336 ESP switch
          T('drive.hdc', 'Hill descent', false, null, { icon: 'hill', off: OWNED }),
          T('drive.terrain', 'Special terrain mode', false, null, { icon: 'terrain', live: bool('VCU_SpclTerrainModEnaSig'), off: OWNED }),   // ICC_0x529
        ],
      },
    ],
  },
  {
    id: 'assist', label: 'Assist', icon: 'radar', zone: 'sensors', roof: false,
    focus: { at: [0, 0.4, -0.7], az: 32, el: 34, fit: [6.4, 4.4] },
    sections: [
      {
        note: 'The driver-assistance settings go to the car through the comma: gear → CAN settings. These show the head unit\'s own values.',
        controls: [T('icc.global', 'Active safety', true, null, { off: ADAS })],   // ICC_ActvStyGlblSetting (0 = On)
      },
      {
        title: 'Cruise',
        controls: [
          T('icc.acc', 'Adaptive cruise', true, null, { off: ADAS }),                                                       // ICC_ACCSwt
          S('icc.accType', 'Cruise type', [[1, 'Basic'], [2, 'Advanced'], [3, 'ISA']], 2, null, { off: ADAS }),            // ICC_ACCFuncTyp
          S('icc.gap', 'Following distance', [[1, '1'], [2, '2'], [3, '3'], [4, '4']], 3, null, { off: ADAS }),             // ICC_UsrProfTiGapSet
          T('icc.autoSpeed', 'Set speed follows the limit', false, null, { off: ADAS }),                                    // ICC_ACCAutoSpdSts
          S('icc.offsetType', 'Over the limit', [[0, 'Never'], [1, 'Percent'], [2, 'Fixed']], 1, null, { off: ADAS }),      // ICC_ACCSpdLimOffsTyp
          S('icc.step', 'Set-speed step', [[0, '1'], [1, '5']], 1, null, { off: ADAS }),                                    // ICC_ACCSpdStepSize
          T('icc.terrain', 'Slow for curves and hills', true, null, { off: ADAS }),                                         // ICC_ACCTerrainSetting
          T('icc.lcAssist', 'Lane change assist', true, null, { off: ADAS }),                                               // ICC_EnbLnChgAsst
          T('icc.trajectory', 'Show the planned path', true, null, { off: ADAS }),                                          // ICC_LaneTrajectorySetting
        ],
      },
      {
        title: 'Lane keeping',
        controls: [
          S('icc.lka', 'Lane keeping (LKA)', [[0, 'Off'], [1, 'Warn'], [2, 'Warn + steer']], 2, null, { off: ADAS }),      // ICC_LKA_Setting
          S('icc.lkaWarn', 'Warning', [[0, 'Sound, visual + haptic'], [1, 'Sound + visual']], 0, null, { off: ADAS }),     // ICC_LKA_SettingWrnTyp
          T('icc.elka', 'Emergency lane keeping (ELKA)', true, null, { off: ADAS }),                                        // ICC_ELKASteeringInterventionSet
          T('icc.esa', 'Evasive steering assist (ESA)', true, null, { off: ADAS }),                                         // ICC_ESA_Setting
          T('icc.vibrate', 'Steering wheel vibration', true, null, { off: ADAS }),                                          // ICC_SteerWhlVibrSet
        ],
      },
      {
        title: 'Collisions',
        controls: [
          S('icc.facm', 'Forward collision (FACM)', OFF_WARN_BRAKE, 2, null, { off: ADAS }),                                // ICC_FACM_Setting
          S('icc.aebSens', 'Forward warning timing', SENSITIVITY, 0, null, { off: ADAS }),                                  // ICC_AEB_Sensitivity
          T('icc.dynSens', 'Adapt timing to driving', true, null, { off: ADAS }),                                           // ICC_FACM_DynmcSenstvty (0 = On)
          T('icc.jerk', 'Brake pulse warning', true, null, { off: ADAS }),                                                  // ICC_AEB_JerkSetReq
          S('icc.bacm', 'Reversing collision (BACM)', OFF_WARN_BRAKE, 2, null, { off: ADAS }),                              // ICC_BACM_Setting
          S('icc.bacmSens', 'Reversing warning timing', SENSITIVITY, 0, null, { off: ADAS }),                               // ICC_BACM_Sensitivity
          S('icc.fcta', 'Front cross traffic (FCTA)', OFF_WARN_BRAKE, 1, null, { off: ADAS }),                              // ICC_FCTA_Setting
          S('icc.fctaSens', 'Cross traffic timing', SENSITIVITY, 0, null, { off: ADAS }),                                   // ICC_FCTA_Sensitivity
          T('icc.dcaa', 'DCAA', true, null, { off: ADAS }),                                                                 // ICC_DCAASetting
        ],
      },
      {
        title: 'Blind spot',
        controls: [
          S('icc.bsd', 'Blind spot (BSD)', ALERT_LEVELS, 2, null, { off: ADAS }),                                           // ICC_BSDSetting
          S('icc.bsdSens', 'Timing', SENSITIVITY, 0, null, { off: ADAS }),                                                  // ICC_BSD_Sensitivity
          S('icc.dow', 'Door open warning (DOW)', [[0, 'Off'], [1, 'Visual'], [2, '+ Sound']], 2, null, { off: ADAS }),     // ICC_DOW_Setting
        ],
      },
      {
        title: 'Speed and signs',
        controls: [
          SEL('icc.isa', 'Speed assist (ISA)', [[0, 'Off'], [1, 'Display warning'], [2, 'Display + chime'], [3, 'Display + control'], [4, 'Display, chime + control']], 2, null, { off: ADAS }),   // ICC_ISASetting
          T('icc.tsr', 'Traffic sign recognition', true, null, { off: ADAS }),                                              // ICC_TSR_Setting
          SEL('icc.tlr', 'Traffic lights', [[0, 'Off'], [1, 'On'], [2, 'Chime'], [3, 'Chime on red'], [4, 'Chime on green']], 4, null, { off: ADAS }),   // ICC_TLR_Setting
          S('icc.warnType', 'Warnings', ALERT_LEVELS, 2, null, { off: ADAS }),                                              // ICC_WarnTypeSetting
        ],
      },
      {
        title: 'Parking',
        controls: [
          T('icc.apa', 'Automated parking (APA)', true, null, { off: ADAS }),                                               // ICC_APA_Setting (2 = Enabled)
          S('icc.parkIn', 'Park in', [[0, 'Nose in'], [1, 'Back in']], 1, null, { off: ADAS }),                             // ICC_APAParkInDirSetting
          S('icc.parkOut', 'Pull out to the', [[1, 'Left'], [0, 'Right']], 1, null, { off: ADAS }),                         // ICC_APAParkOutDirSetting
          T('icc.rap', 'Remote parking (RAP)', false, null, { off: ADAS }),                                                 // ICC_RAP_Setting
          T('icc.tp', 'Trained parking', false, null, { off: ADAS }),                                                       // ICC_TP_Setting
          S('icc.curb', 'Curb protection', [[0, 'Off'], [1, 'Warn'], [2, 'Brake']], 1, null, { off: ADAS }),                // ICC_WSPPA_Setting
          T('icc.chime', 'Parking sensor chime', true, null, { off: ADAS }),                                                // ICC_ParkAsstChmAlrt
          T('icc.autoView', 'Camera view when parking', true, null, { off: ADAS }),                                         // ICC_AutomaticViewReq
          T('icc.overlay', 'Camera guide lines', true, null, { off: ADAS }),                                                // ICC_GraphicOverlayReq
          ACT('Mock APA', 'apa', 'primary', 'Try automated parking in a demo parking lot'),
        ],
      },
    ],
  },
  {
    id: 'energy',
 label: 'Energy', icon: 'bolt', zone: 'port', roof: false,
    focus: { at: [-0.6, 0.62, 1.6], az: -52, el: 22, fit: [3.2, 1.9] },
    // the charge shows as the pack filling (cutaway.js), the port door as the door itself (it's manual)
    sections: [
      { kind: 'status' },
      {
        kind: 'rows', title: 'Charging',
        controls: [
          R('energy.limit', 'Charge limit', 50, 100, 5, 80, '%', 'Daily use; 100% before a long trip', { fill: 'ok', off: OWNED }),   // ICC_0x610 SetChrgEndSOC
          R('energy.amps', 'Charge current', 8, 32, 1, 32, 'A', null, { stepper: true, live: raw('VCU_ACChrgCrtUpprLmt'), off: OWNED }),   // ICC_0x610 SetACChrgLmtCrt
          T('energy.charging', 'Charging', false, null, { as: 'button', labels: ['Start charging', 'Stop charging'],
            live: (cs) => { const p = cs.value('VCU_HVBattActPwr'); return p === undefined ? undefined : p > 0.3; }, off: OWNED }),   // ICC_0x610 Start/StopChrgBtn
        ],
      },
      {
        kind: 'rows', title: 'Schedule',
        controls: [
          T('energy.schedule', 'Scheduled charging', true, 'Starts when off-peak rates do', { off: 'The telematics unit keeps the schedules' }),
          SEL('energy.start', 'Start at', [['21:00', '9:00 PM'], ['23:00', '11:00 PM'], ['00:00', '12:00 AM'], ['01:00', '1:00 AM']], '23:00', null, { off: 'The telematics unit keeps the schedules' }),
        ],
      },
      {
        kind: 'rows', title: 'Power out',
        controls: [
          T('energy.v2l', 'Vehicle to load (V2L)', false, 'Powers devices from the charge port', { off: OWNED }),   // ICC_0x529
          R('energy.v2lMin', 'Stop powering devices at', 10, 50, 5, 20, '%', null, { off: OWNED }),
        ],
      },
      { kind: 'hidden', controls: [{ id: 'energy.port', type: 'hidden', def: false, live: bool('VCU_ACChrgShttrSts') }] },
    ],
  },
  {
    id: 'audio', label: 'Audio', icon: 'speaker', zone: 'amp', roof: true,
    focus: { at: [0, 0.75, 3.1], az: 152, el: 46, fit: [2.6, 2.6] },
    sections: [
      {
        title: 'Equalizer',
        note: 'One message (ICC_0x44) carries every audio setting at once and the car doesn\'t report them, so sending one would reset the rest.',
        controls: [
          S('audio.preset', 'Preset', [[1, 'Preset 1'], [2, 'Preset 2'], [3, 'Preset 3']], 1, null, { off: NO_MSG }),
          R('audio.htreble', 'High treble', -10, 10, 1, 0, '', null, { off: 'ICC_0x44: see above' }),
          R('audio.treble', 'Treble', -10, 10, 1, 2, '', null, { off: 'ICC_0x44: see above' }),
          R('audio.mid', 'Mid', -10, 10, 1, 0, '', null, { off: 'ICC_0x44: see above' }),
          R('audio.bass', 'Bass', -10, 10, 1, 3, '', null, { off: 'ICC_0x44: see above' }),
          R('audio.sub', 'Sub bass', -10, 10, 1, 4, '', null, { off: 'ICC_0x44: see above' }),
        ],
      },
      {
        title: 'Sound',
        controls: [
          S('audio.stage', 'Sound stage', [['all', 'All'], ['driver', 'Driver'], ['passenger', 'Passenger'], ['front', 'Front'], ['rear', 'Rear']], 'all', null, { off: NO_MSG }),
          T('audio.hyper', 'Fisker HyperSound', true, null, { off: NO_MSG }),
        ],
      },
      {
        title: 'Radio',
        controls: [{ id: 'audio.announce', type: 'checks', label: 'Announcements', options: [['traffic', 'Traffic'], ['news', 'News'], ['alarm', 'Emergency alerts']], def: ['traffic', 'alarm'], off: NO_MSG }],
      },
    ],
  },
  {
    id: 'doors',
 label: 'Doors & Windows', short: 'Doors', icon: 'door', zone: 'doors', roof: false,
    focus: { at: [0, 0.95, 2.9], az: -142, el: 30, fit: [4.6, 2.6] },
    // on the car: a drag control on each window the head unit can move (down opens, up closes; a tap on
    // an arrow goes all the way), one on the sunroof, one on the liftgate (up opens). What the car
    // reports (the quarter windows, the rear window) shows on the model alone.
    chips: [
      windowCtl('win.FL', 'Front left window', 'winFL', 'Door_Front_L', 'ICC_LeFrntWinCtrl', 'BCM_AP_FL_LeFrntWinPosnInfo', 'BCM_LeFrntWinSts'),
      windowCtl('win.FR', 'Front right window', 'winFR', 'Door_Front_R', 'ICC_RiFrntWinCtrl', 'BCM_AP_FL_RiFrntWinPosnInfo', 'BCM_RiFrntWinSts'),
      windowCtl('win.RL', 'Rear left window', 'winRL', 'Door_Rear_L', 'ICC_LeReWinCtrl', 'BCM_AP_FL_LeReWinPosnInfo', 'BCM_LeReWinSts'),
      windowCtl('win.RR', 'Rear right window', 'winRR', 'Door_Rear_R', 'ICC_RiReWinCtrl', 'BCM_AP_FL_RiReWinPosnInfo', 'BCM_RiReWinSt'),
      { anchor: 'sunroof', kind: 'winctl', sunroof: true, id: 'win.sunroof', label: 'Sunroof', def: 0,
        live: (cs) => { const p = cs.rawOf('BCM_SunroofPosnInfo'), ar = cs.rawOf('BCM_SunroofOpenAr'); return p === undefined || p === 0x7F ? undefined : ar === 1 ? 0 : Math.min(100, p); } },
      { anchor: 'liftgate', kind: 'liftctl', id: 'doors.liftgate', label: 'Liftgate', door: 'Tailgate', def: 0, live: raw('PLGM_LeTrPosn') },
    ],
    sections: [
      { controls: [{ id: 'doors.locked', type: 'lock', def: true, live: (cs) => { const r = cs.rawOf('BCM_FrntDrDoorLockSts'); return r === undefined ? undefined : r === 0; }, tx: req(MSG.BODY, 'ICC_CentrLockCtrl', { true: 2, false: 1 }) }] },
      {
        kind: 'tiles',
        controls: [
          ACT('California Mode', 'california', 'primary', 'Opens all eight: the windows, the rear window and the sunroof', { icon: 'window', off: OWNED }),   // ICC_0x336 ReqCalifModHMIBtn, E2E
          ACT('Close all', 'closeAll', null, 'The four door windows and the sunroof', { icon: 'close' }),
          T('doors.mirrors', 'Fold mirrors', false, null, { icon: 'mirror', live: map('BCM_MirrCmd', { 1: true, 2: false }), tx: req(MSG.BODY, 'ICC_MirrCmd', { true: 1, false: 2 }) }),
          T('doors.winLock', 'Rear window lock', false, null, { icon: 'winlock', off: NO_MSG }),
          T('doors.child', 'Child locks', false, null, { icon: 'child', off: NO_MSG }),
        ],
      },
      {
        kind: 'rows', title: 'Locking',
        controls: [
          S('doors.unlock', 'Unlock', [[0, "Driver's door"], [1, 'All doors']], 1, null, { live: raw('BCM_DoorUnlockSetFb'), tx: req(MSG.BODY, 'ICC_DoorUnlockSet', { 0: 1, 1: 2 }) }),
          T('doors.walkaway', 'Lock when walking away', true, 'The car doesn\'t report this setting', { tx: req(MSG.PROFILE, 'ICC_AutoLockUnlockCmd', { true: 3, false: 0 }) }),
          T('doors.offUnlock', 'Unlock when powered off', false, null, { live: bool('BCM_OffAutoUnlckSetSts'), tx: req(MSG.BODY, 'ICC_OffUnlckSet', ON_OFF) }),
          T('doors.closeWin', 'Close windows when locking', true, null, { live: bool('BCM_ArmedClsWinSetSts'), tx: req(MSG.BODY, 'ICC_ArmedClsdWinSet', ON_OFF) }),
          T('doors.fold', 'Fold mirrors when locking', true, null, { live: bool('BCM_MirrLockAutoSetSts'), tx: req(MSG.BODY, 'ICC_ReMirrAutoFoldSet', ON_OFF) }),
          T('doors.rain', 'Close the sunroof in rain', true, null, { live: bool('BCM_RainClsSunroofSetSts'), tx: req(MSG.BODY, 'ICC_RainClsdSunroofSet', ON_OFF) }),
        ],
      },
      // what the car reports that the model shows and the sheet doesn't list
      {
        kind: 'hidden',
        controls: [
          { id: 'win.QL', type: 'hidden', def: 0, live: (cs) => windowOpen(cs, 'BCM_AP_TL_LeReWinPosnInfo', 'BCM_AP_TL_LeReWinSts') },
          { id: 'win.QR', type: 'hidden', def: 0, live: (cs) => windowOpen(cs, 'BCM_AP_TL_RiReWinPosnInfo', 'BCM_AP_TL_RiReWinSts') },
          { id: 'win.rear', type: 'hidden', def: 0, live: (cs) => windowOpen(cs, 'BCM_AP_RW_WinPosnInfo', 'BCM_AP_RW_WinSts') },
          { id: 'win.sunroofMode', type: 'hidden', def: 'closed',
            live: (cs) => { const p = cs.rawOf('BCM_SunroofPosnInfo'), ar = cs.rawOf('BCM_SunroofOpenAr'); if (p === undefined || p === 0x7F) return undefined; return p > 0 && ar === 1 ? 'tilt' : p > 0 ? 'open' : 'closed'; } },
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
          T('service.roadside', 'Roadside Mode', false, 'Keeps the car in neutral for towing', { off: NO_MSG }),
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
          R('display.bright', 'Brightness', 0, 100, 5, 70, '%', null, { live: (cs) => { const r = cs.rawOf('BCM_BackgndBriLvl_Cfm'); return r === undefined ? undefined : Math.round((r + 1) * 10); }, off: OWNED }),   // ICC_0x529
          T('display.auto', 'Auto brightness', true, null, { off: OWNED }),
          S('display.theme', 'Appearance', [['auto', 'Auto'], ['light', 'Light'], ['dark', 'Dark']], 'auto', 'This screen\'s own setting'),
          ACT('Hollywood Mode', 'hollywood', null, 'Turns the screen sideways, for video when parked', { off: OWNED }),   // ICC_0x563, E2E
          S('display.cluster', 'Driver display', [['minimal', 'Minimal'], ['standard', 'Standard'], ['map', 'Map']], 'standard', null, { off: NO_MSG }),
          T('display.clean', 'Clean screen', false, 'Locks the screen for 30 s to wipe it', { off: MOCK }),
        ],
      },
    ],
  },
  // ---- system: no part of the car ----
  {
    id: 'connectivity', label: 'Connectivity', short: 'Network', icon: 'wifi', system: true,
    sections: [
      {
        title: 'Bluetooth',
        controls: [
          T('conn.bt', 'Bluetooth', true, null, { off: MOCK }),
          { type: 'list', items: [['Phone', 'Connected · phone, music', 'ok'], ['Work phone', 'Last used 3 days ago'], ['Headphones', 'Not connected']] },
          B('Pair a new device', 'The car would be visible as "Fisker Ocean" now (mockup)'),
        ],
      },
      {
        title: 'Wi-Fi',
        controls: [
          T('conn.wifi', 'Wi-Fi', true, null, { off: MOCK }),
          { type: 'list', items: [['Home', 'Connected', 'ok'], ['Office guest', 'Saved']] },
        ],
      },
      {
        title: 'Hotspot',
        controls: [
          T('conn.hotspot', 'Hotspot', true, 'The comma joins this network', { off: MOCK }),
          { type: 'list', items: [['comma device', 'Connected · this HUD', 'ok']] },
          T('conn.cellular', 'Mobile data', true, null, { off: MOCK }),
        ],
      },
    ],
  },
  {
    id: 'profiles', label: 'Profiles & Keys', short: 'Profiles', icon: 'person', system: true,
    sections: [
      {
        title: 'Driver profiles',
        controls: [
          S('profile.active', 'Driving as', [[1, 'Driver 1'], [2, 'Driver 2'], [0, 'Guest']], 1, null, { off: MOCK }),
          T('profile.recognize', 'Pick the profile from the key', true, null, { off: MOCK }),
          B('Add a profile', 'A new profile would start here (mockup)'),
        ],
      },
      {
        title: 'Keys',
        controls: [
          { type: 'list', items: [['Phone key', 'Driver 1 · this phone', 'ok'], ['Key card', 'Driver 1'], ['Key fob', 'Driver 2']] },
          B('Add a key', 'Hold the new key to the reader (mockup)'),
          T('profile.valet', 'Valet mode', false, 'Limits speed and locks the glovebox and settings', { off: OWNED }),
        ],
      },
    ],
  },
  {
    id: 'navigation', label: 'Navigation', icon: 'pin', system: true,
    sections: [
      {
        controls: [
          T('nav.buildings', 'Buildings in 3D', true, null, { off: MOCK }),
          S('nav.voice', 'Voice guidance', [['off', 'Off'], ['alerts', 'Alerts'], ['on', 'On']], 'on', null, { off: MOCK }),
          { id: 'nav.avoid', type: 'checks', label: 'Avoid', options: [['highways', 'Highways'], ['tolls', 'Tolls'], ['ferries', 'Ferries'], ['unpaved', 'Unpaved roads']], def: ['ferries'], off: MOCK },
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
          S('general.distance', 'Distance', [['mi', 'Miles'], ['km', 'Kilometers']], 'mi', 'This screen\'s own setting'),
          S('general.temp', 'Temperature', [['f', '°F'], ['c', '°C']], 'f', 'This screen\'s own setting'),
          S('general.clock', 'Clock', [[12, '12 h'], [24, '24 h']], 12, null, { off: MOCK }),
          SEL('general.language', 'Language', [['en-US', 'English (US)'], ['en-GB', 'English (UK)'], ['de', 'Deutsch'], ['fr', 'Français'], ['es', 'Español']], 'en-US', null, { off: MOCK }),
          R('general.chime', 'Chime volume', 0, 10, 1, 6, '', null, { off: 'ICC_0x46 carries every volume at once and the car doesn\'t report them' }),
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
          T('software.cellular', 'Download over mobile data', false, null, { off: MOCK }),
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

/** How far open a window is, from what the car reports: the position signal, 0.5 %/bit, 0 shut and 200 fully
 *  open, as the matrix says (checked on the car: the driver's window fully down reads 200, a shut rear one 0).
 *  255 means the car doesn't know (the quarter windows report that while plainly shut): unknown then. The
 *  open/closed bit only stands in when there's no position at all; it reads "closed" with the window down. */
export function windowOpen(cs, posSig, stsSig) {
  const p = cs.rawOf(posSig);
  if (p !== undefined) return p === 255 ? undefined : Math.max(0, Math.min(100, Math.round(p * 0.5)));
  const s = cs.rawOf(stsSig);
  return s === undefined ? undefined : s ? 100 : 0;
}

/** A door window's control on the car: a drag control pinned to the glass (carcontrols.js winCtl) that rides
 *  on its door; sig is the head unit's control signal (5 Auto_Up, 6 Auto_Down), and the position comes from the car. */
function windowCtl(id, label, anchor, door, sig, posSig, stsSig) {
  return { anchor, kind: 'winctl', id, label, door, winSig: sig, def: 0, live: (cs) => windowOpen(cs, posSig, stsSig) };
}

function seatControls(seat, driver) {
  const heatSig = driver ? 'DSMC_DrvrSeatHeatgSts' : 'PSM_PassSeatHeatgSts', heatReq = driver ? 'ICC_DrvrSeatHeatgReq' : 'ICC_PassSeatHeatgReq';
  return [
    { id: `seat.${seat}.heat`, type: 'levels', label: 'Heat', kind: 'heat', max: 3, def: driver ? 2 : 0, live: map(heatSig, HEAT_FROM_CAR), tx: pulse(MSG.SEATHEAT, heatReq, HEAT_TO_CAR) },
    { id: `seat.${seat}.pos`, type: 'seatpos', label: 'Position', def: { ...SEAT_MEMORY[1] }, driver,
      live: driver ? seatFromCar : undefined,
      // the head unit's manual-move requests, held: ICC_0x533 every 100 ms while a button is down, then "Off"
      moves: driver
        ? { slide: 'ICC_DrvrSeatTrackManReq', recline: 'ICC_DrvrSeatBackManReq', front: 'ICC_DrvrSeatTiltManReq', rear: 'ICC_DrvrHeiManReq' }
        : { slide: 'ICC_PassSeatTrackManReq', recline: 'ICC_PassSeatBackManReq' } },
    ...(driver ? [
      { id: 'seat.memory', type: 'memory', label: 'Memory', def: 1, tx: pulse(MSG.SEATHEAT, 'ICC_DrvrID', v => v + 1), noSave: 'Saving a position is a head unit key: hold its memory button' },   // ICC_DrvrID Mem_1 = 2
      T('seat.easy', 'Easy entry', true, 'Slides the seat back for getting in and out; the car doesn\'t report whether it\'s on', { tx: pulse(MSG.SEATHEAT, 'ICC_SeatWelFctEnaReq', { true: 2, false: 1 }) }),
    ] : []),
  ];
}

// ---- live read-out from the car (carstate.js over the Android app's CAN link) --------------------------
// Each category's live(cs) returns [label, value] rows for the signals arriving right now; a missing
// signal is skipped, so an empty array means nothing is live for it. Read-only: this only displays.
const onoff = (v) => v === undefined ? undefined : v ? 'On' : 'Off';
const row = (label, v) => v === undefined || v === '' || v === null ? null : [label, String(v)];
const rows = (...r) => r.filter(Boolean);
const pct = (v) => v === undefined ? undefined : `${v}%`;
const num = (v, nd, unit) => v === undefined ? undefined : `${v.toFixed(nd)} ${unit}`;
const minutes = (m) => m === undefined || m >= 0xFFFF ? undefined : m >= 60 ? `${Math.floor(m / 60)} h ${m % 60} min` : `${m} min`;
export const LIVE = {
  lighting: (cs) => rows(
    row('Headlights', cs.label('BCM_ExtLampSwtSts')),
    row('Low beam', cs.label('BCM_LoBeamOutpCmd')),
    row('High beam', cs.label('BCM_HiBeamOutpCmd')),
    row('Position lamps', cs.label('BCM_PosnLampOutpCmd')),
    row('Daytime running', onoff(cs.rawOf('BCM_LeDRLOutpCmd'))),
    row('Front fog', cs.label('BCM_FrntFogLampSwtSts')),
    row('Adaptive beam', cs.label('BCM_EnaSts_ADB')),
    row('Follow me home', cs.label('BCM_FolwMeSetStsFb')),
    row('Ambient light (sensor)', cs.rawOf('BCM_VehAmbBri') === undefined ? undefined : (cs.rawOf('BCM_VehAmbBri') >= 0xFE ? '—' : `${cs.rawOf('BCM_VehAmbBri') * 100} lx`)),
  ),
  climate: (cs) => rows(
    row('A/C', cs.label('ECC_ACSts')),
    row('Auto', cs.label('ECC_AUTOSts')),
    row('Fan', cs.rawOf('ECC_WindSpdSts')),
    row('Driver set', cs.value('ECC_DrvrTSetSts') ? cs.value('ECC_DrvrTSetSts').toFixed(1) + ' °C' : undefined),
    row('Passenger set', cs.value('ECC_PassTSetSts') ? cs.value('ECC_PassTSetSts').toFixed(1) + ' °C' : undefined),
    row('Sync', cs.label('ECC_SYNCSts')),
    row('Airflow', cs.label('ECC_DrvrAirOutlMod')),
    row('Air intake', cs.rawOf('ECC_CircSts') === undefined ? undefined : cs.rawOf('ECC_CircSts') ? 'Fresh' : 'Recirculate'),
    row('Rear vents', cs.label('ECC_BackRowAirOutlModSts')),
    row('Max defrost', cs.label('ECC_MaxFrntDefrst')),
    row('Rear defrost', cs.label('BCM_ReDefrstHeatgCmd')),
    row('Outside', cs.rawOf('ECC_OutdT') === undefined || cs.rawOf('ECC_OutdT') === 0xFF ? undefined : cs.value('ECC_OutdT').toFixed(1) + ' °C'),
  ),
  seats: (cs) => rows(
    row('Driver heat', cs.label('DSMC_DrvrSeatHeatgSts')),
    row('Passenger heat', cs.label('PSM_PassSeatHeatgSts')),
    row('Rear left heat', cs.label('DSMC_RearLeSeatHeatgSts')),
    row('Rear right heat', cs.label('DSMC_RearRiSeatHeatgSts')),
    row('Driver slide', pct(cs.rawOf('DSMC_DrvrSeatTrackPosn'))),
    row('Driver height', pct(cs.rawOf('DSMC_DrvrSeatHeiPosn'))),
    row('Driver backrest', pct(cs.rawOf('DSMC_DrvrSeatBackPosn'))),
  ),
  driving: (cs) => rows(
    row('Gear', (cs.label('VCU_GearSig') || '').replace('gear_', '').replace('_gear', '') || undefined),
    row('Ready', cs.label('VCU_RdyLamp')),
    row('Vehicle', cs.label('VCU_VehSt')),
    row('Drive mode', cs.label('VCU_DrvModSigFb')),
    row('Regen', cs.label('VCU_RegenLvlFb')),
    row('Pedal', cs.label('VCU_EPedlStsFb')),
    row('Acceleration', cs.label('VCU_AccelModFb')),
    row('Speed', num(cs.value('ESP_VehSpd'), 1, 'km/h')),
  ),
  energy: (cs) => rows(
    row('Battery', pct(cs.rawOf('BMS_Bat_SoC_usable'))),
    row('Battery power', cs.value('VCU_HVBattActPwr') === undefined ? undefined : `${cs.value('VCU_HVBattActPwr') > 0 ? '+' : ''}${cs.value('VCU_HVBattActPwr').toFixed(1)} kW`),
    row('Pack', cs.value('BMS_Bat_Hvmeasure_V_Pack') === undefined ? undefined : `${cs.value('BMS_Bat_Hvmeasure_V_Pack').toFixed(0)} V · ${cs.value('BMS_Bat_HVmeasure_Current').toFixed(1)} A`),
    row('Charge port door', cs.label('VCU_ACChrgShttrSts')),
    row('AC plug', cs.label('VCU_ACChrgDchaGunCnctnSts')),
    row('DC plug', cs.label('VCU_DCChrgDchaGunCnctnSts')),
    row('Charge light', cs.label('VCU_ACChrgDchaIndcrLampSts')),
    row('AC time left', minutes(cs.rawOf('VCU_ACRmngChrgTi'))),
    row('DC time left', minutes(cs.rawOf('VCU_DCChrgRmngTi'))),
    row('Charge current limit', cs.rawOf('VCU_ACChrgCrtUpprLmt') === undefined ? undefined : `${cs.rawOf('VCU_ACChrgCrtUpprLmt')} A`),
    row('Charge power limit', pct(cs.rawOf('VCU_ChrgPwrLim'))),
    row('Available energy', num(cs.value('VCU_PwrBattAvlEgy'), 1, 'kWh')),
    row('Pack capacity', num(cs.value('BMS_Bat_Actual_Pack_Capacity'), 1, 'kWh')),
    row('Health', pct(cs.rawOf('BMS_Bat_SOH'))),
  ),
  doors: (cs) => {
    const win = (pos, sts) => {
      const o = windowOpen(cs, pos, sts);
      return o === undefined ? undefined : o === 0 ? 'Closed' : `${o}% open`;
    };
    return rows(
      row('Central lock', cs.rawOf('BCM_FrntDrDoorLockSts') === undefined ? undefined : cs.rawOf('BCM_FrntDrDoorLockSts') === 0 ? 'Locked' : 'Unlocked'),
      row('Driver door', cs.label('BCM_DrFrntDoorSts')),
      row('Passenger door', cs.label('BCM_PasFrntDoorSts')),
      row('Rear left door', cs.label('BCM_LeReDoorSts')),
      row('Rear right door', cs.label('BCM_RiReDoorSts')),
      row('Liftgate', cs.rawOf('PLGM_LeTrPosn') === undefined ? cs.label('PLGM_TrSts') : `${cs.label('PLGM_TrSwtStsIndcn') || ''} ${cs.rawOf('PLGM_LeTrPosn')}%`.trim()),
      row('Frunk', cs.label('BCM_FrntHoodLidSts')),
      row('Front left window', win('BCM_AP_FL_LeFrntWinPosnInfo', 'BCM_LeFrntWinSts')),
      row('Front right window', win('BCM_AP_FL_RiFrntWinPosnInfo', 'BCM_RiFrntWinSts')),
      row('Rear left window', win('BCM_AP_FL_LeReWinPosnInfo', 'BCM_LeReWinSts')),
      row('Rear right window', win('BCM_AP_FL_RiReWinPosnInfo', 'BCM_RiReWinSt')),
      row('Left quarter window', win('BCM_AP_TL_LeReWinPosnInfo', 'BCM_AP_TL_LeReWinSts')),
      row('Right quarter window', win('BCM_AP_TL_RiReWinPosnInfo', 'BCM_AP_TL_RiReWinSts')),
      row('Rear window', win('BCM_AP_RW_WinPosnInfo', 'BCM_AP_RW_WinSts')),
      row('Sunroof', cs.rawOf('BCM_SunroofPosnInfo') === undefined || cs.rawOf('BCM_SunroofPosnInfo') === 0x7F ? cs.label('BCM_SunroofSts') : `${cs.rawOf('BCM_SunroofPosnInfo')}% ${cs.rawOf('BCM_SunroofOpenAr') === 1 ? 'tilted' : 'open'} · ${cs.label('BCM_SunroofRunngSts') || ''}`),
      row('Mirrors', cs.label('BCM_MirrCmd')),
    );
  },
  display: (cs) => rows(
    row('Brightness level', cs.label('BCM_BackgndBriLvl_Cfm')),
  ),
};

export function defaults() {
  const out = {};
  const add = (c) => {
    if (c.id && c.def !== undefined) out[c.id] = Array.isArray(c.def) ? [...c.def] : typeof c.def === 'object' ? { ...c.def } : c.def;
  };
  for (const cat of CATEGORIES) {
    for (const card of cat.cards || []) card.controls.forEach(add);
    for (const sec of cat.sections || []) (sec.controls || []).forEach(add);
    (cat.chips || []).forEach(add);
  }
  Object.assign(out, {
    'climate.tempL': 21.5, 'climate.tempR': 21.5, 'climate.sync': true,
    'seat.RL.heat': 0, 'seat.RR.heat': 0, 'energy.soc': 72, 'energy.power': 0,
    'display.hollywood': false, 'doors.open': [],
  });
  return out;
}

/** Every control and chip with a live reader: [id, live]. */
export function liveControls() {
  const out = [];
  const add = (c) => { if (c && c.id && c.live) out.push([c.id, c.live]); };
  for (const cat of CATEGORIES) {
    for (const card of cat.cards || []) card.controls.forEach(add);
    for (const sec of cat.sections || []) (sec.controls || []).forEach(add);
    (cat.chips || []).forEach(add);
  }
  return out;
}

/** The temperatures and the car's state that no control owns, read for the model and the hero. */
export function liveExtras(cs) {
  const out = {};
  const dr = cs.value('ECC_DrvrTSetSts'), ps = cs.value('ECC_PassTSetSts');
  if (dr) out['climate.tempL'] = dr;
  if (ps) out['climate.tempR'] = ps;
  const sync = cs.rawOf('ECC_SYNCSts');
  if (sync !== undefined) out['climate.sync'] = sync === 1;
  const soc = cs.rawOf('BMS_Bat_SoC_usable');
  if (soc !== undefined) out['energy.soc'] = soc;
  const p = cs.value('VCU_HVBattActPwr');
  if (p !== undefined) out['energy.power'] = p;
  const doors = [];
  for (const [sig, name] of [['BCM_DrFrntDoorSts', 'Door_Front_L'], ['BCM_PasFrntDoorSts', 'Door_Front_R'], ['BCM_LeReDoorSts', 'Door_Rear_L'], ['BCM_RiReDoorSts', 'Door_Rear_R'], ['PLGM_TrSts', 'Tailgate']]) {
    if (cs.rawOf(sig) === 1) doors.push(name);
  }
  if (cs.rawOf('BCM_DrFrntDoorSts') !== undefined) out['doors.open'] = doors;
  return out;
}
