"""Parser tests, built on a synthetic CR3 so they need no sample file."""

import os
import struct
import sys

import pytest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from craw.cr3 import (CANON_UUID, Cr3, LensCorrectionPacket, ctmd_exif_tags,
                      ctmd_records, find_boxes, parse_tiff)

SAMPLE = os.environ.get("CRAW_SAMPLE")


def box(kind: bytes, payload: bytes) -> bytes:
    return struct.pack(">I", len(payload) + 8) + kind + payload


def tiff_block(entries) -> bytes:
    """entries: [(tag, type, count, payload_bytes)] - values are appended after
    the IFD and referenced by offset when they don't fit inline."""
    head = b"II*\x00" + struct.pack("<I", 8)
    ifd = struct.pack("<H", len(entries))
    tail = b""
    data_off = 8 + 2 + 12 * len(entries) + 4
    for tag, typ, count, payload in entries:
        if len(payload) <= 4:
            value = payload.ljust(4, b"\x00")
        else:
            value = struct.pack("<I", data_off + len(tail))
            tail += payload
        ifd += struct.pack("<HHI", tag, typ, count) + value
    ifd += struct.pack("<I", 0)
    return head + ifd + tail


def lens_packet(n_knots=15) -> bytes:
    """A packet shaped like Canon's: header, falloff curve, knot radii."""
    vals = [0] * 64
    vals[0] = 0                      # version
    vals[1] = 1500
    falloff = [8191 - int(2000 * (i / (n_knots - 1)) ** 2) for i in range(n_knots)]
    knots = [int(4095 * (i + 1) / (n_knots - 1)) for i in range(n_knots - 1)]
    body = vals + falloff + [0] * 100 + knots + [0] * 40
    body += [0] * (750 - len(body))
    return struct.pack("<750h", *body)


def ctmd_sample(packet: bytes) -> bytes:
    inner = tiff_block([(0x4015, 7, len(packet), packet)])
    exif = struct.pack("<IHH", len(inner) + 8, 0x927C, 0) + inner
    record9 = b"\x01\x01\x02\x01\xff\xff" + exif
    return struct.pack("<IH", len(record9) + 6, 9) + record9


def build_cr3(tmp_path) -> str:
    packet = lens_packet()
    sample = ctmd_sample(packet)

    cmt1 = tiff_block([(0x010F, 2, 6, b"Canon\x00"),
                       (0x0110, 2, 14, b"Canon EOS R8\x00\x00")])
    cmt2 = tiff_block([(0x920A, 5, 1, struct.pack("<II", 42, 1)),
                       (0x829D, 5, 1, struct.pack("<II", 16, 1)),
                       (0x8827, 3, 1, struct.pack("<H", 200))])
    sensor = struct.pack("<9h", 18, 6188, 4120, 0, 0, 168, 108, 6167, 4107)
    aspect = struct.pack("<5I", 0, 6000, 4000, 0, 0)
    vc2 = struct.pack("<11i", 44, 0, 0, 0, 0, 1, 1, 0, 0, 1, 0)
    cmt3 = tiff_block([(0x0095, 2, 10, b"RF50 F1.2\x00"),
                       (0x00E0, 7, len(sensor), sensor),
                       (0x009A, 7, len(aspect), aspect),
                       (0x4016, 7, len(vc2), vc2)])

    uuid_payload = CANON_UUID + box(b"CMT1", cmt1) + box(b"CMT2", cmt2) + \
        box(b"CMT3", cmt3)
    stsd = box(b"stsd", struct.pack(">III", 0, 1, 16) + b"CTMD")
    stsz = box(b"stsz", struct.pack(">III", 0, len(sample), 1))
    stbl = box(b"stbl", stsd + stsz + box(b"co64", struct.pack(">I", 0) +
                                          struct.pack(">IQ", 1, 0)))
    trak = box(b"trak", box(b"mdia", box(b"minf", stbl)))
    moov = box(b"moov", box(b"uuid", uuid_payload) + trak)

    head = box(b"ftyp", b"crx isom")
    mdat_header_len = 8
    offset = len(head) + len(moov) + mdat_header_len
    # patch the sample offset now that the layout is known
    stbl = box(b"stbl", stsd + stsz + box(b"co64", struct.pack(">I", 0) +
                                          struct.pack(">IQ", 1, offset)))
    trak = box(b"trak", box(b"mdia", box(b"minf", stbl)))
    moov = box(b"moov", box(b"uuid", uuid_payload) + trak)

    path = str(tmp_path / "synthetic.CR3")
    with open(path, "wb") as fh:
        fh.write(head + moov + box(b"mdat", sample))
    return path


def test_boxes_and_tiff(tmp_path):
    path = build_cr3(tmp_path)
    buf = open(path, "rb").read()
    assert find_boxes(buf, "moov/uuid")
    tags = parse_tiff(buf, find_boxes(buf, "moov/uuid")[0][0] + 16 + 8)
    assert tags[0x0110] == "Canon EOS R8"


def test_metadata(tmp_path):
    cr3 = Cr3(build_cr3(tmp_path))
    assert cr3.camera == "Canon EOS R8"
    assert cr3.lens == "RF50 F1.2"
    assert cr3.focal_length == 42.0
    assert cr3.f_number == 16.0
    assert cr3.iso == 200
    s = cr3.settings
    assert s.peripheral_lighting == 1 and s.chromatic_aberration == 1
    assert s.distortion == 0


def test_geometry(tmp_path):
    g = Cr3(build_cr3(tmp_path)).geometry
    assert (g.active_width, g.active_height) == (6000, 4000)
    assert g.optical_centre == (3000.0, 2000.0)


def test_ctmd_and_packet(tmp_path):
    path = build_cr3(tmp_path)
    buf = open(path, "rb").read()
    records = ctmd_records(buf)
    assert 9 in records
    assert 0x4015 in ctmd_exif_tags(records[9])
    packet = Cr3(path).packet
    assert packet is not None
    falloff = packet.falloff
    assert falloff is not None
    assert falloff.values[0] == pytest.approx(1.0, abs=1e-3)
    assert falloff.values[-1] < falloff.values[0]
    assert falloff.radii[0] == 0.0
    assert falloff.radii[-1] == pytest.approx(1.0, abs=0.01)


def test_packet_rejects_short_blob():
    assert LensCorrectionPacket.parse(b"\x00" * 16) is None


@pytest.mark.skipif(not SAMPLE, reason="set CRAW_SAMPLE to a real CR3")
def test_real_sample():
    cr3 = Cr3(SAMPLE)
    assert cr3.camera and cr3.lens
    assert cr3.geometry.optical_centre is not None
    assert cr3.packet and cr3.packet.falloff
