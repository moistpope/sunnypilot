// Car controls mockup, the 3D side: the roof made see-through, the parts of the car highlighted for each
// category, and the parts drawn over it (work in progress: the hooks scene.js calls, doing nothing yet).
export class Cutaway {
  constructor(scene) {
    this.scene = scene;
    this.ego = null;
  }

  // the glTF ego car has loaded
  attach(ego) { this.ego = ego; }

  setTheme(dark) { this.dark = dark; }

  update(dt, clock) { this.clock = clock; }

  // the zone a ray (scene.pickZone) hits, or null
  pick(ray) { return ray && null; }
}
