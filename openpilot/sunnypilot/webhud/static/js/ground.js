// The ground and the road on it, drawn as one field: textured ground where there's something to stand
// on, fading into the background where there isn't.
//
// With no lanes to show (road.js lane confidence under the threshold) that's a disc around the car,
// DISC_R m across its radius and fading out over its outer half. Once the lanes show, the disc grows
// out into the road: the lane region plus a shoulder, as far ahead as the lane confidence reaches,
// fading out at the far end. Disc and road are signed distance fields, the road's in its own
// coordinates (station along it and offset across it, exact for the constant-curvature arcs the lines
// are drawn as), joined with a smooth minimum so the two flow into each other. road.js eases the road's
// shape on springs, so every change -- lanes found or lost, a lane added, the road bending -- morphs,
// and the edge is roughened with noise fixed to the ground that ripples and flows while the shape is
// changing and holds still when it isn't. The lane lines, stop lines, crosswalks and headlight throw
// are masked by the same field, so they grow, bend and vanish with the road.
//
// Scene frame: X right, Y up, Z backward; the car frame (x ahead of the front bumper, y left) is
// x = -Z, y = -X.
import * as THREE from '../vendor/three.module.min.js';

const EGO_LEN = 4.775;
const DISC_R = 10, DISC_FADE = 5.5;    // m: the ground around the car with no road: radius, fade width
const ROAD_DISC_R = 3.5;               // m: what's left of the disc (under the road) once it shows
const SHOULDER = 0.6;                  // m of full ground beyond the outer lane lines...
const SIDE_FADE = 2.2;                 // ...then fading out over this
const BACK = -38, BACK_FADE = 10;      // m: the road's end behind the car, fade
const RIPPLE = 0.18, RIPPLE_MORPH = 0.55;   // edge noise (in fade widths) at rest, and added while reshaping

const smoothstep = (a, b, x) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };
const mix = (a, b, t) => a + (b - a) * t;

// Tileable value-noise fBm (period = the texture), as a grey canvas texture.
function noiseTexture(size, cells, octaves, gain, seed, anisotropy) {
  const hash = (x, y, o) => {
    let h = (x * 374761393 + y * 668265263 + o * 2147483647 + seed * 144269) | 0;
    h = Math.imul(h ^ (h >>> 13), 1274126177);
    return ((h ^ (h >>> 16)) >>> 0) / 4294967295;
  };
  const val = new Float32Array(size * size);
  let amp = 1, total = 0;
  for (let o = 0; o < octaves; o++) {
    const n = cells << o;
    for (let py = 0; py < size; py++) {
      const fy = py / size * n, iy = Math.floor(fy), ty = fy - iy, sy = ty * ty * (3 - 2 * ty);
      for (let px = 0; px < size; px++) {
        const fx = px / size * n, ix = Math.floor(fx), tx = fx - ix, sx = tx * tx * (3 - 2 * tx);
        const x0 = ix % n, x1 = (ix + 1) % n, y0 = iy % n, y1 = (iy + 1) % n;
        const a = hash(x0, y0, o), b = hash(x1, y0, o), c = hash(x0, y1, o), d = hash(x1, y1, o);
        val[py * size + px] += amp * (a + (b - a) * sx + (c - a) * sy + (a - b - c + d) * sx * sy);
      }
    }
    total += amp;
    amp *= gain;
  }
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const ctx = c.getContext('2d');
  const img = ctx.createImageData(size, size);
  let lo = Infinity, hi = -Infinity;
  for (const v of val) { lo = Math.min(lo, v); hi = Math.max(hi, v); }
  for (let i = 0; i < val.length; i++) {
    const g = Math.round(255 * (val[i] - lo) / (hi - lo || 1));
    img.data.set([g, g, g, 255], i * 4);
  }
  ctx.putImageData(img, 0, 0);
  const tex = new THREE.CanvasTexture(c);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.anisotropy = anisotropy;
  return tex;
}

// The field, in GLSL. p: car frame point; g: ground coordinates (m, fixed to the ground) for the noise.
const FIELD_GLSL = `
uniform vec3 uArc;       // the road's reference arc in the car frame: y at the bumper, tan(heading), curvature
uniform vec4 uLat;       // lane region from the arc (right, left: outer lines, m), shoulder, side fade
uniform vec4 uLong;      // the road's ends (back, front: where it has faded out, m along it), their fades
uniform vec4 uDisc;      // the disc: center (car frame), radius (faded out), fade width
uniform vec4 uField;     // reveal 0..1, edge ripple (in fade widths), ripple phase, lane tint
uniform sampler2D tField;

// (station along the arc, offset to its left): the arc through (0, y0) heading atan(t) with curvature k
vec2 roadSD(vec2 p) {
  float h0 = atan(uArc.y);
  vec2 u = vec2(cos(h0), sin(h0));
  vec2 q = p - vec2(0.0, uArc.x);
  float a = dot(q, u), b = q.y * u.x - q.x * u.y, k = uArc.z;
  float A = 2.0 * b - k * (a * a + b * b);
  float d = A / (1.0 + sqrt(max(0.0, 1.0 - k * A)));
  float s = abs(k) < 1e-5 ? a : atan(k * a, 1.0 - k * b) / k;
  return vec2(s, d);
}

float fieldNoise(vec2 g) {
  float ph = uField.z;
  float a = texture2D(tField, g / 12.0 + vec2(0.21, 0.13) * ph).r;
  float b = texture2D(tField, g / 4.8 - vec2(0.16, 0.27) * ph).r;
  return (a * 0.65 + b * 0.35 - 0.5) * 2.0 * uField.y;
}

// distances in fade widths: <= -1 solid, 0 faded out
float lateralOut(vec2 sd) { return max(uLat.x - sd.y, sd.y - uLat.y); }   // m outside the lane region
float roadDist(vec2 sd) {
  vec2 v = vec2((lateralOut(sd) - uLat.z) / uLat.w - 1.0, max((sd.x - uLong.y) / uLong.w, (uLong.x - sd.x) / uLong.z));
  return length(max(v, 0.0)) + min(max(v.x, v.y), 0.0) + (1.0 - smoothstep(0.0, 0.12, uField.x)) * 4.0;
}
float discDist(vec2 p) { return (length(p - uDisc.xy) - uDisc.z) / uDisc.w; }
float smin(float a, float b, float k) { float h = max(k - abs(a - b), 0.0) / k; return min(a, b) - h * h * k * 0.25; }

float roadAlpha(vec2 p, vec2 g) { return smoothstep(0.0, 1.0, -(roadDist(roadSD(p)) + fieldNoise(g))); }
float groundAlpha(vec2 p, vec2 g) { return smoothstep(0.0, 1.0, -(smin(discDist(p), roadDist(roadSD(p)), 0.8) + fieldNoise(g))); }
`;

export class RoadField {
  constructor(anisotropy) {
    this.cloud = noiseTexture(256, 4, 5, 0.55, 3, anisotropy);
    this.uniforms = {
      uArc: { value: new THREE.Vector3() },
      uLat: { value: new THREE.Vector4(-1.8, 1.8, SHOULDER, SIDE_FADE) },
      uLong: { value: new THREE.Vector4(-4, 4, BACK_FADE, 10) },
      uDisc: { value: new THREE.Vector4(-EGO_LEN / 2, 0, DISC_R, DISC_FADE) },
      uField: { value: new THREE.Vector4(0, RIPPLE, 0, 0) },
      uGroundInv: { value: new THREE.Matrix4() },
      tField: { value: this.cloud },
    };
  }

  // The road surface: a fine, soft "cloud" rather than slabs. Fine grain (2 m tile) over two soft cloud
  // layers (12 m and 48 m), mixed in the shader from the plane's own coordinates, so it reads as a fine
  // surface near the car and never shows a repeating pattern. Nothing in it has a direction: the plane
  // turns with the integrated heading while lane lines stay car-relative. The lanes are tinted toward
  // the road color, and everything outside the field fades into the background.
  groundMaterial(anisotropy) {
    const uniforms = Object.assign({
      tGrain: { value: noiseTexture(256, 24, 4, 0.6, 7, anisotropy) },
      uContrast: { value: 0.1 },
      uBg: { value: new THREE.Color(0xffffff) },
      uRoad: { value: new THREE.Color(0x000000) },
    }, this.uniforms);
    const m = new THREE.MeshBasicMaterial({ color: 0xffffff });
    m.onBeforeCompile = (sh) => {
      Object.assign(sh.uniforms, uniforms);
      sh.vertexShader = 'varying vec2 vGround;\nvarying vec2 vCar;\n' + sh.vertexShader.replace('#include <begin_vertex>',
        '#include <begin_vertex>\nvGround = position.xz;\nvec4 scenePos = modelMatrix * vec4(transformed, 1.0);\nvCar = vec2(-scenePos.z, -scenePos.x);');
      sh.fragmentShader = 'varying vec2 vGround;\nvarying vec2 vCar;\nuniform sampler2D tGrain;\nuniform float uContrast;\nuniform vec3 uBg;\nuniform vec3 uRoad;\n' +
        FIELD_GLSL + sh.fragmentShader.replace('#include <map_fragment>', `
        float grain = texture2D(tGrain, vGround / 2.0).r;
        float mid = texture2D(tField, vGround / 12.0 + vec2(0.37, 0.61)).r;
        float cloud = texture2D(tField, vGround / 48.0).r;
        float n = (cloud - 0.5) * 0.6 + (mid - 0.5) * 0.45 + (grain - 0.5) * 0.8;
        diffuseColor.rgb *= 1.0 + n * uContrast;
        // the lanes a shade toward the road color; outside the field, the background
        vec2 sd = roadSD(vCar);
        float edge = fieldNoise(vGround);
        float lanes = (1.0 - smoothstep(-0.2, 0.2, lateralOut(sd))) * smoothstep(0.0, 1.0, -(roadDist(sd) + edge));
        diffuseColor.rgb = mix(diffuseColor.rgb, uRoad, lanes * uField.w);
        diffuseColor.rgb = mix(uBg, diffuseColor.rgb, smoothstep(0.0, 1.0, -(smin(discDist(vCar), roadDist(sd), 0.8) + edge)));`);
    };
    m.userData.uniforms = uniforms;
    return m;
  }

  // Fade a material out with the field: 'road' for lane lines (the road alone: no road, no lines), or
  // 'ground' for what lies on the ground anywhere (stop lines, the headlight throw).
  mask(material, mode) {
    material.transparent = true;
    material.onBeforeCompile = (sh) => {
      Object.assign(sh.uniforms, this.uniforms);
      sh.vertexShader = 'varying vec3 vFieldPos;\n' + sh.vertexShader.replace('#include <begin_vertex>',
        '#include <begin_vertex>\nvFieldPos = (modelMatrix * vec4(transformed, 1.0)).xyz;');
      sh.fragmentShader = 'varying vec3 vFieldPos;\nuniform mat4 uGroundInv;\n' + FIELD_GLSL +
        sh.fragmentShader.replace('#include <alphamap_fragment>', `#include <alphamap_fragment>
        diffuseColor.a *= ${mode === 'road' ? 'roadAlpha' : 'groundAlpha'}(vec2(-vFieldPos.z, -vFieldPos.x), (uGroundInv * vec4(vFieldPos, 1.0)).xz);`);
    };
    material.customProgramCacheKey = () => 'roadfield-' + mode;
    material.needsUpdate = true;
    return material;
  }

  // Shape the field from the road model's output (road.js `update`) for this frame. The road grows out
  // of the disc as it's revealed: across first, out to the lane region, then along, out to its reach.
  update(road, ground, tint) {
    const U = this.uniforms, sf = road.surface, a = road.anchor;
    const across = smoothstep(0, 0.55, sf.reveal), along = smoothstep(0.15, 1, sf.reveal);
    U.uArc.value.set(a.c.y0, a.c.t, Math.max(-0.2, Math.min(0.2, a.c.k)));
    // the car's own place across the road, which the lane region grows out from
    const car = -a.c.y0 * Math.cos(Math.atan(a.c.t));
    U.uLat.value.set(mix(car - 0.4, sf.right - a.offset, across), mix(car + 0.4, sf.left - a.offset, across), SHOULDER, SIDE_FADE);
    const reach = mix(3, sf.reach, along), fade = Math.max(8, 0.4 * reach);
    U.uLong.value.set(mix(-3, BACK, along), reach + fade, BACK_FADE, fade);
    U.uDisc.value.set(-EGO_LEN / 2, 0, mix(DISC_R, ROAD_DISC_R, across), mix(DISC_FADE, 2.5, across));
    U.uField.value.set(sf.reveal, RIPPLE + RIPPLE_MORPH * sf.energy, sf.phase, tint);
    ground.updateWorldMatrix(true, false);   // with this frame's pose of `world` above it
    U.uGroundInv.value.copy(ground.matrixWorld).invert();
  }
}
