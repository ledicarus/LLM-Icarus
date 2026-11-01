"""Vector helper: trace a picture into SVG, and turn an SVG into EPS.

Usage: python vector_helper.py <spec.json>

spec.json: {action: "trace" | "convert", outdir, input,
            colormode ("color" | "binary"), detail (1 coarse .. 5 fine), remove_background (bool),
            width_mm (number or null: scale the EPS to this width)}
  trace:   input is a picture (png/jpg). Writes out.svg (via vtracer) and out.eps.
  convert: input is an SVG file. Writes out.svg (a cleaned copy) and out.eps.

Prints one JSON object per line on stdout:
  {"type": "stage", "name": "tracing"}  {"type": "file", "kind": "svg", "file": "out.svg"}
  {"type": "done"}   or   {"type": "error", "message": "..."}
"""
import json
import os
import re
import sys


def emit(obj):
    print(json.dumps(obj, ensure_ascii=False), flush=True)


# detail 1..5 -> vtracer settings (coarse and small files .. fine and faithful)
DETAIL = {
    1: dict(filter_speckle=20, color_precision=4, layer_difference=48),
    2: dict(filter_speckle=12, color_precision=5, layer_difference=32),
    3: dict(filter_speckle=6, color_precision=6, layer_difference=16),
    4: dict(filter_speckle=4, color_precision=7, layer_difference=12),
    5: dict(filter_speckle=2, color_precision=8, layer_difference=8),
}


def prepare_image(src, outdir, colormode, remove_background):
    """Flatten the picture for tracing: optional transparent background, black-and-white for binary mode."""
    from PIL import Image

    img = Image.open(src)
    if img.mode in ("P", "LA"):
        img = img.convert("RGBA")
    if colormode == "binary":
        gray = img.convert("L")
        # dark ink on light paper: threshold so the tracer sees clean black shapes
        bw = gray.point(lambda v: 0 if v < 140 else 255)
        out = os.path.join(outdir, "prepared.png")
        bw.convert("RGB").save(out)
        return out
    rgba = img.convert("RGBA")
    if remove_background:
        # Flood-fill inwards from the edges: whatever plain colour surrounds the subject (white, or the light grey SDXL
        # paints) becomes transparent, while white areas inside the subject are kept.
        from PIL import ImageDraw

        w, h = rgba.size
        seeds = [(0, 0), (w - 1, 0), (0, h - 1), (w - 1, h - 1), (w // 2, 0), (w // 2, h - 1), (0, h // 2), (w - 1, h // 2)]
        for seed in seeds:
            if rgba.getpixel(seed)[3] != 0:
                ImageDraw.floodfill(rgba, seed, (255, 255, 255, 0), thresh=70)
        out = os.path.join(outdir, "prepared.png")
        rgba.save(out)
        return out
    out = os.path.join(outdir, "prepared.png")
    rgba.convert("RGB").save(out)
    return out


def trace(spec, svg_path):
    import vtracer

    colormode = "binary" if spec.get("colormode") == "binary" else "color"
    prepared = prepare_image(spec["input"], spec["outdir"], colormode, bool(spec.get("remove_background")))
    s = DETAIL[max(1, min(5, int(spec.get("detail", 3))))]
    vtracer.convert_image_to_svg_py(
        prepared,
        svg_path,
        colormode=colormode,
        hierarchical="stacked",
        mode="spline",
        filter_speckle=s["filter_speckle"],
        color_precision=s["color_precision"],
        layer_difference=s["layer_difference"],
        corner_threshold=60,
        length_threshold=4.0,
        max_iterations=10,
        splice_threshold=45,
        path_precision=2,
    )
    os.remove(prepared)


_NUM = re.compile(r"[-+]?(?:\d*\.\d+|\d+\.?)(?:[eE][-+]?\d+)?")


def _n(v):
    s = f"{v:.3f}".rstrip("0").rstrip(".")
    return "0" if s in ("", "-0") else s


def _arc_to_cubics(x1, y1, rx, ry, phi_deg, fa, fs, x2, y2):
    """SVG elliptical arc -> list of cubic segments (c1x, c1y, c2x, c2y, x, y). See the SVG spec, appendix F.6."""
    import math

    if x1 == x2 and y1 == y2:
        return []
    rx, ry = abs(rx), abs(ry)
    if rx == 0 or ry == 0:
        return [(x1, y1, x2, y2, x2, y2)]  # a straight line
    phi = math.radians(phi_deg)
    cp, sp = math.cos(phi), math.sin(phi)
    dx, dy = (x1 - x2) / 2, (y1 - y2) / 2
    x1p, y1p = cp * dx + sp * dy, -sp * dx + cp * dy
    lam = x1p**2 / rx**2 + y1p**2 / ry**2
    if lam > 1:
        s = math.sqrt(lam)
        rx, ry = rx * s, ry * s
    num = rx**2 * ry**2 - rx**2 * y1p**2 - ry**2 * x1p**2
    den = rx**2 * y1p**2 + ry**2 * x1p**2
    coef = math.sqrt(max(0.0, num / den)) * (-1 if fa == fs else 1)
    cxp, cyp = coef * rx * y1p / ry, -coef * ry * x1p / rx
    cx, cy = cp * cxp - sp * cyp + (x1 + x2) / 2, sp * cxp + cp * cyp + (y1 + y2) / 2

    def ang(ux, uy, vx, vy):
        return math.atan2(ux * vy - uy * vx, ux * vx + uy * vy)

    t1 = ang(1, 0, (x1p - cxp) / rx, (y1p - cyp) / ry)
    dt = ang((x1p - cxp) / rx, (y1p - cyp) / ry, (-x1p - cxp) / rx, (-y1p - cyp) / ry)
    if not fs and dt > 0:
        dt -= 2 * math.pi
    if fs and dt < 0:
        dt += 2 * math.pi
    segs = max(1, math.ceil(abs(dt) / (math.pi / 2) - 1e-9))
    delta = dt / segs
    k = 4 / 3 * math.tan(delta / 4)

    def pt(a):
        return (cx + rx * math.cos(a) * cp - ry * math.sin(a) * sp, cy + rx * math.cos(a) * sp + ry * math.sin(a) * cp)

    def dv(a):
        return (-rx * math.sin(a) * cp - ry * math.cos(a) * sp, -rx * math.sin(a) * sp + ry * math.cos(a) * cp)

    out = []
    for i in range(segs):
        a1, a2 = t1 + i * delta, t1 + (i + 1) * delta
        p1, p2, d1, d2 = pt(a1), pt(a2), dv(a1), dv(a2)
        out.append((p1[0] + k * d1[0], p1[1] + k * d1[1], p2[0] - k * d2[0], p2[1] - k * d2[1], p2[0], p2[1]))
    return out


def normalize_path(d):
    """Rewrite any SVG path as absolute M / L / C / Z only (arcs, quadratics, smooth and relative commands become plain
    curves). EPS and svglib handle that subset reliably; models like to write the shorthand forms."""
    i, n = 0, len(d)
    out = []
    x = y = sx = sy = 0.0
    last_c = last_q = None
    prev = ""
    cmd = None

    def skip():
        nonlocal i
        while i < n and d[i] in " \t\r\n,":
            i += 1

    def number():
        nonlocal i
        skip()
        m = _NUM.match(d, i)
        if not m:
            raise ValueError(f"bad path data near '{d[i:i + 12]}'")
        i = m.end()
        return float(m.group())

    def flag():
        nonlocal i
        skip()
        if i < n and d[i] in "01":
            i += 1
            return int(d[i - 1])
        raise ValueError("bad arc flag in path data")

    while True:
        skip()
        if i >= n:
            break
        if d[i].isalpha():
            cmd = d[i]
            i += 1
            if cmd in "Zz":
                out.append("Z")
                x, y = sx, sy
                last_c = last_q = None
                prev = "Z"
                continue
        elif cmd is None or cmd in "Zz":
            raise ValueError("bad path data")
        rel, c = cmd.islower(), cmd.upper()
        ox, oy = (x, y) if rel else (0.0, 0.0)
        if c == "M":
            x, y = number() + ox, number() + oy
            sx, sy = x, y
            out.append(f"M {_n(x)} {_n(y)}")
            cmd = "l" if rel else "L"  # extra coordinate pairs after a moveto are linetos
            last_c = last_q = None
        elif c == "L":
            x, y = number() + ox, number() + oy
            out.append(f"L {_n(x)} {_n(y)}")
            last_c = last_q = None
        elif c == "H":
            x = number() + ox
            out.append(f"L {_n(x)} {_n(y)}")
            last_c = last_q = None
        elif c == "V":
            y = number() + oy
            out.append(f"L {_n(x)} {_n(y)}")
            last_c = last_q = None
        elif c == "C":
            x1, y1, x2, y2, nx, ny = (number() + (ox if k % 2 == 0 else oy) for k in range(6))
            out.append(f"C {_n(x1)} {_n(y1)} {_n(x2)} {_n(y2)} {_n(nx)} {_n(ny)}")
            last_c, last_q = (x2, y2), None
            x, y = nx, ny
        elif c == "S":
            x2, y2, nx, ny = (number() + (ox if k % 2 == 0 else oy) for k in range(4))
            x1, y1 = (2 * x - last_c[0], 2 * y - last_c[1]) if last_c and prev in "CS" else (x, y)
            out.append(f"C {_n(x1)} {_n(y1)} {_n(x2)} {_n(y2)} {_n(nx)} {_n(ny)}")
            last_c, last_q = (x2, y2), None
            x, y = nx, ny
        elif c in "QT":
            if c == "Q":
                qx, qy, nx, ny = (number() + (ox if k % 2 == 0 else oy) for k in range(4))
            else:
                nx, ny = number() + ox, number() + oy
                qx, qy = (2 * x - last_q[0], 2 * y - last_q[1]) if last_q and prev in "QT" else (x, y)
            out.append(
                f"C {_n(x + 2 / 3 * (qx - x))} {_n(y + 2 / 3 * (qy - y))} {_n(nx + 2 / 3 * (qx - nx))} {_n(ny + 2 / 3 * (qy - ny))} {_n(nx)} {_n(ny)}"
            )
            last_q, last_c = (qx, qy), None
            x, y = nx, ny
        elif c == "A":
            rx, ry, rot = number(), number(), number()
            fa, fs = flag(), flag()
            nx, ny = number() + ox, number() + oy
            for c1x, c1y, c2x, c2y, ex, ey in _arc_to_cubics(x, y, rx, ry, rot, fa, fs, nx, ny):
                out.append(f"C {_n(c1x)} {_n(c1y)} {_n(c2x)} {_n(c2y)} {_n(ex)} {_n(ey)}")
            x, y = nx, ny
            last_c = last_q = None
        else:
            raise ValueError(f"unknown path command '{cmd}'")
        prev = c
    return " ".join(out)


def _color_of(value):
    """'#rgb' / '#rrggbb' / 'rgb(r,g,b)' -> (r, g, b), or None."""
    v = (value or "").strip().lower()
    m = re.fullmatch(r"#([0-9a-f]{3})", v)
    if m:
        return tuple(int(ch * 2, 16) for ch in m.group(1))
    m = re.fullmatch(r"#([0-9a-f]{6})", v)
    if m:
        return tuple(int(m.group(1)[k : k + 2], 16) for k in (0, 2, 4))
    m = re.fullmatch(r"rgb\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*\)", v)
    if m:
        return tuple(int(g) for g in m.groups())
    return None


def clean_svg(text):
    """Make an SVG safe for the EPS converter: well-formed XML, no scripts/images/filters/masks, gradients flattened to a
    solid colour, every path rewritten as plain absolute curves, and a size on the root element."""
    from lxml import etree

    try:
        root = etree.fromstring(text.encode("utf-8"), etree.XMLParser(recover=False, resolve_entities=False, remove_comments=True))
    except etree.XMLSyntaxError as e:
        raise RuntimeError(f"This is not valid SVG/XML ({e})")

    def local(el):
        return etree.QName(el).localname if isinstance(el.tag, str) else ""

    # gradient id -> one representative colour (the average of its stops)
    grads = {}
    for el in root.iter():
        if local(el) in ("linearGradient", "radialGradient") and el.get("id"):
            cols = []
            for st in el.iter():
                if local(st) == "stop":
                    c = _color_of(st.get("stop-color"))
                    if not c:
                        m = re.search(r"stop-color\s*:\s*([^;]+)", st.get("style") or "")
                        c = _color_of(m.group(1)) if m else None
                    if c:
                        cols.append(c)
            if cols:
                grads[el.get("id")] = "#%02x%02x%02x" % tuple(sum(c[k] for c in cols) // len(cols) for k in range(3))

    def swap(value):
        def sub(m):
            return grads.get(m.group(1), "#808080")

        return re.sub(r"url\(\s*['\"]?#([^)'\"\s]+)['\"]?\s*\)", sub, value)

    for el in list(root.iter()):
        if not isinstance(el.tag, str):
            continue
        name = local(el)
        if name in ("script", "image", "filter", "mask", "foreignObject", "linearGradient", "radialGradient", "pattern"):
            el.getparent().remove(el) if el.getparent() is not None else None
            continue
        for attr in ("fill", "stroke"):
            if el.get(attr) and "url(" in el.get(attr):
                el.set(attr, swap(el.get(attr)))
        if el.get("style") and "url(" in el.get("style"):
            el.set("style", re.sub(r"(fill|stroke)\s*:\s*url\([^)]*\)", lambda m: f"{m.group(1)}:{swap(m.group(0).split(':', 1)[1].strip())}", el.get("style")))
        for attr in ("filter", "mask"):
            if attr in el.attrib:
                del el.attrib[attr]
        for attr in list(el.attrib):  # event handlers and script links: a drawing must never run code
            if attr.lower().startswith("on") or (str(el.attrib[attr]).strip().lower().startswith("javascript:")):
                del el.attrib[attr]
        if name == "path" and el.get("d"):
            el.set("d", normalize_path(el.get("d")))

    if local(root) != "svg":
        raise RuntimeError("The file does not start with an <svg> element")
    if not root.get("viewBox") and not (root.get("width") and root.get("height")):
        root.set("width", "512")
        root.set("height", "512")
    return etree.tostring(root, encoding="unicode")


def svg_to_eps(svg_path, eps_path, width_mm=None):
    from reportlab.graphics import renderPS
    from svglib.svglib import svg2rlg

    drawing = svg2rlg(svg_path)
    if drawing is None:
        raise RuntimeError("The SVG could not be read (is it well-formed?)")
    if not drawing.width or not drawing.height:
        raise RuntimeError("The SVG has no size (add a viewBox or width and height)")
    if width_mm:
        k = (float(width_mm) / 25.4 * 72.0) / drawing.width
        drawing.scale(k, k)
        drawing.width *= k
        drawing.height *= k
    renderPS.drawToFile(drawing, eps_path, showBoundary=0)
    with open(eps_path, "rb") as f:
        head = f.read(200)
    if not head.startswith(b"%!PS"):
        raise RuntimeError("The EPS file was not written correctly")


def main():
    with open(sys.argv[1], encoding="utf-8-sig") as f:
        spec = json.load(f)
    outdir = spec["outdir"]
    os.makedirs(outdir, exist_ok=True)
    svg_path = os.path.join(outdir, "out.svg")
    eps_path = os.path.join(outdir, "out.eps")

    if spec["action"] == "trace":
        emit({"type": "stage", "name": "tracing"})
        trace(spec, svg_path)
    elif spec["action"] == "convert":
        with open(spec["input"], encoding="utf-8") as f:
            text = clean_svg(f.read())
        with open(svg_path, "w", encoding="utf-8") as f:
            f.write(text)
    else:
        raise RuntimeError(f"Unknown action {spec['action']}")
    emit({"type": "file", "kind": "svg", "file": "out.svg"})

    emit({"type": "stage", "name": "converting"})
    svg_to_eps(svg_path, eps_path, spec.get("width_mm"))
    emit({"type": "file", "kind": "eps", "file": "out.eps"})
    emit({"type": "done"})


if __name__ == "__main__":
    try:
        main()
    except Exception as e:
        emit({"type": "error", "message": f"{type(e).__name__}: {e}"})
        sys.exit(1)
