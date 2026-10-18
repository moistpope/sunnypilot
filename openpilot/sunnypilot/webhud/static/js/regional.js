// Input conventions are independent of the chosen speedometer display units.
export function leftTraffic(settings = {}, fisker) {
  if (settings.trafficSide === 'left') return true;
  if (settings.trafficSide === 'right') return false;
  return fisker?.road?.trafficSide === 'Left_Hand_Traffic';
}

export function cameraSignUnit(settings = {}, tsr = {}) {
  return ['mph', 'kmh'].includes(settings.cameraSignUnits) ? settings.cameraSignUnits : tsr.unit;
}

export function cameraSignValue(settings, tsr, displayUnit) {
  const source = cameraSignUnit(settings, tsr);
  return source && source !== displayUnit
    ? Math.round(tsr.speedLimit * (displayUnit === 'kmh' ? 1.609344 : 1 / 1.609344))
    : tsr.speedLimit;
}
