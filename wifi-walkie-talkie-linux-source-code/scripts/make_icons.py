#!/usr/bin/env python3
"""
Generates the WiFi Walkie-Talkie application icons.

Everything is rasterised by hand (no image libraries required) and written as
PNG with zlib, so the build host needs nothing beyond a Python 3 interpreter.
Output goes to build/icons/ in the electron-builder layout.
"""

import math
import os
import struct
import zlib

OUT_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "build", "icons")
SIZES = [16, 24, 32, 48, 64, 128, 256, 512, 1024]
SS = 4  # supersampling factor


def lerp(a, b, t):
    return a + (b - a) * t


def mix(c1, c2, t):
    return tuple(int(round(lerp(c1[i], c2[i], t))) for i in range(3))


def rounded_rect_contains(x, y, x0, y0, x1, y1, r):
    """Point-in-rounded-rectangle test with corner radius r."""
    if x < x0 or x > x1 or y < y0 or y > y1:
        return False
    # Corner regions
    if x < x0 + r and y < y0 + r:
        return (x - (x0 + r)) ** 2 + (y - (y0 + r)) ** 2 <= r * r
    if x > x1 - r and y < y0 + r:
        return (x - (x1 - r)) ** 2 + (y - (y0 + r)) ** 2 <= r * r
    if x < x0 + r and y > y1 - r:
        return (x - (x0 + r)) ** 2 + (y - (y1 - r)) ** 2 <= r * r
    if x > x1 - r and y > y1 - r:
        return (x - (x1 - r)) ** 2 + (y - (y1 - r)) ** 2 <= r * r
    return True


def circle_contains(x, y, cx, cy, r):
    return (x - cx) ** 2 + (y - cy) ** 2 <= r * r


def sample(x, y, size):
    """Return an (r,g,b,a) tuple for a point in [0,size) space."""
    s = float(size)
    u = x / s
    v = y / s

    # --- background plate -------------------------------------------------
    radius = 0.22 * s
    if not rounded_rect_contains(x, y, 0, 0, s - 1, s - 1, radius):
        return (0, 0, 0, 0)

    grad = mix((37, 99, 235), (15, 23, 42), min(1.0, max(0.0, (u * 0.35 + v * 0.85))))
    color = grad

    # --- antenna ----------------------------------------------------------
    if rounded_rect_contains(x, y, 0.615 * s, 0.10 * s, 0.685 * s, 0.34 * s, 0.035 * s):
        color = (237, 242, 250)
        # antenna tip
        if rounded_rect_contains(x, y, 0.60 * s, 0.07 * s, 0.70 * s, 0.13 * s, 0.03 * s):
            color = (248, 250, 252)

    # --- radio body -------------------------------------------------------
    if rounded_rect_contains(x, y, 0.255 * s, 0.265 * s, 0.745 * s, 0.845 * s, 0.075 * s):
        color = (248, 250, 252)

        # screen
        if rounded_rect_contains(x, y, 0.325 * s, 0.355 * s, 0.675 * s, 0.505 * s, 0.03 * s):
            color = mix((30, 64, 175), (56, 130, 246), 0.25 * (1.0 - (v - 0.355) / 0.16))

        # speaker grille: 4 columns x 3 rows of dots
        cols, rows = 4, 3
        gx0, gy0 = 0.325, 0.565
        gx1, gy1 = 0.675, 0.745
        dx = (gx1 - gx0) / cols
        dy = (gy1 - gy0) / rows
        dot_r = min(dx, dy) * 0.30
        for c in range(cols):
            for r in range(rows):
                cx = (gx0 + dx * (c + 0.5)) * s
                cy = (gy0 + dy * (r + 0.5)) * s
                if circle_contains(x, y, cx, cy, dot_r * s):
                    color = (100, 116, 139)

        # push-to-talk button
        if rounded_rect_contains(x, y, 0.325 * s, 0.775 * s, 0.675 * s, 0.825 * s, 0.025 * s):
            color = (239, 68, 68)

    # --- subtle inner highlight on the plate ------------------------------
    if u * 0.5 + v * 0.5 < 0.28:
        color = mix(color, (255, 255, 255), 0.05)

    return (color[0], color[1], color[2], 255)


def render(size):
    """Render one icon at `size` px with 4x4 supersampling."""
    rows = []
    inv = 1.0 / (SS * SS)
    for py in range(size):
        row = bytearray()
        for px in range(size):
            r = g = b = a = 0.0
            for sy in range(SS):
                for sx in range(SS):
                    x = px + (sx + 0.5) / SS
                    y = py + (sy + 0.5) / SS
                    sr, sg, sb, sa = sample(x, y, size)
                    # premultiply so transparent edges do not bleed dark
                    r += sr * sa * inv
                    g += sg * sa * inv
                    b += sb * sa * inv
                    a += sa * inv
            if a > 0.0001:
                # un-premultiply
                r /= a
                g /= a
                b /= a
            row += bytes((int(round(min(255, max(0, r)))),
                          int(round(min(255, max(0, g)))),
                          int(round(min(255, max(0, b)))),
                          int(round(min(255, max(0, a * 255))))))
        rows.append(bytes(row))
    return rows


def write_png(path, size, rows):
    raw = b"".join(b"\x00" + r for r in rows)

    def chunk(tag, data):
        c = struct.pack(">I", len(data)) + tag + data
        return c + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF)

    png = b"\x89PNG\r\n\x1a\n"
    png += chunk(b"IHDR", struct.pack(">IIBBBBB", size, size, 8, 6, 0, 0, 0))
    png += chunk(b"IDAT", zlib.compress(raw, 9))
    png += chunk(b"IEND", b"")
    with open(path, "wb") as fh:
        fh.write(png)


def main():
    os.makedirs(OUT_DIR, exist_ok=True)
    for size in SIZES:
        rows = render(size)
        path = os.path.normpath(os.path.join(OUT_DIR, "%dx%d.png" % (size, size)))
        write_png(path, size, rows)
        print("wrote %s" % path)

    # electron-builder also looks for a generic icon.png / icon@2x.png
    import shutil
    shutil.copyfile(os.path.join(OUT_DIR, "512x512.png"),
                    os.path.join(OUT_DIR, "icon.png"))
    shutil.copyfile(os.path.join(OUT_DIR, "512x512.png"),
                    os.path.join(OUT_DIR, "icon@2x.png"))
    print("done")


if __name__ == "__main__":
    main()