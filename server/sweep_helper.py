"""Sweeps a round solid along the outline of one picture of a long object (a banana, a carrot, a bone).

Reads a spec file: {outdir, images: [png...], length_mm, object}
Picks the candidate picture with the cleanest single object, cuts it out, finds its centre line and thickness,
and writes outdir/out.stl (a watertight mesh, as long as length_mm along its own curve) and outdir/picture.png (the picture used).
Reports progress as JSON lines on stdout. Needs only numpy and PIL (already there with the image tools).
"""
import json, struct, sys
from collections import Counter

import numpy as np
from PIL import Image


def say(**kw):
    print(json.dumps(kw), flush=True)


def fail(msg):
    say(type="error", message=msg)
    sys.exit(1)


def components(mask):
    """4-neighbour connected components -> label image and sizes."""
    h, w = mask.shape
    lab = np.zeros((h, w), np.int32)
    sizes = {}
    n = 0
    for y in range(h):
        row = mask[y]
        for x in range(w):
            if row[x] and not lab[y, x]:
                n += 1
                lab[y, x] = n
                stack = [(y, x)]
                count = 0
                while stack:
                    cy, cx = stack.pop()
                    count += 1
                    for dy, dx in ((1, 0), (-1, 0), (0, 1), (0, -1)):
                        ny, nx = cy + dy, cx + dx
                        if 0 <= ny < h and 0 <= nx < w and mask[ny, nx] and not lab[ny, nx]:
                            lab[ny, nx] = n
                            stack.append((ny, nx))
                sizes[n] = count
    return lab, sizes


def opening(mask, n):
    """Erode then dilate n times with a plus-shaped neighbourhood (removes specks and thin bridges)."""
    def shift_and(m, op):
        out = m.copy()
        for dy, dx in ((1, 0), (-1, 0), (0, 1), (0, -1)):
            s = np.zeros_like(m)
            ys = slice(max(dy, 0), m.shape[0] + min(dy, 0)); yd = slice(max(-dy, 0), m.shape[0] + min(-dy, 0))
            xs = slice(max(dx, 0), m.shape[1] + min(dx, 0)); xd = slice(max(-dx, 0), m.shape[1] + min(-dx, 0))
            s[yd, xd] = m[ys, xs]
            out = (out & s) if op == "and" else (out | s)
        return out
    for _ in range(n):
        mask = shift_and(mask, "and")
    for _ in range(n):
        mask = shift_and(mask, "or")
    return mask


def closing(mask, n):
    """Dilate then erode n times: closes small gaps (a pale highlight inside the object)."""
    inv = ~mask
    return ~opening(inv, n)


def cut_out(path):
    """Returns (mask, score, why) for one picture; mask is None when the picture is not usable."""
    a = np.asarray(Image.open(path).convert("RGB")).astype(float)
    h, w, _ = a.shape
    # the background often shades from wall to table, so it is estimated row by row from the picture's left and right edges
    side = max(8, int(w * 0.03))
    bg = np.median(np.concatenate([a[:, :side], a[:, -side:]], axis=1), axis=1)  # one colour per row
    k = 25
    bg = np.stack([np.convolve(np.pad(bg[:, c], k // 2, mode="edge"), np.ones(k) / k, "valid") for c in range(3)], 1)
    dist = np.linalg.norm(a - bg[:, None, :], axis=2)
    # threshold halfway between "looks like the background" and "clearly something else" (Otsu on the distances)
    hist, edges = np.histogram(dist, bins=64, range=(0, dist.max() + 1e-6))
    total = hist.sum()
    best, thr = -1, 30.0
    csum = np.cumsum(hist * (edges[:-1] + edges[1:]) / 2)
    cnt = np.cumsum(hist)
    for i in range(1, 63):
        w0, w1 = cnt[i], total - cnt[i]
        if w0 == 0 or w1 == 0:
            continue
        m0, m1 = csum[i] / w0, (csum[-1] - csum[i]) / w1
        v = w0 * w1 * (m0 - m1) ** 2
        if v > best:
            best, thr = v, edges[i + 1]
    mask = dist > max(thr, 25.0)
    # anything clearly more colourful than the (grey) background is the object, even a pale highlight on it
    chroma = a.max(2) - a.min(2)
    mask |= (chroma - (bg.max(1) - bg.min(1))[:, None]) > 30
    # soft shadows are the background colour made a little darker: not part of the object
    pn = np.linalg.norm(a, axis=2) + 1e-6
    bn = np.linalg.norm(bg, axis=1)[:, None] + 1e-6
    cos = (a * bg[:, None, :]).sum(2) / (pn * bn)
    ratio = pn / bn
    mask &= ~((cos > 0.99) & (ratio > 0.3) & (ratio < 1.03))
    mask = closing(mask, 6)   # a pale highlight on the object can split it in two
    mask = opening(mask, 4)   # cuts thin bridges (a shadow edge, a hair of reflection) that join the object to other things
    # fill the holes: whatever the outside cannot reach is part of the object (a highlight that looks like the background)
    hole_lab, hole_sizes = components(~mask)
    outside = set(np.unique(np.concatenate([hole_lab[0], hole_lab[-1], hole_lab[:, 0], hole_lab[:, -1]]))) - {0}
    for k in hole_sizes:
        if k not in outside:
            mask |= hole_lab == k
    lab, sizes = components(mask)
    if not sizes:
        return None, 0, "nothing drawn"
    # things that run off the edge (a shelf, a table edge, a cropped object) are not the object
    edge = set(np.unique(np.concatenate([lab[0], lab[-1], lab[:, 0], lab[:, -1]]))) - {0}
    inner = {k: v for k, v in sizes.items() if k not in edge}
    if not inner:
        return None, 0, "the object touches the edge of the picture"
    main = max(inner, key=inner.get)
    area = inner[main]
    if area < 0.02 * h * w:
        return None, 0, "the object is too small"
    m = lab == main
    others = sum(1 for k, v in inner.items() if k != main and v > 0.15 * area)
    if others:
        return None, 0, "more than one object"
    ys, xs = np.nonzero(m)
    P = np.stack([xs, ys], 1).astype(float)
    ev = np.linalg.eigvalsh(np.cov((P - P.mean(0)).T))
    elong = float(np.sqrt(ev[1] / max(ev[0], 1e-6)))
    if elong < 2.2:
        return None, 0, "the object is not long and thin"
    # prefer a single, well-framed, clearly elongated object
    score = elong + 5 * (1 - abs(area / (h * w) - 0.12))
    return m, score, "ok"


def smooth(x, k):
    pad = k // 2
    if x.ndim == 1:
        return np.convolve(np.pad(x, pad, mode="edge"), np.ones(k) / k, "valid")
    return np.stack([smooth(x[:, i], k) for i in range(x.shape[1])], 1)


def tangents(sp):
    t = np.gradient(sp, axis=0)
    return t / np.maximum(np.linalg.norm(t, axis=1, keepdims=True), 1e-9)


def spine_and_width(m):
    ys, xs = np.nonzero(m)
    P = np.stack([xs, -ys], 1).astype(float)  # y up
    c = P.mean(0)
    _, _, Vt = np.linalg.svd(P - c, full_matrices=False)
    u = Vt[0] if Vt[0][0] >= 0 else -Vt[0]
    v = Vt[1]
    A = (P - c) @ u
    B = (P - c) @ v
    coef = np.polyfit(A, B, 4)
    K = 300
    a_s = np.linspace(A.min(), A.max(), K)
    spine = c + a_s[:, None] * u + np.polyval(coef, a_s)[:, None] * v
    H, W = m.shape

    def inside(x, y):
        xi = np.rint(x).astype(int)
        yi = np.rint(-y).astype(int)
        ok = (xi >= 0) & (xi < W) & (yi >= 0) & (yi < H)
        out = np.zeros(np.shape(x), bool)
        out[ok] = m[yi[ok], xi[ok]]
        return out

    offs = np.arange(0, 400, 0.5)
    wid = np.zeros(K)
    for _ in range(4):
        t = tangents(spine)
        n = np.stack([-t[:, 1], t[:, 0]], 1)
        mid = np.zeros(K)
        for k in range(K):
            reach = []
            for sign in (1, -1):
                ins = inside(spine[k, 0] + sign * offs * n[k, 0], spine[k, 1] + sign * offs * n[k, 1])
                # the edge is where the picture stays outside the object for 10 px in a row
                gap = 20
                outside = np.convolve((~ins).astype(float), np.ones(gap), "valid") >= gap
                run = int(np.argmax(outside)) if outside.any() else len(ins)
                last_in = np.nonzero(ins[:run])[0]
                reach.append(offs[last_in[-1]] if len(last_in) else 0.0)
            mid[k] = (reach[0] - reach[1]) / 2
            wid[k] = reach[0] + reach[1]
        spine = smooth(spine + 0.8 * mid[:, None] * n, 21)
        wid = smooth(wid, 31)
    return spine, wid


def build(spine, wid, length_mm):
    seg = np.linalg.norm(np.diff(spine, axis=0), axis=1)
    s = np.concatenate([[0], np.cumsum(seg)])
    L = s[-1]
    K2 = 220
    sn = np.linspace(0, L, K2)
    sp = np.stack([np.interp(sn, s, spine[:, 0]), np.interp(sn, s, spine[:, 1])], 1)
    r = np.maximum(np.interp(sn, s, wid) / 2, 0.5)
    t = tangents(sp)
    # round off both ends with a half-ellipse cap as long as the end is thick
    cap_rings = 10
    start_cap = []  # rings are (centre xy, radius, tangent)
    for i in range(cap_rings, 0, -1):
        f = i / cap_rings                       # 1 at the tip, towards 0 where the cap meets the body
        ext = r[0] * f
        rad = r[0] * np.sqrt(max(0.0, 1 - f * f)) if f < 1 else 0.0
        start_cap.append((sp[0] - t[0] * ext, max(rad, 0.3), t[0]))
    end_cap = []
    for i in range(1, cap_rings + 1):
        f = i / cap_rings
        ext = r[-1] * f
        rad = r[-1] * np.sqrt(max(0.0, 1 - f * f)) if f < 1 else 0.0
        end_cap.append((sp[-1] + t[-1] * ext, max(rad, 0.3), t[-1]))
    body = [(sp[k], r[k], t[k]) for k in range(K2)]
    rings = start_cap + body + end_cap
    M = 40
    th = np.linspace(0, 2 * np.pi, M, endpoint=False)
    V = []
    for c, rad, tk in rings:
        n = np.array([-tk[1], tk[0]])
        for j in range(M):
            V.append([c[0] + rad * np.cos(th[j]) * n[0], c[1] + rad * np.cos(th[j]) * n[1], rad * np.sin(th[j])])
    first, last = rings[0][0], rings[-1][0]
    V.append([first[0], first[1], 0.0])
    V.append([last[0], last[1], 0.0])
    V = np.array(V)
    c0, c1 = len(V) - 2, len(V) - 1
    R = len(rings)
    T = []
    for k in range(R - 1):
        for j in range(M):
            a, b = k * M + j, k * M + (j + 1) % M
            c_, d = (k + 1) * M + (j + 1) % M, (k + 1) * M + j
            T += [(a, b, c_), (a, c_, d)]
    for j in range(M):
        T.append((c0, (j + 1) % M, j))
        T.append((c1, (R - 1) * M + j, (R - 1) * M + (j + 1) % M))
    T = np.array(T)

    def volume(V, T):
        return np.einsum("ij,ij->i", V[T[:, 0]], np.cross(V[T[:, 1]], V[T[:, 2]])).sum() / 6

    if volume(V, T) < 0:
        T = T[:, ::-1]
    # watertight and consistently facing outward: every edge is used once in each direction
    e = Counter()
    for a, b, c_ in T:
        e[(a, b)] += 1
        e[(b, c_)] += 1
        e[(c_, a)] += 1
    bad = sum(1 for (a, b), cnt in e.items() if cnt != 1 or e.get((b, a), 0) != 1)
    if bad:
        fail("The solid could not be closed (%d open edges)" % bad)
    # lie flat on the build plate; the real length is measured along the object's own curve, end to end
    centres = np.array([c for c, _, _ in rings])
    along = float(np.linalg.norm(np.diff(centres, axis=0), axis=1).sum())
    V = V - V.min(0)
    V = V * (length_mm / along)
    return V, T


def write_stl(path, V, T):
    with open(path, "wb") as f:
        f.write(b"LLM Icarus (swept along the outline of a picture)".ljust(80, b" "))
        f.write(struct.pack("<I", len(T)))
        for a, b, c_ in T:
            p, q, w = V[a], V[b], V[c_]
            nn = np.cross(q - p, w - p)
            ln = np.linalg.norm(nn)
            nn = nn / ln if ln else nn
            f.write(struct.pack("<12fH", *nn, *p, *q, *w, 0))


def main():
    spec = json.load(open(sys.argv[1], encoding="utf-8"))
    out = spec["outdir"]
    images = spec["images"]
    say(type="stage", name="choosing the best picture")
    best = None
    reasons = []
    for i, p in enumerate(images):
        m, score, why = cut_out(p)
        if m is None:
            reasons.append(why)
            continue
        if best is None or score > best[0]:
            best = (score, m, p)
    if best is None:
        fail("The image model did not draw a clean picture of a single %s (%s). Try again, or describe it differently." % (spec.get("object", "object"), "; ".join(sorted(set(reasons))) or "no pictures"))
    _, m, picture = best
    Image.open(picture).convert("RGB").save(out + "/picture.png")
    say(type="file", kind="picture", file="picture.png")
    say(type="stage", name="measuring the outline")
    spine, wid = spine_and_width(m)
    say(type="stage", name="building the solid")
    V, T = build(spine, wid, float(spec["length_mm"]))
    write_stl(out + "/out.stl", V, T)
    size = [round(float(x), 1) for x in (V.max(0) - V.min(0))]
    say(type="file", kind="stl", file="out.stl")
    say(type="info", size=size, triangles=int(len(T)), note="Shape taken from a generated picture, so it is an approximation: round in cross-section, with the thickness measured from one side view")


if __name__ == "__main__":
    main()
