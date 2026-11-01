"""Carve a 3D solid from outlines (silhouettes) seen from the front, the right side and above, then save it as an STL.

Usage: python carve_helper.py <spec.json>

spec.json: {outdir, views: {front?, side?, top?: picture path}, size_mm: {x?, y?, z?},
            quality (1 draft .. 3 fine), background ("auto" | "dark" | "light"), smooth (bool)}

The three views are assumed to be straight-on (no perspective):
  front  looking at the object, X to the right, Z up
  side   looking at its RIGHT side, so the front is on the left and the back on the right (Y to the right), Z up
  top    looking down from above with the front edge at the bottom, X to the right, Y up
A voxel stays only if every supplied view shows the object there (the "visual hull"), so this makes the largest solid
that fits all the outlines. Holes and hollows that do not show in an outline cannot be recovered.

Prints one JSON object per line on stdout:
  {"type": "stage", "name": "reading the pictures"}  {"type": "info", "size": [x, y, z], "triangles": n}
  {"type": "file", "kind": "stl", "file": "out.stl"}  {"type": "done"}  or  {"type": "error", "message": "..."}
"""
import json
import os
import struct
import sys


def emit(obj):
    print(json.dumps(obj, ensure_ascii=False), flush=True)


class UserError(Exception):
    pass


NAMES = {"front": "front", "side": "side", "top": "top"}
MARK = (1, 254, 3)  # a colour that will not occur in a picture: paints the background while flood-filling


def load_mask(path, which, background):
    """Picture -> boolean array (True = the object), cropped to the object's outline."""
    import numpy as np
    from PIL import Image, ImageDraw, ImageFilter

    try:
        img = Image.open(path)
    except Exception:
        raise UserError(f"The {which} picture could not be opened.")
    rgba = img.convert("RGBA")
    alpha = np.asarray(rgba)[:, :, 3]
    if (alpha < 250).mean() > 0.02:
        # a cut-out picture with transparency: the opaque part is the object
        mask = alpha > 128
    else:
        rgb = rgba.convert("RGB")
        if background in ("dark", "light"):
            lum = np.asarray(rgb.convert("L"))
            mask = lum < 128 if background == "light" else lum > 128  # "light" = a light background, so the object is dark
        else:
            work = rgb.copy()
            w, h = work.size
            seeds = [(0, 0), (w - 1, 0), (0, h - 1), (w - 1, h - 1), (w // 2, 0), (w // 2, h - 1), (0, h // 2), (w - 1, h // 2)]
            for s in seeds:
                if work.getpixel(s) != MARK:
                    ImageDraw.floodfill(work, s, MARK, thresh=60)
            arr = np.asarray(work)
            mask = ~((arr[:, :, 0] == MARK[0]) & (arr[:, :, 1] == MARK[1]) & (arr[:, :, 2] == MARK[2]))
    m = Image.fromarray((mask * 255).astype("uint8")).filter(ImageFilter.MedianFilter(5))  # drop specks and ragged edges
    mask = np.asarray(m) > 127
    ys, xs = np.nonzero(mask)
    if len(xs) < 50:
        raise UserError(f"No object was found in the {which} picture. Use a plain background, or a cut-out with a transparent background.")
    return mask[ys.min() : ys.max() + 1, xs.min() : xs.max() + 1]


def resolve_sizes(size, masks):
    """Work out the missing sizes (mm) from the ones given and the outlines' proportions."""
    x, y, z = size.get("x"), size.get("y"), size.get("z")
    ratio = {}  # width / height of each outline
    for k, m in masks.items():
        ratio[k] = m.shape[1] / m.shape[0]
    # front: X by Z, side: Y by Z, top: X by Y
    for _ in range(4):
        if "front" in ratio:
            if z and not x:
                x = z * ratio["front"]
            if x and not z:
                z = x / ratio["front"]
        if "side" in ratio:
            if z and not y:
                y = z * ratio["side"]
            if y and not z:
                z = y / ratio["side"]
        if "top" in ratio:
            if y and not x:
                x = y * ratio["top"]
            if x and not y:
                y = x / ratio["top"]
    if not (x or y or z):
        return None
    return x, y, z


def write_stl(path, tris):
    import numpy as np

    n = len(tris)
    a, b, c = tris[:, 0], tris[:, 1], tris[:, 2]
    normals = np.cross(b - a, c - a)
    length = np.linalg.norm(normals, axis=1, keepdims=True)
    normals = np.divide(normals, length, out=np.zeros_like(normals), where=length > 0)
    rec = np.zeros(n, dtype=[("n", "<f4", 3), ("v", "<f4", (3, 3)), ("a", "<u2")])
    rec["n"], rec["v"] = normals, tris
    with open(path, "wb") as f:
        f.write(b"LLM Icarus carved solid".ljust(80, b" "))
        f.write(struct.pack("<I", n))
        f.write(rec.tobytes())


def main():
    import numpy as np
    from PIL import Image

    with open(sys.argv[1], encoding="utf-8-sig") as f:
        spec = json.load(f)
    os.makedirs(spec["outdir"], exist_ok=True)

    emit({"type": "stage", "name": "reading the pictures"})
    masks = {}
    for k in ("front", "side", "top"):
        p = (spec.get("views") or {}).get(k)
        if p:
            masks[k] = load_mask(p, NAMES[k], spec.get("background", "auto"))
    if not masks:
        raise UserError("Give at least one picture: front, side or top.")

    sizes = resolve_sizes(spec.get("size_mm") or {}, masks)
    note = None
    if sizes is None:
        # no sizes at all: make the longest side 100 mm
        sizes = resolve_sizes({"x": 100.0}, masks) or resolve_sizes({"y": 100.0}, masks) or resolve_sizes({"z": 100.0}, masks)
        note = "No size was given, so the longest side was set to 100 mm."
    x, y, z = sizes
    # an axis no picture constrains needs a size from you (a front picture alone says nothing about depth)
    if not y:
        raise UserError("The depth (Y) is not known. Give the depth in mm, or add a side or top picture.")
    if not x or not z:
        raise UserError("Not enough to work out the sizes. Give the width and height (and depth) in mm.")

    quality = max(1, min(3, int(spec.get("quality", 2))))
    n_long = {1: 64, 2: 112, 3: 160}[quality]
    longest = max(x, y, z)
    nx, ny, nz = (max(8, round(n_long * v / longest)) for v in (x, y, z))

    def fit(mask, cols, rows):
        im = Image.fromarray((mask * 255).astype("uint8")).resize((cols, rows), Image.BILINEAR)
        return np.asarray(im) > 127

    vol = np.ones((nx, ny, nz), dtype=bool)
    if "front" in masks:  # rows = Z (top first), columns = X
        vol &= fit(masks["front"], nx, nz)[::-1].T[:, None, :]
    if "side" in masks:  # rows = Z, columns = Y
        vol &= fit(masks["side"], ny, nz)[::-1].T[None, :, :]
    if "top" in masks:  # rows = Y (back at the top), columns = X
        vol &= fit(masks["top"], nx, ny)[::-1].T[:, :, None]
    if not vol.any():
        raise UserError("Carving left nothing: the pictures do not describe the same object. Check that they show the front, the RIGHT side and the top, with matching sizes.")

    emit({"type": "stage", "name": "building the surface"})
    import mcubes

    padded = np.pad(vol, 1).astype(float)
    level = mcubes.smooth(padded) if spec.get("smooth", True) else padded
    verts, faces = mcubes.marching_cubes(level, 0.0 if spec.get("smooth", True) else 0.5)
    if len(faces) == 0:
        raise UserError("The carved shape was too thin to make a surface. Try a higher quality, or thicker outlines.")
    # Marching cubes makes a very fine mesh. Merge flat areas (quadric simplification) so the file and the preview stay
    # light: the shape is kept, the triangle count drops. (Skipped if the optional tool is missing.)
    target = {1: 20000, 2: 40000, 3: 70000}[quality]
    if len(faces) > target:
        try:
            import fast_simplification

            verts, faces = fast_simplification.simplify(verts.astype(np.float32), faces.astype(np.int32), target_reduction=1 - target / len(faces))
        except Exception:
            pass
    # voxel units -> millimetres. Smoothing shaves a little off the outline, so stretch the result to the exact size asked
    # for, then centre it on the build plate (X, Y centred, Z from 0).
    extent = verts.max(axis=0) - verts.min(axis=0)
    extent[extent == 0] = 1
    verts = (verts - verts.min(axis=0)) * (np.array([x, y, z]) / extent)
    verts[:, 0] -= x / 2
    verts[:, 1] -= y / 2
    tris = verts[faces].astype(np.float32)
    # make sure the faces point outwards (a negative volume means they are inside out)
    vol6 = np.einsum("ij,ij->i", tris[:, 0], np.cross(tris[:, 1], tris[:, 2])).sum()
    if vol6 < 0:
        tris = tris[:, ::-1]
    stl = os.path.join(spec["outdir"], "out.stl")
    write_stl(stl, np.ascontiguousarray(tris))
    lo, hi = tris.reshape(-1, 3).min(axis=0), tris.reshape(-1, 3).max(axis=0)
    emit({"type": "info", "size": [round(float(v), 2) for v in (hi - lo)], "triangles": int(len(tris)), "note": note,
          "sizeUsed": [round(float(x), 2), round(float(y), 2), round(float(z), 2)]})
    emit({"type": "file", "kind": "stl", "file": "out.stl"})
    emit({"type": "done"})


if __name__ == "__main__":
    try:
        main()
    except UserError as e:
        emit({"type": "error", "message": str(e)})
        sys.exit(1)
    except Exception as e:
        emit({"type": "error", "message": f"{type(e).__name__}: {e}"})
        sys.exit(1)
