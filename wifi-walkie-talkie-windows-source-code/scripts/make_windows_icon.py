#!/usr/bin/env python3
"""
Generates build/icon.ico for the Windows build.

Windows needs a real multi-resolution .ico (Explorer, the taskbar, the Start menu
and the Alt-Tab switcher all pick a different entry), so this writes a classic
32-bit BGRA DIB icon rather than the PNG-only variant:

    ICONDIR (6 bytes)
    ICONDIRENTRY (16 bytes each)
    per size: BITMAPINFOHEADER (40 bytes) + bottom-up XOR bitmap + AND mask

DIB entries are used on purpose. Some of the resource-editing tools used by the
Windows packaging pipeline (rcedit, and older NSIS icon plugins) cannot parse
PNG-compressed icon entries, while every Windows version since Vista reads DIB
entries without complaint.

Pixel data is shared with scripts/make_icons.py, so the .exe icon and the .png
set are guaranteed to be the same artwork.
"""

import os
import struct
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from make_icons import render  # noqa: E402  (same directory, path set above)

OUT_PATH = os.path.normpath(
    os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "build", "icon.ico")
)

# Windows renders these sizes; 256 is the one users see in large views.
SIZES = [16, 24, 32, 48, 64, 128, 256]


def rows_to_bgra_dib(size, rows):
    """Return BITMAPINFOHEADER + XOR (bottom-up BGRA) + AND mask for one size.

    `rows` comes from make_icons.render(): a list of RGBA byte strings, each
    exactly 4 * size bytes long, top row first.
    """
    xor = bytearray()
    for row in reversed(rows):  # DIBs are stored bottom-up
        for x in range(size):
            r, g, b, a = row[x * 4], row[x * 4 + 1], row[x * 4 + 2], row[x * 4 + 3]
            xor += bytes((b, g, r, a))

    # A fully opaque AND mask; the alpha channel does the real work.
    and_stride = ((size + 31) // 32) * 4
    and_mask = bytes(and_stride * size)

    header = struct.pack(
        "<IiiHHIIiiII",
        40,          # biSize
        size,        # biWidth
        size * 2,    # biHeight (XOR + AND stacked)
        1,           # biPlanes
        32,          # biBitCount
        0,           # biCompression = BI_RGB
        len(xor) + len(and_mask),
        0, 0, 0, 0,
    )
    return header + bytes(xor) + and_mask


def main():
    images = []
    for size in SIZES:
        rows = render(size)
        for row in rows:
            if len(row) != size * 4:
                raise ValueError("row width mismatch: %d bytes, expected %d" % (len(row), size * 4))
        images.append((size, rows_to_bgra_dib(size, rows)))
        print("rendered %dx%d" % (size, size))

    count = len(images)
    header = struct.pack("<HHH", 0, 1, count)  # reserved, type=icon(1), count

    offset = 6 + 16 * count
    directory = bytearray()
    body = bytearray()
    for size, data in images:
        directory += struct.pack(
            "<BBBBHHII",
            0 if size >= 256 else size,  # 0 means 256 in the ICO format
            0 if size >= 256 else size,
            0,        # colour count (0 = >8bpp)
            0,        # reserved
            1,        # planes
            32,       # bits per pixel
            len(data),
            offset,
        )
        body += data
        offset += len(data)

    os.makedirs(os.path.dirname(OUT_PATH), exist_ok=True)
    with open(OUT_PATH, "wb") as fh:
        fh.write(header + bytes(directory) + bytes(body))

    print("wrote %s (%d bytes, %d sizes)" % (OUT_PATH, os.path.getsize(OUT_PATH), count))


if __name__ == "__main__":
    main()