#!/usr/bin/env python3
"""Tidy a .glb written by Blender's exporter before it goes into the room.

  python glbtool.py in.glb out.glb [--jpeg NAME,NAME] [--quality 90] [--color0-only MATERIAL]
                                   [--replace-image NAME=file.jpg ...] [--lightmap-scale K]

  --jpeg           re-encode these images (by name) as JPEG; others are left alone
  --color0-only    keep the COLOR_0 (vertex colour) attribute only on primitives of this material
  --replace-image  swap an image's bytes for a file (png or jpg), keeping its slot
  --lightmap-scale K  mark the file as carrying a baked lightmap in the occlusion slot (second UV set): the room
                   multiplies the texture by 1/K (the bake was stored at K times its real brightness, sRGB-encoded)
                   and every material that lacks the slot gets it (so the whole room reads the same map)

It rebuilds the binary chunk so nothing orphaned stays in the file, then checks the result reads back.
Needs Pillow.
"""
import argparse, io, json, struct, sys
from PIL import Image


def read_glb(path):
    d = open(path, 'rb').read()
    if d[:4] != b'glTF':
        sys.exit('not a .glb')
    jl = struct.unpack('<I', d[12:16])[0]
    j = json.loads(d[20:20 + jl])
    off = 20 + jl
    bl = struct.unpack('<I', d[off:off + 4])[0]
    assert d[off + 4:off + 8] == b'BIN\x00'
    return j, d[off + 8:off + 8 + bl]


def write_glb(path, j, binc):
    js = json.dumps(j, separators=(',', ':')).encode()
    js += b' ' * (-len(js) % 4)
    binc += b'\x00' * (-len(binc) % 4)
    total = 12 + 8 + len(js) + 8 + len(binc)
    with open(path, 'wb') as f:
        f.write(b'glTF' + struct.pack('<II', 2, total))
        f.write(struct.pack('<I', len(js)) + b'JSON' + js)
        f.write(struct.pack('<I', len(binc)) + b'BIN\x00' + binc)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('src'); ap.add_argument('dst')
    ap.add_argument('--jpeg', default='')
    ap.add_argument('--quality', type=int, default=90)
    ap.add_argument('--color0-only', default=None)
    ap.add_argument('--replace-image', action='append', default=[])
    ap.add_argument('--lightmap-scale', type=float, default=None)
    a = ap.parse_args()
    j, binc = read_glb(a.src)
    bv_old = j['bufferViews']

    # --- images
    img_bytes = {}
    names = [i.get('name') for i in j['images']]
    for idx, im in enumerate(j['images']):
        b = bv_old[im['bufferView']]
        img_bytes[idx] = (binc[b['byteOffset']:b['byteOffset'] + b['byteLength']], im['mimeType'])
    for spec in a.replace_image:
        n, p = spec.split('=', 1)
        data = open(p, 'rb').read()
        img_bytes[names.index(n)] = (data, 'image/jpeg' if data[:2] == b'\xff\xd8' else 'image/png')
    for n in [s for s in a.jpeg.split(',') if s]:
        i = names.index(n)
        data, mime = img_bytes[i]
        if mime == 'image/jpeg':
            continue
        im = Image.open(io.BytesIO(data)).convert('RGB')
        out = io.BytesIO(); im.save(out, 'JPEG', quality=a.quality, optimize=True, progressive=False, subsampling=0 if im.size[0] <= 512 else 2)
        img_bytes[i] = (out.getvalue(), 'image/jpeg')

    # --- a baked lightmap travels in the occlusion slot; make sure every material has it
    if a.lightmap_scale is not None:
        donor = next((m['occlusionTexture'] for m in j['materials'] if 'occlusionTexture' in m), None)
        if donor is None:
            sys.exit('no material has an occlusion texture to copy')
        for m in j['materials']:
            m['occlusionTexture'] = {'index': donor['index'], 'texCoord': 1}
        j.setdefault('asset', {}).setdefault('extras', {})['lightmap'] = {'version': 1, 'scale': a.lightmap_scale}

    # --- vertex colours only where wanted
    if a.color0_only is not None:
        keep_mat = [i for i, m in enumerate(j['materials']) if m['name'] == a.color0_only]
        for mesh in j['meshes']:
            for p in mesh['primitives']:
                if 'COLOR_0' in p['attributes'] and p.get('material') not in keep_mat:
                    del p['attributes']['COLOR_0']

    # --- rebuild accessors / bufferViews / binary without orphans
    used_acc = []
    for mesh in j['meshes']:
        for p in mesh['primitives']:
            for k in list(p['attributes']):
                if p['attributes'][k] not in used_acc: used_acc.append(p['attributes'][k])
            if 'indices' in p and p['indices'] not in used_acc: used_acc.append(p['indices'])
    amap = {o: n for n, o in enumerate(used_acc)}
    new_acc, new_bv, newbin = [], [], bytearray()
    bvmap = {}

    def add_view(data, target=None, stride=None):
        newbin.extend(b'\x00' * (-len(newbin) % 4))
        v = {'buffer': 0, 'byteOffset': len(newbin), 'byteLength': len(data)}
        if target: v['target'] = target
        if stride: v['byteStride'] = stride
        newbin.extend(data)
        new_bv.append(v)
        return len(new_bv) - 1

    for o in used_acc:
        ac = dict(j['accessors'][o])
        b = bv_old[ac['bufferView']]
        if ac['bufferView'] not in bvmap:
            bvmap[ac['bufferView']] = add_view(binc[b['byteOffset']:b['byteOffset'] + b['byteLength']], b.get('target'), b.get('byteStride'))
        ac['bufferView'] = bvmap[ac['bufferView']]
        new_acc.append(ac)
    for mesh in j['meshes']:
        for p in mesh['primitives']:
            p['attributes'] = {k: amap[v] for k, v in p['attributes'].items()}
            if 'indices' in p: p['indices'] = amap[p['indices']]
    for idx, im in enumerate(j['images']):
        data, mime = img_bytes[idx]
        im['bufferView'] = add_view(data)
        im['mimeType'] = mime
    j['accessors'] = new_acc
    j['bufferViews'] = new_bv
    j['buffers'] = [{'byteLength': len(newbin)}]
    write_glb(a.dst, j, bytes(newbin))

    # --- read it back
    j2, b2 = read_glb(a.dst)
    for ac in j2['accessors']:
        v = j2['bufferViews'][ac['bufferView']]
        assert v['byteOffset'] + v['byteLength'] <= len(b2), 'accessor outside buffer'
    for im in j2['images']:
        v = j2['bufferViews'][im['bufferView']]
        Image.open(io.BytesIO(b2[v['byteOffset']:v['byteOffset'] + v['byteLength']])).verify()
    print(f"{a.src} -> {a.dst}: {len(open(a.src,'rb').read())} -> {len(open(a.dst,'rb').read())} bytes")


if __name__ == '__main__':
    main()
