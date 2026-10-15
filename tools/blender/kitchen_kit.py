"""
WebXR Meet environment checker + exporter  -  checks a room against the Quest 2 budget and what the viewer supports

Run from Blender's Text Editor (Run Script). A sidebar tab "Environment" appears in the 3D viewport (press N).
Headless:  blender -b room.blend -P kitchen_kit.py -- --check
It checks the scene, then exports a real temporary .glb and inspects that file, because that is what the app loads.
"""
import bpy, os, sys, json, struct, tempfile
import numpy as np

# ---------------------------------------------------------------- budgets (WARN above "target", FAIL above "limit")
BUDGET = {
    "tris":        dict(target=30000, limit=100000),   # whole room, avatars come on top (about 600 to 2400 each)
    "draw_calls":  dict(target=30,    limit=60),       # one per material per object in the exported file
    "materials":   dict(target=12,    limit=25),
    "textures":    dict(target=8,     limit=16),
    "tex_px":      dict(target=2048,  limit=4096),     # longest side of any texture
    "tex_mem_mb":  dict(target=64,    limit=128),      # GPU memory, RGBA8 plus mipmaps
    "file_mb":     dict(target=10,    limit=25),
    "size_m":      dict(target=20,    limit=60),       # longest side of the room
}
MAX_UV_SETS = 2            # UV0 = colour, UV1 = baked lightmap / AO
GUIDE_PREFIX = "GUIDE"
# The room the app is currently set up for (glTF metres: x 0..3.11, z -5.1..0). Seats, walkable area and
# collision boxes in public/world.js assume it.
LAYOUT = dict(x0=0.0, x1=3.11, z0=-5.1, z1=0.0, tol=0.15)
SKIP_EXT = {"KHR_draco_mesh_compression", "EXT_meshopt_compression", "KHR_texture_basisu"}

LAST = []     # (level, text)
STATS = {}    # headline numbers for the panel


def _tier(name, value, label, unit=""):
    b = BUDGET[name]
    txt = f"{label}: {value:g}{unit} (target {b['target']:g}, limit {b['limit']:g})"
    if value > b["limit"]:
        return ("FAIL", txt + " - over the limit")
    if value > b["target"]:
        return ("WARN", txt + " - above the target, check the frame rate on the headset")
    return ("PASS", txt)


def _pot(n):
    return n > 0 and (n & (n - 1)) == 0


def room_objects(scene, view_layer):
    out, other = [], []
    for o in scene.objects:
        if o.name.startswith(GUIDE_PREFIX) or o.hide_render or o.hide_viewport:
            continue
        try:
            if not o.visible_get(view_layer=view_layer):
                continue
        except Exception:
            pass
        (out if o.type == 'MESH' else other).append(o)
    return out, other


def upstream_images(socket, seen=None):
    """Every Image Texture node feeding a socket, through any chain of nodes."""
    seen = seen if seen is not None else set()
    found = []
    for link in socket.links:
        n = link.from_node
        if n in seen:
            continue
        seen.add(n)
        if n.type == 'TEX_IMAGE' and n.image:
            found.append(n.image)
        for i in n.inputs:
            found += upstream_images(i, seen)
    return found


def png_jpeg_size(b, mime):
    try:
        if mime == "image/png" and b[:4] == b"\x89PNG":
            return struct.unpack(">II", b[16:24])
        if mime == "image/jpeg" and b[:2] == b"\xff\xd8":
            i = 2
            while i + 9 < len(b):
                if b[i] != 0xFF:
                    i += 1
                    continue
                m = b[i + 1]
                if m == 0xFF:
                    i += 1
                    continue
                if 0xC0 <= m <= 0xCF and m not in (0xC4, 0xC8, 0xCC):
                    h, w = struct.unpack(">HH", b[i + 5:i + 9])
                    return w, h
                i += 2 + struct.unpack(">H", b[i + 2:i + 4])[0]
    except Exception:
        pass
    return None


def inspect_glb(path):
    """What the app will see: draw calls, triangles, textures, extensions, UV sets. Read straight from the file."""
    data = open(path, "rb").read()
    jl = struct.unpack("<I", data[12:16])[0]
    j = json.loads(data[20:20 + jl].decode("utf8"))
    off = 20 + jl
    binc = b""
    if off + 8 <= len(data):
        bl = struct.unpack("<I", data[off:off + 4])[0]
        binc = data[off + 8:off + 8 + bl]
    acc, views = j.get("accessors", []), j.get("bufferViews", [])
    prims = tris = 0
    uv_sets = 0
    ao_uv = set()
    for m in j.get("meshes", []):
        for p in m["primitives"]:
            prims += 1
            idx = p.get("indices")
            n = acc[idx]["count"] if idx is not None else acc[p["attributes"]["POSITION"]]["count"]
            tris += n // 3
            uv_sets = max(uv_sets, sum(1 for a in p["attributes"] if a.startswith("TEXCOORD_")))
    for mat in j.get("materials", []):
        occ = mat.get("occlusionTexture")
        if occ:
            ao_uv.add(occ.get("texCoord", 0))
    imgs = []
    for im in j.get("images", []):
        size = None
        if "bufferView" in im:
            v = views[im["bufferView"]]
            s = v.get("byteOffset", 0)
            size = png_jpeg_size(binc[s:s + min(v["byteLength"], 4096)], im.get("mimeType", ""))
        imgs.append(dict(size=size, mime=im.get("mimeType"), bytes=views[im["bufferView"]]["byteLength"] if "bufferView" in im else 0))
    return dict(bytes=len(data), prims=prims, tris=tris, uv_sets=uv_sets, ao_uv=sorted(ao_uv), images=imgs,
                materials=len(j.get("materials", [])), ext=j.get("extensionsUsed", []), ext_req=j.get("extensionsRequired", []),
                has_anim=bool(j.get("animations")), has_skin=bool(j.get("skins")),
                lights=bool(j.get("extensions", {}).get("KHR_lights_punctual")),
                bounds=None)


def _gltf_export(path, scene):
    kw = dict(filepath=path, export_format='GLB', use_visible=True, use_active_scene=True, export_apply=True, export_yup=True,
              export_cameras=False, export_animations=False, export_skins=False, export_morph=False, export_extras=False)
    for _ in range(8):
        try:
            bpy.ops.export_scene.gltf(**kw)
            return True
        except TypeError as e:
            bad = [k for k in kw if k in str(e)]
            if not bad:
                for k in ("use_visible", "use_active_scene", "export_extras", "export_morph", "export_skins", "export_animations", "export_cameras"):
                    if k in kw:
                        kw.pop(k)
                        break
            else:
                for k in bad:
                    kw.pop(k, None)
    return False


def run_checks(scene=None, do_export=True):
    global STATS
    scene = scene or bpy.context.scene
    vl = bpy.context.view_layer
    out = []
    ok = lambda t: out.append(("PASS", t))
    warn = lambda t: out.append(("WARN", t))
    fail = lambda t: out.append(("FAIL", t))
    STATS = {}

    objs, other = room_objects(scene, vl)
    if not objs:
        fail("No visible mesh objects in this scene.")
        return out
    for o in other:
        if o.type in {'CURVE', 'SURFACE', 'META', 'FONT'}:
            warn(f"'{o.name}' is a {o.type}: convert it to a mesh (Object > Convert > Mesh) so the triangle count is real.")
        elif o.type == 'LIGHT':
            warn(f"Light '{o.name}' is ignored: the app lights the room itself. Bake lighting into textures or vertex colours instead.")
        elif o.type == 'ARMATURE':
            warn(f"Armature '{o.name}' is ignored (nothing is animated in the room).")

    dg = bpy.context.evaluated_depsgraph_get()
    total_tris = 0
    per_obj = []
    mats = {}
    est_calls = 0
    uv_bad = []
    hygiene = []
    lo = np.array([1e9] * 3)
    hi = np.array([-1e9] * 3)
    outside = []
    dups = 0
    vcol_objs = 0
    for o in objs:
        if any(s < 0 for s in o.scale):
            warn(f"'{o.name}' has negative scale (mirrored): normals may be flipped. Apply scale (Ctrl+A).")
        if o.data.shape_keys:
            warn(f"'{o.name}' has shape keys, which are not exported.")
        ev = o.evaluated_get(dg)
        me = ev.to_mesh()
        try:
            me.calc_loop_triangles()
            tris = len(me.loop_triangles)
            total_tris += tris
            per_obj.append((tris, o.name))
            n = len(me.vertices)
            if n:
                co = np.empty(n * 3, np.float32)
                me.vertices.foreach_get("co", co)
                co = co.reshape(-1, 3)
                w = np.array(o.matrix_world)
                wc = co @ w[:3, :3].T + w[:3, 3]
                lo = np.minimum(lo, wc.min(axis=0))
                hi = np.maximum(hi, wc.max(axis=0))
                olo, ohi = wc.min(axis=0), wc.max(axis=0)   # glTF x, y, z = Blender x, z, -y
                tol = LAYOUT["tol"]
                if (olo[0] < LAYOUT["x0"] - tol or ohi[0] > LAYOUT["x1"] + tol or
                        -ohi[1] < LAYOUT["z0"] - tol or -olo[1] > LAYOUT["z1"] + tol):
                    outside.append(o.name)
                # duplicate vertices (coincident within 0.01 mm) waste memory and break smooth shading
                r = np.round(co * 1e5).astype(np.int64)
                dup = n - len({(a, b, c) for a, b, c in r.tolist()}) if n < 60000 else 0
                dups += dup
            used = {p.material_index for p in me.polygons}
            est_calls += max(1, len(used))
            uvn = len(me.uv_layers)
            if uvn > MAX_UV_SETS:
                fail(f"'{o.name}' has {uvn} UV maps, the viewer reads at most {MAX_UV_SETS} (UV0 colour, UV1 baked light). Delete the extras.")
            if len(me.color_attributes):
                vcol_objs += 1
            if uvn >= 2:
                uv1 = me.uv_layers[1]
                arr = np.empty(len(me.loops) * 2, np.float32)
                uv1.uv.foreach_get("vector", arr)
                arr = arr.reshape(-1, 2)
                if arr.size and (arr.min() < -0.001 or arr.max() > 1.001):
                    uv_bad.append(f"'{o.name}': UV1 (lightmap) goes outside the 0..1 square. Lightmap UVs must not tile or overlap.")
                else:
                    # overlap heuristic: total UV1 area must not exceed the square
                    area = 0.0
                    for t in me.loop_triangles:
                        a, b, c = (arr[l] for l in t.loops)
                        area += abs((b[0] - a[0]) * (c[1] - a[1]) - (c[0] - a[0]) * (b[1] - a[1])) / 2
                    STATS.setdefault("uv1_area", 0.0)
                    STATS["uv1_area"] += area
            for p in me.polygons:
                if p.area < 1e-9:
                    hygiene.append(f"'{o.name}': has zero-area faces (Mesh > Clean Up > Degenerate Dissolve).")
                    break
        finally:
            ev.to_mesh_clear()
        for s in o.material_slots:
            if s.material is None:
                warn(f"'{o.name}': empty material slot.")
            else:
                mats[s.material.name] = s.material

    size = hi - lo
    # glTF coordinates: x, z, -y
    gl_lo = (lo[0], lo[2], -hi[1])
    gl_hi = (hi[0], hi[2], -lo[1])
    STATS.update(tris=total_tris, objects=len(objs), size=tuple(float(v) for v in size))
    out.append(_tier("tris", total_tris, "Triangles"))
    top = sorted(per_obj, reverse=True)[:4]
    ok("Heaviest objects: " + ", ".join(f"{n} {t}" for t, n in top))
    out.append(_tier("size_m", float(size.max()), "Longest side of the room", " m"))
    if abs(gl_lo[1]) > 0.05:
        warn(f"Lowest point is {gl_lo[1]:.2f} m, the floor should sit at 0 m (the viewer puts people on y = 0).")
    if outside:
        warn("Geometry outside the room the app is set up for (x 0..%.2f, z %.2f..0): %s. If that is scenery outside the "
             "windows, ignore this. If you moved walls or furniture, update the seats, walkable bounds and collision "
             "boxes at the top of public/world.js." % (LAYOUT["x1"], LAYOUT["z0"], ", ".join(outside[:6])))
    else:
        ok("Everything sits inside the room the app's seats and walkable area expect")
    for t in uv_bad[:6]:
        fail(t)
    if STATS.get("uv1_area", 0) > 1.05:
        warn(f"UV1 islands add up to {STATS['uv1_area']:.2f} of the 0..1 square: they overlap. Lightmaps need unique, non-overlapping UVs.")
    for t in sorted(set(hygiene))[:6]:
        warn(t)
    if dups:
        ok(f"{dups} coincident vertices (expected where quads or UV seams are split; Merge by Distance only if you do not need those seams)")

    # ---- materials and textures, judged by what the loader keeps
    out.append(_tier("materials", len(mats), "Materials"))
    images = {}
    for mt in mats.values():
        nt = mt.node_tree
        if not nt:
            warn(f"{mt.name}: no node tree, exports as a plain colour.")
            continue
        pr = next((n for n in nt.nodes if n.type == 'BSDF_PRINCIPLED'), None)
        if pr is None:
            fail(f"{mt.name}: has no Principled BSDF, so the exporter will drop its colour.")
            continue
        base = upstream_images(pr.inputs["Base Color"])
        for im in base:
            images[im.name] = im
            if im.colorspace_settings.name != 'sRGB':
                warn(f"Texture '{im.name}' (base colour) is set to {im.colorspace_settings.name}; use sRGB.")
        if not base:
            col = pr.inputs["Base Color"].default_value
            if min(col[0], col[1], col[2]) < 0.98:
                warn(f"{mt.name}: flat colour. It works, but each flat-colour material costs a draw call. "
                     f"Paint the colour into the shared palette texture instead.")
        for sock, what in (("Normal", "normal map"), ("Roughness", "roughness"), ("Metallic", "metalness")):
            s = pr.inputs.get(sock)
            if s is not None and s.is_linked:
                for im in upstream_images(s):
                    warn(f"{mt.name}: {what} texture '{im.name}' is ignored by the viewer (cheap lit shader, base colour only). Bake it into the base colour.")
                    break
        a = pr.inputs["Alpha"]
        if a.is_linked or a.default_value < 0.999:
            warn(f"{mt.name}: transparency is ignored and renders opaque.")
        if getattr(mt, "use_backface_culling", True) is False:
            warn(f"{mt.name}: double-sided. The viewer draws single-sided only, faces seen from behind disappear. Model walls and panels as single-sided quads.")
        for n in nt.nodes:
            if n.type == 'GROUP' and n.node_tree and "glTF" in n.node_tree.name:
                occ = n.inputs.get("Occlusion")
                if occ is not None and occ.is_linked:
                    for im in upstream_images(occ):
                        images[im.name] = im
                        if im.colorspace_settings.name != 'Non-Color':
                            warn(f"Lightmap '{im.name}' should be set to Non-Color.")
        for n in nt.nodes:
            if n.type == 'TEX_IMAGE' and n.image:
                images.setdefault(n.image.name, n.image)

    mem = 0.0
    longest = 0
    for im in images.values():
        w, h = im.size
        longest = max(longest, w, h)
        mem += w * h * 4 * 1.33 / 1048576
        if not _pot(w) or not _pot(h):
            warn(f"Texture '{im.name}' is {w}x{h}: use powers of two.")
        if im.source == 'GENERATED' and not im.packed_file:
            fail(f"Texture '{im.name}' is generated and unsaved: Image > Save As or Pack, or it exports blank.")
        elif not im.packed_file and not im.filepath:
            fail(f"Texture '{im.name}' has no file.")
    out.append(_tier("textures", len(images), "Textures"))
    if images:
        out.append(_tier("tex_px", longest, "Largest texture", " px"))
        out.append(_tier("tex_mem_mb", round(mem, 1), "Texture memory on the GPU", " MB"))
        ok("Textures: " + ", ".join(f"{n} {i.size[0]}x{i.size[1]}" for n, i in list(images.items())[:8]))
    out.append(_tier("draw_calls", est_calls, "Draw calls (estimate: materials per object)"))
    if est_calls > len(mats):
        ok(f"Tip: objects that share a material can be joined to cut draw calls from {est_calls} to about {len(mats)} "
           f"(Ctrl+J on objects with the same materials, after the work is finished)")
    if vcol_objs:
        ok(f"{vcol_objs} object(s) carry vertex colours (cheap baked shading, kept by the viewer)")
    STATS.update(materials=len(mats), textures=len(images), tex_mb=round(mem, 1), calls=est_calls)

    # ---- the real file
    if do_export:
        tmp = os.path.join(tempfile.gettempdir(), "webxr_env_check.glb")
        try:
            if os.path.exists(tmp):
                os.remove(tmp)
            if not _gltf_export(tmp, scene) or not os.path.exists(tmp):
                warn("Could not run a test export (glTF exporter unavailable). The checks above still apply.")
            else:
                g = inspect_glb(tmp)
                mb = g["bytes"] / 1048576
                STATS.update(file_mb=round(mb, 2), calls=g["prims"], g_tris=g["tris"])
                out.append(_tier("file_mb", round(mb, 2), "Exported file size", " MB"))
                out.append(_tier("draw_calls", g["prims"], "Draw calls in the exported file"))
                out.append(_tier("tris", g["tris"], "Triangles in the exported file"))
                for e in list(g["ext_req"]) + [x for x in g["ext"] if x in SKIP_EXT]:
                    if e in SKIP_EXT:
                        fail(f"The file uses {e}, which the viewer cannot decode. Turn compression off in the export options.")
                if g["uv_sets"] > MAX_UV_SETS:
                    fail(f"Exported meshes carry {g['uv_sets']} UV sets, the viewer reads {MAX_UV_SETS}.")
                if g["ao_uv"] and g["ao_uv"] != [1]:
                    warn("An occlusion (lightmap) texture is using UV0. Point it at UV1 so it can be unwrapped separately.")
                if g["ao_uv"] == [1]:
                    ok("Baked occlusion/lightmap texture found on UV1")
                for im in g["images"]:
                    if im["mime"] not in ("image/png", "image/jpeg"):
                        fail(f"A texture is stored as {im['mime']}; use PNG or JPEG.")
                    if im["size"] and max(im["size"]) > BUDGET["tex_px"]["limit"]:
                        fail(f"An exported texture is {im['size'][0]}x{im['size'][1]}, over the {BUDGET['tex_px']['limit']} px limit.")
        except Exception as e:
            warn(f"Test export failed: {e}")
    return out


def summarise(res):
    return sum(1 for l, _ in res if l == "FAIL"), sum(1 for l, _ in res if l == "WARN")


class ENV_OT_check(bpy.types.Operator):
    bl_idname = "environment.check"
    bl_label = "Check environment"
    bl_description = "Check this scene against the Quest 2 budget and the viewer's supported features (runs a test export)"

    def execute(self, context):
        global LAST
        LAST = run_checks(context.scene)
        f, w = summarise(LAST)
        for lvl, t in LAST:
            print(f"[{lvl}] {t}")
        self.report({'ERROR' if f else 'INFO'}, f"{f} problem(s), {w} warning(s). See the Environment panel." if f or w else "In spec.")
        for a in context.screen.areas:
            a.tag_redraw()
        return {'FINISHED'}


class ENV_OT_export(bpy.types.Operator):
    bl_idname = "environment.export_glb"
    bl_label = "Check and export room .glb"
    bl_description = "Run the checks, then export the visible meshes to the path above"

    def execute(self, context):
        global LAST
        path = bpy.path.abspath(context.scene.env_kit_path)
        if not path.lower().endswith(".glb"):
            self.report({'ERROR'}, "The export path must end in .glb")
            return {'CANCELLED'}
        LAST = run_checks(context.scene, do_export=False)
        f, w = summarise(LAST)
        if f:
            self.report({'ERROR'}, f"Not exported: {f} problem(s). See the Environment panel.")
            return {'CANCELLED'}
        os.makedirs(os.path.dirname(path), exist_ok=True)
        if not _gltf_export(path, context.scene):
            self.report({'ERROR'}, "Export failed.")
            return {'CANCELLED'}
        LAST = run_checks(context.scene, do_export=True)  # re-check including the real file
        LAST.append(("PASS", f"Exported {path} ({os.path.getsize(path)/1024:.0f} KB)"))
        self.report({'INFO'}, f"Exported {os.path.basename(path)}")
        return {'FINISHED'}


class ENV_PT_panel(bpy.types.Panel):
    bl_label = "WebXR Meet environment"
    bl_idname = "ENV_PT_panel"
    bl_space_type = 'VIEW_3D'
    bl_region_type = 'UI'
    bl_category = "Environment"

    def draw(self, context):
        import textwrap
        lay = self.layout
        lay.operator("environment.check", icon='CHECKMARK')
        lay.prop(context.scene, "env_kit_path", text="")
        lay.operator("environment.export_glb", icon='EXPORT')
        if LAST:
            f, w = summarise(LAST)
            lay.label(text=f"{f} problem(s), {w} warning(s)", icon='ERROR' if f else 'CHECKMARK')
            col = lay.box().column(align=True)
            for lvl, t in sorted(LAST, key=lambda x: {"FAIL": 0, "WARN": 1, "PASS": 2}[x[0]]):
                icon = {"FAIL": 'CANCEL', "WARN": 'ERROR', "PASS": 'CHECKMARK'}[lvl]
                for i, line in enumerate(textwrap.wrap(t, 40) or [""]):
                    col.label(text=line, icon=icon if i == 0 else 'BLANK1')


CLASSES = (ENV_OT_check, ENV_OT_export, ENV_PT_panel)


def register():
    for c in CLASSES:
        try:
            bpy.utils.unregister_class(c)
        except Exception:
            pass
        bpy.utils.register_class(c)
    bpy.types.Scene.env_kit_path = bpy.props.StringProperty(
        name="Export path", subtype='FILE_PATH',
        default=r"H:\QUEST_DEV\webxr-meet\public\models\kitchen.glb")


if __name__ == "__main__":
    register()
    if "--check" in sys.argv:
        res = run_checks()
        for lvl, t in res:
            print(f"[{lvl}] {t}")
        f, w = summarise(res)
        print(f"RESULT: {'FAIL' if f else 'PASS'} ({f} problems, {w} warnings)")
