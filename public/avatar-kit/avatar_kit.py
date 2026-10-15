"""
WebXR Meet avatar kit  -  checker + exporter

Run this script from Blender's Text Editor (Run Script). A sidebar tab "Avatar" appears in the 3D viewport (press N).
Headless check:  blender -b my_avatar.blend -P avatar_kit.py -- --check
The same limits are enforced again in the browser when you upload the .glb, so passing here means passing there.
"""
import bpy, os, sys
import numpy as np

# ---------------------------------------------------------------- limits (keep in sync with avatar_limits.json)
PARTS = ("Head", "Torso", "HandL", "HandR")
SPEC = {
    "Head":  dict(max_tris=1000, size=(0.15, 0.40), pivot_tol=0.04),
    "Torso": dict(max_tris=800,  size=(0.25, 0.90), pivot_tol=0.12),
    "HandL": dict(max_tris=300,  size=(0.04, 0.25), pivot_tol=0.06),
    "HandR": dict(max_tris=300,  size=(0.04, 0.25), pivot_tol=0.06),
}
TOTAL_TRIS = 2400
MAX_MATERIALS = 2
MAX_TEXTURES = 2
MAX_TEX_PX = 512
MAX_FILE_BYTES = 1_000_000
GUIDE_PREFIX = "GUIDE"
ALLOWED_NODES = {"BSDF_PRINCIPLED", "OUTPUT_MATERIAL", "TEX_IMAGE", "UVMAP"}

LAST = []   # last results, shown in the panel


def _pot(n):
    return n > 0 and (n & (n - 1)) == 0


def run_checks(scene=None):
    """Return a list of (level, text). level is PASS, WARN or FAIL."""
    scene = scene or bpy.context.scene
    out = []
    ok = lambda t: out.append(("PASS", t))
    warn = lambda t: out.append(("WARN", t))
    fail = lambda t: out.append(("FAIL", t))

    # 1. the four parts
    objs = {}
    for name in PARTS:
        o = scene.objects.get(name)
        if o is None:
            fail(f"Missing '{name}'. Name your mesh exactly '{name}' (case matters).")
        elif o.type != 'MESH':
            fail(f"'{name}' is a {o.type}, it must be a mesh.")
        else:
            objs[name] = o
    if len(objs) == 4:
        ok("All four parts found: Head, Torso, HandL, HandR")

    for o in scene.objects:
        if o.name in PARTS or o.name.startswith(GUIDE_PREFIX):
            continue
        if o.type in {'MESH', 'CURVE', 'SURFACE', 'META', 'FONT', 'ARMATURE'} and not o.hide_viewport:
            warn(f"'{o.name}' is not one of the four parts and will NOT be exported (hide it or rename it to start with {GUIDE_PREFIX}).")

    if not objs:
        return out

    dg = bpy.context.evaluated_depsgraph_get()
    total = 0
    mats, imgs = {}, {}
    for name, o in objs.items():
        spec = SPEC[name]
        # transforms
        if o.parent is not None:
            fail(f"{name}: has a parent. Unparent it (Alt+P) so it exports at the top level.")
        m3 = o.matrix_basis.to_3x3()
        dev = max(abs(m3[i][j] - (1.0 if i == j else 0.0)) for i in range(3) for j in range(3))
        if dev > 1e-3:
            fail(f"{name}: rotation or scale is not applied. Select it, Ctrl+A > Rotation & Scale.")
        if o.animation_data and o.animation_data.action:
            warn(f"{name}: has animation, which is ignored.")
        if o.data.shape_keys:
            fail(f"{name}: shape keys are not supported. Delete them.")
        if o.vertex_groups or any(md.type == 'ARMATURE' for md in o.modifiers):
            fail(f"{name}: rigging (vertex groups / armature) is not supported. The parts move rigidly.")

        ev = o.evaluated_get(dg)
        me = ev.to_mesh()
        try:
            me.calc_loop_triangles()
            tris = len(me.loop_triangles)
            n = len(me.vertices)
            if n == 0:
                fail(f"{name}: mesh is empty.")
                continue
            co = np.empty(n * 3, dtype=np.float32)
            me.vertices.foreach_get("co", co)
            co = co.reshape(-1, 3)
            lo, hi = co.min(axis=0), co.max(axis=0)
            centre = (lo + hi) / 2
            dim = float((hi - lo).max())
            uv_layers = len(me.uv_layers)
            used_slots = {p.material_index for p in me.polygons}
        finally:
            ev.to_mesh_clear()

        total += tris
        if tris > spec["max_tris"]:
            fail(f"{name}: {tris} triangles, limit is {spec['max_tris']}.")
        else:
            ok(f"{name}: {tris} triangles (limit {spec['max_tris']})")

        lo_s, hi_s = spec["size"]
        if not (lo_s <= dim <= hi_s):
            fail(f"{name}: largest dimension is {dim:.2f} m, expected {lo_s:.2f} to {hi_s:.2f} m. Check the scale against the GUIDE figure.")
        off = float(np.linalg.norm(centre))
        if off > spec["pivot_tol"]:
            fail(f"{name}: origin is {off*100:.0f} cm from the middle of the mesh (limit {spec['pivot_tol']*100:.0f} cm). "
                 f"Set Origin > Origin to Geometry (hands: put the origin where the controller is held).")

        if uv_layers > 1:
            warn(f"{name}: {uv_layers} UV maps, only the first is exported.")

        if not o.material_slots:
            warn(f"{name}: no material, it will be plain white.")
        for i, slot in enumerate(o.material_slots):
            if slot.material is None:
                fail(f"{name}: material slot {i+1} is empty. Remove it.")
                continue
            mats[slot.material.name] = slot.material
            if i not in used_slots and len(o.material_slots) > 1:
                warn(f"{name}: material slot {i+1} ({slot.material.name}) is unused.")
        has_tex = False
        for slot in o.material_slots:
            mt = slot.material
            if mt and mt.node_tree:
                for node in mt.node_tree.nodes:
                    if node.type == 'TEX_IMAGE' and node.image:
                        has_tex = True
        if has_tex and uv_layers == 0:
            fail(f"{name}: uses a texture but has no UV map.")

    ok(f"Total {total} triangles (limit {TOTAL_TRIS})") if total <= TOTAL_TRIS else fail(f"Total {total} triangles, limit is {TOTAL_TRIS}.")

    # materials and textures
    if len(mats) > MAX_MATERIALS:
        fail(f"{len(mats)} materials used, limit is {MAX_MATERIALS}. Share one material and one colour texture across all parts.")
    else:
        ok(f"{len(mats)} material(s) (limit {MAX_MATERIALS})")
    for mt in mats.values():
        if not mt.node_tree:
            continue
        for node in mt.node_tree.nodes:
            if node.type not in ALLOWED_NODES:
                warn(f"{mt.name}: node '{node.name}' ({node.type}) is not exported. Use Principled BSDF with an Image Texture on Base Color.")
            if node.type == 'TEX_IMAGE' and node.image:
                imgs[node.image.name] = node.image
            if node.type == 'BSDF_PRINCIPLED':
                a = node.inputs["Alpha"]
                if a.is_linked or a.default_value < 0.999:
                    warn(f"{mt.name}: transparency is not supported and will render opaque.")
                for sock in ("Normal", "Emission Color", "Coat Weight", "Transmission Weight"):
                    s = node.inputs.get(sock)
                    if s is not None and s.is_linked:
                        warn(f"{mt.name}: '{sock}' input is ignored in the viewer (cheap lit shader). Only Base Color is used.")
    if len(imgs) > MAX_TEXTURES:
        fail(f"{len(imgs)} textures, limit is {MAX_TEXTURES}.")
    for im in imgs.values():
        w, h = im.size
        if w > MAX_TEX_PX or h > MAX_TEX_PX:
            fail(f"Texture '{im.name}' is {w}x{h}, maximum is {MAX_TEX_PX}x{MAX_TEX_PX}.")
        elif not (_pot(w) and _pot(h)):
            warn(f"Texture '{im.name}' is {w}x{h}: use powers of two (256, 512).")
        else:
            ok(f"Texture '{im.name}' {w}x{h}")
        if not im.packed_file and not im.filepath:
            fail(f"Texture '{im.name}' is generated and not saved. Image > Save As, or Image > Pack.")

    # orientation sanity
    if all(k in objs for k in PARTS):
        if objs["Head"].location.z <= objs["Torso"].location.z:
            warn("Head is not above the Torso in the template pose.")
        if objs["HandL"].location.x < objs["HandR"].location.x:
            warn("HandL is on the -X side. Facing the front view (-Y), the left hand should be on +X.")
    return out


def summarise(res):
    f = sum(1 for l, _ in res if l == "FAIL")
    w = sum(1 for l, _ in res if l == "WARN")
    return f, w


def _gltf_export(path):
    kw = dict(filepath=path, export_format='GLB', use_selection=True, export_apply=True, export_yup=True,
              export_cameras=False, export_animations=False, export_skins=False, export_morph=False,
              export_extras=False, use_active_scene=True)
    try:
        bpy.ops.export_scene.gltf(**kw)
    except TypeError:
        for k in ("use_active_scene", "export_extras", "export_morph", "export_skins", "export_animations", "export_cameras"):
            kw.pop(k, None)
            try:
                bpy.ops.export_scene.gltf(**kw)
                break
            except TypeError:
                continue


class AVATAR_OT_check(bpy.types.Operator):
    bl_idname = "avatar.check"
    bl_label = "Check avatar"
    bl_description = "Check the four parts against the WebXR Meet avatar rules"

    def execute(self, context):
        global LAST
        LAST = run_checks(context.scene)
        f, w = summarise(LAST)
        for lvl, t in LAST:
            print(f"[{lvl}] {t}")
        if f:
            self.report({'ERROR'}, f"{f} problem(s) to fix, {w} warning(s). See the Avatar panel.")
        else:
            self.report({'INFO'}, f"Avatar passes ({w} warning(s)).")
        for a in context.screen.areas:
            a.tag_redraw()
        return {'FINISHED'}


class AVATAR_OT_export(bpy.types.Operator):
    bl_idname = "avatar.export_glb"
    bl_label = "Check and export .glb"
    bl_description = "Run the checks, then export the four parts as a .glb ready to upload"
    filepath: bpy.props.StringProperty(subtype='FILE_PATH')
    filter_glob: bpy.props.StringProperty(default="*.glb", options={'HIDDEN'})

    def invoke(self, context, event):
        if not self.filepath:
            stem = os.path.splitext(bpy.data.filepath)[0] if bpy.data.filepath else os.path.join(os.path.expanduser("~"), "avatar")
            self.filepath = stem + ".glb"
        context.window_manager.fileselect_add(self)
        return {'RUNNING_MODAL'}

    def execute(self, context):
        global LAST
        LAST = run_checks(context.scene)
        f, w = summarise(LAST)
        if f:
            self.report({'ERROR'}, f"Not exported: {f} problem(s). See the Avatar panel.")
            return {'CANCELLED'}
        for o in context.view_layer.objects:
            o.select_set(False)
        for n in PARTS:
            o = context.scene.objects[n]
            o.hide_set(False)
            o.select_set(True)
        context.view_layer.objects.active = context.scene.objects["Head"]
        path = bpy.path.ensure_ext(self.filepath, ".glb")
        _gltf_export(path)
        size = os.path.getsize(path)
        if size > MAX_FILE_BYTES:
            LAST.append(("FAIL", f"Exported file is {size/1e6:.2f} MB, limit is {MAX_FILE_BYTES/1e6:.1f} MB. Shrink the texture or use a JPEG."))
            self.report({'ERROR'}, f"File too large: {size/1e6:.2f} MB")
            return {'CANCELLED'}
        LAST.append(("PASS", f"Exported {os.path.basename(path)} ({size/1024:.0f} KB)"))
        self.report({'INFO'}, f"Exported {os.path.basename(path)} ({size/1024:.0f} KB)")
        return {'FINISHED'}


class AVATAR_PT_panel(bpy.types.Panel):
    bl_label = "WebXR Meet avatar"
    bl_idname = "AVATAR_PT_panel"
    bl_space_type = 'VIEW_3D'
    bl_region_type = 'UI'
    bl_category = "Avatar"

    def draw(self, context):
        lay = self.layout
        lay.operator("avatar.check", icon='CHECKMARK')
        lay.operator("avatar.export_glb", icon='EXPORT')
        if LAST:
            f, w = summarise(LAST)
            lay.label(text=f"{f} problem(s), {w} warning(s)", icon='ERROR' if f else 'CHECKMARK')
            box = lay.box()
            col = box.column(align=True)
            for lvl, t in sorted(LAST, key=lambda x: {"FAIL": 0, "WARN": 1, "PASS": 2}[x[0]]):
                icon = {"FAIL": 'CANCEL', "WARN": 'ERROR', "PASS": 'CHECKMARK'}[lvl]
                import textwrap
                for i, line in enumerate(textwrap.wrap(t, 38) or [""]):
                    col.label(text=line, icon=icon if i == 0 else 'BLANK1')


CLASSES = (AVATAR_OT_check, AVATAR_OT_export, AVATAR_PT_panel)


def register():
    for c in CLASSES:
        try:
            bpy.utils.unregister_class(c)
        except Exception:
            pass
        bpy.utils.register_class(c)


if __name__ == "__main__":
    register()
    if "--check" in sys.argv:
        res = run_checks()
        for lvl, t in res:
            print(f"[{lvl}] {t}")
        f, w = summarise(res)
        print(f"RESULT: {'FAIL' if f else 'PASS'} ({f} problems, {w} warnings)")
