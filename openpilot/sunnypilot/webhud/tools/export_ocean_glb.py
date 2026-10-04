#!/usr/bin/env python3
"""
Build the web HUD's Ocean model with its roof, sunroof, seats, windows, vents, screens and console as meshes of their own.

  blender -b Pulse-Ocean-Master.blend --python openpilot/sunnypilot/webhud/tools/export_ocean_glb.py -- \\
    --glb Pulse-Ocean-ADAS.glb --out openpilot/third_party/webhud/models/pulse_ocean_v0.10_parts.glb

Both inputs come from the Pulse Ocean v0.10 package. Its app asset, Pulse-Ocean-ADAS.glb, merges the
master's parts into one mesh per material and rig node: Body__PBR_glass_dark is the SolarSky glass, the
windshield and the rear quarter windows together. The car controls mockup (static/js/cutaway.js) fades
the roof away, lights up single parts, winds the windows and the sunroof open, moves the front seats and
turns the center screen, so it needs them apart. The master .blend keeps every part as its own object, so
this finds the part each of the glb's triangles came from (the master triangle on the same rig node and
material whose centroid it shares, as modeled or as subdivided; for the parts that are several pieces,
which piece) and moves the triangles of each group below into a node of its own beside the meshes it came
from (Roof under Body, Window_Front_L under Door_Front_L), one primitive per material. A group that turns
(a seat back, the screen) has its node at its pivot. The bent caps the package added to close the seats
are left out (CAPPED). Everything else (rig, materials, textures, animations) is copied unchanged, and
unused buffer data is dropped.
Run with Blender 4.3 or later; it needs only Blender's own Python (numpy, mathutils).
"""
import argparse
import json
import os
import struct
import sys

import bpy
import numpy as np
from mathutils.kdtree import KDTree

# The roof: everything between the side rails above the doors (the rails and pillars stay). glTF axes:
# x forward, y up, z to the right; the headliner is one mesh with the pillar and rail trims, so only its
# triangles above HEADLINER_UP and within HEADLINER_HALF_W of the center line count as roof.
ROOF = {
  'glassDark_roof', 'tex_roof', 'carpaintBlack_roof', 'plastic_roof01', 'plastic_seals_roof',   # SolarSky glass, panel, frame
  'glassDark_window_f', 'black_window_f',                                                       # windshield and its frit
  'fabricA_sunvisors', 'plasticGlossy_top_panel', 'texInt_top',                                 # visors, overhead console
  'plastic_mirror_int', 'plastic_mirror_int.001', 'reflect_mirror_int',                         # rear-view mirror
}
HEADLINER = 'fabricA_top'
HEADLINER_UP, HEADLINER_HALF_W = 0.76, 0.57   # m
SIMPLE = {
  'Sunshade': {'plasticInt_roof'},   # the trim panel under the sunroof's glass
  'Seat_Rear': {'Seats_Rear_Closed', 'Rear_Seat_Base'},
  'Dash_Vents': {'plastic_dash_vent', 'plastic_dash_vents', 'plasticD_dash_vents'},
  'Center_Screen': {'plastic_display_main#screen', 'texIntD_display_main_noMS'},
  'Driver_Display': {'plastic_display_driver', 'texIntD_display_driver_noMS'},
  'Console': {'plastic_interior_center', 'interiorC_center', 'fabricA_armrest', 'leatherB_armrest'},
}
SUNROOF = {'glassDark_roof#front', 'tex_roof#front', 'plastic_seals_roof#front'}   # the roof's front panel opens
WINDOWS = {   # the glass that winds down (the rear window is the tailgate's own mesh already)
  'glassDark_windows_side': 'Window_Front_L', 'glassDark_windows_side.002': 'Window_Front_R',
  'glassDark_windows_side001': 'Window_Rear_L', 'glassDark_windows_side001.001': 'Window_Rear_R',
  'glassDark_windows_side02': 'Window_Quarter_L', 'glassDark_windows_side02.001': 'Window_Quarter_R',
}
GROUPS = ['Roof', 'Sunroof', 'Sunshade', 'Seat_FL', 'Seat_FL_Back', 'Seat_FR', 'Seat_FR_Back', 'Seat_Rear', 'Dash_Vents',
          'Center_Screen', 'Driver_Display', 'Console', *WINDOWS.values()]
# Groups that move about a point: the node sits there (glTF, the car's frame) with its vertices relative to
# it. A seat's cushion tilts and slides about its middle; its back hangs from it and reclines at the hip;
# the screen turns about its middle.
PIVOTS = {
  'Seat_FL': (0.13, -0.15, -0.398), 'Seat_FR': (0.13, -0.15, 0.398),
  'Seat_FL_Back': (-0.17, -0.13, -0.398), 'Seat_FR_Back': (-0.17, -0.13, 0.398),
  'Center_Screen': (0.549, 0.308, 0.0),
}
PARENTS = {'Seat_FL_Back': 'Seat_FL', 'Seat_FR_Back': 'Seat_FR'}
# Pulse closed the seats' open edges with one n-gon per hole (interior-closure-validation.json: 36 faces on
# the front seats, 32 on the rear). The flat ones close a side wall. The bent ones span a bolster's curve,
# and their triangles cut through the cushions and backs as dark wedges, so they are left out.
CAPPED = {'Seats_Front_Closed', 'Seats_Rear_Closed'}
CAP_BEND = 0.02   # m: a cap whose corners lie farther than this from its plane is dropped
DROP = '-'


def island_tag(part, lo, hi):
  """Which piece of a part one of its islands (connected pieces, extent lo..hi, glTF axes) is, or ''."""
  if part in ('glassDark_roof', 'tex_roof', 'plastic_seals_roof'):
    return 'front' if hi[0] > -0.9 else ''          # the front panel; the rear one is fixed
  if part == 'Seats_Front_Closed':
    return 'back' if hi[0] < 0 and hi[1] > 0.4 else ''   # backrest, headrest and their trim, behind the hip
  if part == 'plastic_display_main':
    return 'screen' if lo[1] > 0.19 else ''          # the screen's housing, not its stand
  return ''


ISLAND_PARTS = {'glassDark_roof', 'tex_roof', 'plastic_seals_roof', 'Seats_Front_Closed', 'plastic_display_main'}
RIG = ('Body', 'Door_Front_L', 'Door_Front_R', 'Door_Rear_L', 'Door_Rear_R', 'Tailgate')   # nodes whose meshes are split
MATCH_TOL = 0.003   # m: a glb triangle farther than this from every master triangle is reported


def groups_of(part, c):
  """The group of each of a master part's triangles in the glb (centroids c, glTF axes); '' stays put and
  DROP is left out. part is the master object's name, with '#piece' for the parts told apart by island_tag
  and '#cap' for the seats' bent caps."""
  g = np.full(len(c), '', dtype=object)
  name = part.split('#')[0]
  if part.endswith('#cap'):
    g[:] = DROP
  elif part in WINDOWS:
    g[:] = WINDOWS[part]
  elif part in SUNROOF:
    g[:] = 'Sunroof'
  elif name in ROOF:
    g[:] = 'Roof'
  elif part == HEADLINER:
    g[(c[:, 1] > HEADLINER_UP) & (np.abs(c[:, 2]) < HEADLINER_HALF_W)] = 'Roof'
  elif name == 'Seats_Front_Closed':
    back = '_Back' if part.endswith('#back') else ''
    g[:] = np.where(c[:, 2] < 0, 'Seat_FL' + back, 'Seat_FR' + back)   # -z is the car's left
  else:
    for name, parts in SIMPLE.items():
      if part in parts:
        g[:] = name
  return g


# ---- the master's triangles ----------------------------------------------------------------------------

def rig_node(o):
  """The RIG node a master object hangs from, or None."""
  while o is not None and o.name not in RIG:
    o = o.parent
  return o and o.name


def islands(tris, n):
  """The island (connected piece) of each triangle (rows of vertex indices) of a mesh with n vertices."""
  root = list(range(n))
  def find(a):
    while root[a] != a:
      root[a] = root[root[a]]
      a = root[a]
    return a
  for a, b, c in tris.tolist():
    ra, rb, rc = find(a), find(b), find(c)
    root[rb] = ra
    root[rc] = ra
  return np.array([find(t[0]) for t in tris.tolist()])


def triangle_centroids(o, mesh):
  """Centroids (glTF axes), material names and owner labels (the part, '#piece' for the parts made of
  several) of a mesh's triangles, placed by the object."""
  mesh.calc_loop_triangles()
  n = len(mesh.loop_triangles)
  if n == 0:
    return np.zeros((0, 3)), [], []
  vi = np.empty(n * 3, np.int32)
  mesh.loop_triangles.foreach_get('vertices', vi)
  vi = vi.reshape(-1, 3)
  mi = np.empty(n, np.int32)
  mesh.loop_triangles.foreach_get('material_index', mi)
  co = np.empty(len(mesh.vertices) * 3, np.float32)
  mesh.vertices.foreach_get('co', co)
  co = co.reshape(-1, 3).astype(np.float64)
  w = co @ np.array(o.matrix_world)[:3, :3].T + np.array(o.matrix_world)[:3, 3]
  w = np.c_[w[:, 0], w[:, 2], -w[:, 1]]   # Blender Z-up -> glTF Y-up
  c = w[vi].mean(1)
  slots = [s.material.name if s.material else '' for s in o.material_slots] or ['']
  owners = [o.name] * n
  if o.name in ISLAND_PARTS:
    isl = islands(vi, len(co))
    for k in np.unique(isl):
      sel = isl == k
      pts = w[np.unique(vi[sel])]
      tag = island_tag(o.name, pts.min(0), pts.max(0))
      for t in np.nonzero(sel)[0]:
        owners[t] = f'{o.name}#{tag}' if tag else o.name
  if o.name in CAPPED:
    poly = np.empty(n, np.int32)
    mesh.loop_triangles.foreach_get('polygon_index', poly)
    for p in mesh.polygons:
      if len(p.vertices) > 4:
        pts = w[list(p.vertices)]
        pts = pts - pts.mean(0)
        if np.abs(pts @ np.linalg.svd(pts)[2][2]).max() > CAP_BEND:
          for t in np.nonzero(poly == p.index)[0]:
            owners[t] = f'{o.name}#cap'
  return c, [slots[min(i, len(slots) - 1)] for i in mi], owners


def master_index():
  """Per (rig node, material): a KD-tree of the master's triangle centroids there, and the part of each."""
  depsgraph = bpy.context.evaluated_depsgraph_get()
  pts = {}   # (rig node, material) -> ([centroid], [part])
  for o in bpy.data.objects:
    rig = rig_node(o)
    if o.type != 'MESH' or rig is None:
      continue
    ev = o.evaluated_get(depsgraph)
    meshes = [(o, o.data)]
    if o.modifiers:   # the glb has some parts subdivided and some as modeled: index both
      meshes.append((o, ev.to_mesh()))
    for obj, mesh in meshes:
      c, mats, owners = triangle_centroids(obj, mesh)
      for p, m, owner in zip(c, mats, owners, strict=True):
        a = pts.setdefault((rig, m), ([], []))
        a[0].append(p)
        a[1].append(owner)
    if o.modifiers:
      ev.to_mesh_clear()
  index = {}
  for m, (cs, parts) in pts.items():
    tree = KDTree(len(cs))
    for i, p in enumerate(cs):
      tree.insert(p, i)
    tree.balance()
    index[m] = (tree, parts)
  return index


# ---- glb -----------------------------------------------------------------------------------------------

COMPONENT = {5120: np.int8, 5121: np.uint8, 5122: np.int16, 5123: np.uint16, 5125: np.uint32, 5126: np.float32}
WIDTH = {'SCALAR': 1, 'VEC2': 2, 'VEC3': 3, 'VEC4': 4, 'MAT4': 16}


class Glb:
  def __init__(self, path):
    data = open(path, 'rb').read()
    magic, _, length = struct.unpack_from('<4sII', data, 0)
    assert magic == b'glTF', path
    off, chunks = 12, {}
    while off < length:
      size, kind = struct.unpack_from('<I4s', data, off)
      chunks[kind] = data[off + 8:off + 8 + size]
      off += 8 + size
    self.j = json.loads(chunks[b'JSON'])
    self.bin = chunks[b'BIN\x00']
    self.added = {}   # bufferView index -> bytes of views added here

  def array(self, i):
    a = self.j['accessors'][i]
    assert 'sparse' not in a, 'sparse accessors are not handled'
    v = self.j['bufferViews'][a['bufferView']]
    dt, n = np.dtype(COMPONENT[a['componentType']]), WIDTH[a['type']]
    assert v.get('byteStride', dt.itemsize * n) == dt.itemsize * n, 'interleaved buffers are not handled'
    src = self.added.get(a['bufferView'], self.bin)
    start = (0 if a['bufferView'] in self.added else v.get('byteOffset', 0)) + a.get('byteOffset', 0)
    return np.frombuffer(src, dt, a['count'] * n, start).reshape(a['count'], n)

  def add_accessor(self, arr, like, target):
    """A new accessor holding arr, typed like accessor `like` (or {componentType, type})."""
    view = len(self.j['bufferViews'])
    self.added[view] = np.ascontiguousarray(arr).tobytes()
    self.j['bufferViews'].append({'buffer': 0, 'byteLength': len(self.added[view]), 'target': target})
    a = {k: like[k] for k in ('componentType', 'type', 'normalized') if k in like}
    a.update(bufferView=view, count=len(arr))
    if like.get('min') is not None:
      a['min'], a['max'] = arr.min(0).tolist(), arr.max(0).tolist()
    self.j['accessors'].append(a)
    return len(self.j['accessors']) - 1

  def subset(self, prim, tris, shift=None):
    """A copy of primitive `prim` with only triangles `tris` (rows of vertex indices) and their vertices,
    moved by `shift`."""
    used, remap = np.unique(tris, return_inverse=True)
    out = {k: v for k, v in prim.items() if k not in ('attributes', 'indices', 'targets')}
    out['attributes'] = {}
    for name, acc in prim['attributes'].items():
      data = self.array(acc)[used]
      if name == 'POSITION' and shift is not None:
        data = (data + np.asarray(shift, np.float32)).astype(np.float32)
      out['attributes'][name] = self.add_accessor(data, self.j['accessors'][acc], 34962)
    idx = remap.reshape(-1).astype(np.uint16 if len(used) < 65536 else np.uint32)
    out['indices'] = self.add_accessor(idx, {'componentType': 5123 if idx.dtype == np.uint16 else 5125, 'type': 'SCALAR'}, 34963)
    return out

  def save(self, path):
    """Drop what nothing uses any more (nodes outside the scenes, meshes, accessors, buffer views), pack
    the binary and write the glb."""
    j = self.j
    # nodes reachable from the scenes
    keep_nodes, stack = set(), [n for s in j['scenes'] for n in s['nodes']]
    while stack:
      n = stack.pop()
      if n not in keep_nodes:
        keep_nodes.add(n)
        stack += j['nodes'][n].get('children', [])
    node_map = {o: i for i, o in enumerate(sorted(keep_nodes))}
    j['nodes'] = [j['nodes'][o] for o in sorted(keep_nodes)]
    for nd in j['nodes']:
      if 'children' in nd:
        nd['children'] = [node_map[c] for c in nd['children']]
    for s in j['scenes']:
      s['nodes'] = [node_map[n] for n in s['nodes']]
    for an in j.get('animations', []):
      for ch in an['channels']:
        ch['target']['node'] = node_map[ch['target']['node']]
    for sk in j.get('skins', []):
      sk['joints'] = [node_map[n] for n in sk['joints']]
      if 'skeleton' in sk:
        sk['skeleton'] = node_map[sk['skeleton']]
    # meshes the kept nodes use
    used_meshes = sorted({nd['mesh'] for nd in j['nodes'] if 'mesh' in nd})
    mesh_map = {o: i for i, o in enumerate(used_meshes)}
    j['meshes'] = [j['meshes'][o] for o in used_meshes]
    for nd in j['nodes']:
      if 'mesh' in nd:
        nd['mesh'] = mesh_map[nd['mesh']]
    # accessors: primitives, animation samplers, skins
    refs = []
    for me in j['meshes']:
      for p in me['primitives']:
        refs += [(p['attributes'], k) for k in p['attributes']]
        if 'indices' in p:
          refs.append((p, 'indices'))
        for t in p.get('targets', []):
          refs += [(t, k) for k in t]
    for an in j.get('animations', []):
      for s in an['samplers']:
        refs += [(s, 'input'), (s, 'output')]
    for sk in j.get('skins', []):
      if 'inverseBindMatrices' in sk:
        refs.append((sk, 'inverseBindMatrices'))
    used_acc = sorted({d[k] for d, k in refs})
    acc_map = {o: i for i, o in enumerate(used_acc)}
    for d, k in refs:
      d[k] = acc_map[d[k]]
    j['accessors'] = [j['accessors'][o] for o in used_acc]
    # buffer views: accessors and images
    view_refs = [(a, 'bufferView') for a in j['accessors'] if 'bufferView' in a]
    view_refs += [(im, 'bufferView') for im in j.get('images', []) if 'bufferView' in im]
    used_views = sorted({d[k] for d, k in view_refs})
    view_map = {o: i for i, o in enumerate(used_views)}
    for d, k in view_refs:
      d[k] = view_map[d[k]]
    out, views = bytearray(), []
    for o in used_views:
      v = dict(j['bufferViews'][o])
      data = self.added[o] if o in self.added else self.bin[v.get('byteOffset', 0):v.get('byteOffset', 0) + v['byteLength']]
      out += b'\0' * (-len(out) % 4)
      v['byteOffset'] = len(out)
      out += data
      views.append(v)
    j['bufferViews'] = views
    out += b'\0' * (-len(out) % 4)
    j['buffers'] = [{'byteLength': len(out)}]
    js = json.dumps(j, separators=(',', ':')).encode()
    js += b' ' * (-len(js) % 4)
    with open(path, 'wb') as f:
      f.write(struct.pack('<4sII', b'glTF', 2, 12 + 8 + len(js) + 8 + len(out)))
      f.write(struct.pack('<I4s', len(js), b'JSON') + js)
      f.write(struct.pack('<I4s', len(out), b'BIN\x00') + bytes(out))


# ---- split ---------------------------------------------------------------------------------------------

def split(glb, index):
  j = glb.j
  pieces = {}   # (rig node, group) -> {'prims': [primitive], 'parts': {master part}, 'translation': mesh nodes' offset}
  dropped = {}  # glb node -> triangles left out
  report = []
  for rig_i, rig in enumerate(j['nodes']):
    if rig.get('name') not in RIG:
      continue
    assert not any(k in rig for k in ('rotation', 'scale', 'matrix')), rig['name']
    for ci in list(rig.get('children', [])):
      node = j['nodes'][ci]
      if 'mesh' not in node:
        continue
      assert not any(k in node for k in ('rotation', 'scale', 'matrix')), node['name']
      local = node.get('translation', [0, 0, 0])
      offset = np.array(rig.get('translation', [0, 0, 0])) + local   # the vehicle root and Body don't move
      mesh = j['meshes'][node['mesh']]
      keep = []
      for prim in mesh['primitives']:
        material = j['materials'][prim['material']]['name']
        tree, owners = index.get((rig['name'], material), (None, None))
        if tree is None:
          keep.append(prim)
          continue
        tris = glb.array(prim['indices']).reshape(-1, 3).astype(np.int64)
        c = glb.array(prim['attributes']['POSITION']).astype(np.float64)[tris].mean(1) + offset
        found = [tree.find(p) for p in c]
        owner = np.array([owners[f[1]] for f in found], dtype=object)
        far = sum(f[2] > MATCH_TOL for f in found)
        if far:
          report.append(f"{node['name']} ({material}): {far} of {len(tris)} triangles have no master triangle within {MATCH_TOL * 1000:.0f} mm")
        group = np.full(len(tris), '', dtype=object)
        for part in set(owner):
          sel = owner == part
          group[sel] = groups_of(part, c[sel])
        if not (group != '').any():
          keep.append(prim)
          continue
        if (group == DROP).any():
          dropped[node['name']] = dropped.get(node['name'], 0) + int((group == DROP).sum())
        for g in GROUPS:
          sel = group == g
          if sel.any():
            piece = pieces.setdefault((rig_i, g), {'prims': [], 'parts': set(), 'translation': local})
            assert piece['translation'] == local, f"{g}: its parts sit at different offsets under {rig['name']}"
            shift = None
            if g in PIVOTS:   # vertices relative to the pivot (only Body's meshes, which sit at the origin, turn)
              assert not any(local), g
              shift = -np.array(PIVOTS[g])
            piece['prims'].append(glb.subset(prim, tris[sel], shift))
            piece['parts'] |= set(owner[sel])
        if (group == '').any():
          keep.append(glb.subset(prim, tris[group == '']))
      mesh['primitives'] = keep
      if not keep:   # all of it moved: drop the node
        del node['mesh']
        if not node.get('children'):
          rig['children'].remove(ci)
  made = {}   # group -> node index
  for (rig_i, g), piece in sorted(pieces.items(), key=lambda kv: GROUPS.index(kv[0][1])):
    j['meshes'].append({'name': g, 'primitives': piece['prims']})
    node = {'name': g, 'mesh': len(j['meshes']) - 1, 'extras': {'part_group': g, 'source_parts': sorted(piece['parts'])}}
    translation = PIVOTS[g] if g in PIVOTS else piece['translation']
    if g in PARENTS:   # hangs from its parent group, relative to the parent's pivot
      translation = list(np.array(translation) - np.array(PIVOTS.get(PARENTS[g], (0, 0, 0))))
    if any(translation):
      node['translation'] = [float(v) for v in translation]
    j['nodes'].append(node)
    made[g] = len(j['nodes']) - 1
    parent = j['nodes'][made[PARENTS[g]]] if g in PARENTS else j['nodes'][rig_i]
    parent.setdefault('children', []).append(made[g])
    tris = sum(j['accessors'][p['indices']]['count'] // 3 for p in piece['prims'])
    mats = [j['materials'][p['material']]['name'] for p in piece['prims']]
    print(f"{j['nodes'][rig_i]['name']}/{g}: {tris} triangles, {len(mats)} materials ({', '.join(mats)}); parts: {', '.join(sorted(piece['parts']))}")
  for name, k in dropped.items():
    print(f'{name}: {k} triangles of bent seat caps left out')
  for line in report:
    print('warning:', line)


def main():
  ap = argparse.ArgumentParser(description=__doc__.strip().splitlines()[0])
  ap.add_argument('--glb', required=True, help="the package's Pulse-Ocean-ADAS.glb")
  ap.add_argument('--out', required=True, help='the glb to write')
  args = ap.parse_args(sys.argv[sys.argv.index('--') + 1:] if '--' in sys.argv else [])
  glb = Glb(args.glb)
  split(glb, master_index())
  glb.j['asset']['extras'] = {'webhud': f'{os.path.basename(args.glb)} with parts split out by sunnypilot/webhud/tools/export_ocean_glb.py'}
  glb.save(args.out)
  print('wrote', args.out)


if __name__ == '__main__':
  main()
