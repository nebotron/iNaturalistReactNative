"""Reader for Canon CR3 files (including C-RAW / compressed raw).

CR3 is an ISO base media (BMFF) container.  Everything this module needs lives
in two places:

  moov/uuid(85c0b687-820f-11e0-8111-f4ce462b6a48)/CMT1..CMT4
      Four TIFF blocks: IFD0, ExifIFD, Canon MakerNote, GPS.

  the CTMD track ("Canon Timed MetaData") in mdat
      Per-frame records.  Record type 9 wraps a small TIFF block whose
      MakerNote holds the lens correction packet (Canon tag 0x4015, called
      VignettingCorr by ExifTool) that the camera copied out of the lens for
      this exposure.

Field offsets for the Canon binary blocks follow ExifTool's Canon.pm; the
layout of the correction curves inside 0x4015 is not publicly documented, so
`LensCorrectionPacket` finds them structurally instead of by fixed offset (see
`_scan_curves`).
"""

from __future__ import annotations

import struct
from dataclasses import dataclass, field
from typing import Any, Dict, Iterator, List, Optional, Tuple

CANON_UUID = bytes.fromhex("85c0b687820f11e08111f4ce462b6a48")

# TIFF type -> (struct code, byte size)
_TIFF_TYPES = {
    1: ("B", 1), 2: ("s", 1), 3: ("H", 2), 4: ("I", 4), 5: ("II", 8),
    6: ("b", 1), 7: ("s", 1), 8: ("h", 2), 9: ("i", 4), 10: ("ii", 8),
    11: ("f", 4), 12: ("d", 8),
}


# --------------------------------------------------------------------------
# BMFF
# --------------------------------------------------------------------------
def iter_boxes(buf: bytes, start: int, end: int) -> Iterator[Tuple[str, int, int, int]]:
    """Yield (type, offset, size, header_size) for the boxes in [start, end)."""
    pos = start
    while pos + 8 <= end:
        size = struct.unpack_from(">I", buf, pos)[0]
        typ = buf[pos + 4:pos + 8].decode("latin1")
        hsize = 8
        if size == 1:
            size = struct.unpack_from(">Q", buf, pos + 8)[0]
            hsize = 16
        elif size == 0:
            size = end - pos
        if size < hsize or pos + size > end:
            return
        yield typ, pos, size, hsize
        pos += size


def find_boxes(buf: bytes, path: str, start: int = 0,
               end: Optional[int] = None) -> List[Tuple[int, int]]:
    """Resolve a slash-separated box path to a list of (payload_start, end)."""
    cur = [(start, len(buf) if end is None else end)]
    for name in path.split("/"):
        nxt = []
        for s, e in cur:
            for typ, pos, size, hsize in iter_boxes(buf, s, e):
                if typ == name:
                    nxt.append((pos + hsize, pos + size))
        cur = nxt
    return cur


# --------------------------------------------------------------------------
# TIFF / IFD
# --------------------------------------------------------------------------
def _read_values(buf: bytes, base: int, endian: str, typ: int, count: int,
                 value_off: int) -> Any:
    code, size = _TIFF_TYPES.get(typ, ("B", 1))
    total = size * count
    if total <= 4:
        raw = buf[value_off:value_off + total]
    else:
        off = struct.unpack_from(endian + "I", buf, value_off)[0] + base
        raw = buf[off:off + total]
    if len(raw) < total:
        raise struct.error("truncated value")
    if typ == 2:
        return raw.split(b"\0")[0].decode("latin1", "replace")
    if typ == 7:
        return raw
    vals = struct.unpack(endian + code * count, raw)
    if typ in (5, 10):  # rationals arrive as numerator/denominator pairs
        vals = tuple(vals[i] / vals[i + 1] if vals[i + 1] else 0.0
                     for i in range(0, len(vals), 2))
    return vals[0] if len(vals) == 1 else vals


def parse_ifd(buf: bytes, base: int, ifd_off: int, endian: str) -> Dict[int, Any]:
    """Parse one IFD.  `base` is the offset the IFD's pointers are relative to."""
    out: Dict[int, Any] = {}
    if ifd_off + 2 > len(buf):
        return out
    n = struct.unpack_from(endian + "H", buf, ifd_off)[0]
    for i in range(n):
        e = ifd_off + 2 + 12 * i
        if e + 12 > len(buf):
            break
        tag, typ, count = struct.unpack_from(endian + "HHI", buf, e)
        try:
            out[tag] = _read_values(buf, base, endian, typ, count, e + 8)
        except (struct.error, IndexError):
            continue
    return out


def parse_tiff(buf: bytes, base: int = 0) -> Dict[int, Any]:
    """Parse a TIFF header + its first IFD out of `buf` starting at `base`."""
    if len(buf) < base + 8:
        return {}
    endian = "<" if buf[base:base + 2] == b"II" else ">"
    first = struct.unpack_from(endian + "I", buf, base + 4)[0]
    return parse_ifd(buf, base, base + first, endian)


def _ints(blob: Any, fmt: str = "<h") -> List[int]:
    """Canon binary blocks arrive either as raw bytes or as an already-typed
    array, depending on how the tag was written; normalise both to ints."""
    if isinstance(blob, (tuple, list)):
        return [int(x) for x in blob]
    if not isinstance(blob, (bytes, bytearray)):
        return []
    size = struct.calcsize(fmt)
    return [struct.unpack_from(fmt, blob, i)[0]
            for i in range(0, len(blob) - size + 1, size)]


def _at(blob: Any, index: int, fmt: str = "<h") -> Optional[int]:
    """Canon binary-data blocks are arrays whose element 0 is the block size."""
    vals = _ints(blob, fmt)
    return vals[index] if 0 <= index < len(vals) else None


# --------------------------------------------------------------------------
# CTMD (per-frame metadata living in mdat)
# --------------------------------------------------------------------------
def _sample_table(buf: bytes, trak: Tuple[int, int]) -> List[Tuple[int, int]]:
    ts, te = trak
    stsz = find_boxes(buf, "mdia/minf/stbl/stsz", ts, te)
    if not stsz:
        return []
    s, _ = stsz[0]
    sample_size, count = struct.unpack_from(">II", buf, s + 4)
    sizes = ([sample_size] * count if sample_size else
             [struct.unpack_from(">I", buf, s + 12 + 4 * i)[0] for i in range(count)])
    co64 = find_boxes(buf, "mdia/minf/stbl/co64", ts, te)
    if co64:
        c, _ = co64[0]
        n = struct.unpack_from(">I", buf, c + 4)[0]
        offs = [struct.unpack_from(">Q", buf, c + 8 + 8 * i)[0] for i in range(n)]
    else:
        stco = find_boxes(buf, "mdia/minf/stbl/stco", ts, te)
        if not stco:
            return []
        c, _ = stco[0]
        n = struct.unpack_from(">I", buf, c + 4)[0]
        offs = [struct.unpack_from(">I", buf, c + 8 + 4 * i)[0] for i in range(n)]
    return list(zip(offs, sizes))


def ctmd_records(buf: bytes) -> Dict[int, bytes]:
    """Return {record_type: payload} for the first sample of the CTMD track."""
    out: Dict[int, bytes] = {}
    for trak in find_boxes(buf, "moov/trak"):
        stsd = find_boxes(buf, "mdia/minf/stbl/stsd", *trak)
        if not stsd or buf[stsd[0][0] + 12:stsd[0][0] + 16] != b"CTMD":
            continue
        for off, size in _sample_table(buf, trak):
            sample = buf[off:off + size]
            pos = 0
            while pos + 6 <= len(sample):
                rsize, rtype = struct.unpack_from("<IH", sample, pos)
                if rsize < 6 or pos + rsize > len(sample):
                    break
                out.setdefault(rtype, sample[pos + 6:pos + rsize])
                pos += rsize
    return out


def ctmd_exif_tags(payload: bytes) -> Dict[int, Any]:
    """Parse a CTMD record of the 'ExifInfo' flavour (types 7, 8, 9).

    Layout: 6 bytes of record header, then {uint32 size, uint16 tag, uint16 pad}
    followed by a self-contained TIFF block.
    """
    if len(payload) < 16:
        return {}
    size, tag = struct.unpack_from("<IH", payload, 6)
    if tag != 0x927C or payload[14:16] not in (b"II", b"MM"):
        return {}
    return parse_tiff(payload[14:])


# --------------------------------------------------------------------------
# Lens correction packet (Canon MakerNote tag 0x4015, per exposure)
# --------------------------------------------------------------------------
GAIN_ONE = 16384.0          # fixed-point 1.0 used by the geometry/gain curves
TRANSMISSION_ONE = 8191.0   # fixed-point 1.0 used by the falloff curve


@dataclass
class Curve:
    """One correction curve found inside the lens packet.

    `radii` are normalised so 1.0 is the curve's outermost sample, which is
    taken to be the frame corner. The knots are in some absolute unit that is
    not documented and is not the same on every body — the samples end at 4095
    (EOS R8, and 4095 = 2**12-1 looks like a clamp), 4543 (R6) and 2934 (R7) —
    so normalising each curve by its own last knot is the only mapping that
    holds across all three.
    """
    kind: str                 # "falloff" | "gain"
    offset: int               # byte offset within the packet
    values: List[float]       # normalised to 1.0
    radii: List[float]        # normalised radius per value (0 == centre)
    raw: List[int] = field(repr=False, default_factory=list)
    knots: List[int] = field(repr=False, default_factory=list)


def _runs(vals: List[int], ok) -> Iterator[Tuple[int, List[int]]]:
    i = 0
    while i < len(vals):
        if not ok(vals[i]):
            i += 1
            continue
        j = i
        while j < len(vals) and ok(vals[j]):
            j += 1
        yield i, vals[i:j]
        i = j


def _scan_curves(blob: bytes) -> List[Curve]:
    """Locate the correction curves in the packet.

    Canon does not document this block and its field offsets move between
    bodies, so the curves are found by shape instead:

      * a knot table is a rising run of radii, spaced from near zero out to
        the frame corner (the value it ends at differs per body),
      * a falloff (peripheral illumination) curve starts at 8191 and decays,
      * a geometry/gain curve starts at 16384 and stays near it.

    Each curve is paired with the knot table closest to it in the blob.
    """
    v = _ints(blob)
    knots: List[Tuple[int, List[int]]] = []
    for i, run in _runs(v, lambda x: 0 < x < 8000):
        if (
            len(run) >= 8
            and all(b > a for a, b in zip(run, run[1:]))
            # A radius ramp starts near the centre and runs out to the corner,
            # which is what separates it from any other rising run of numbers.
            and run[0] * 3 < run[-1]
        ):
            knots.append((i, run))

    curves: List[Curve] = []
    for i, run in _runs(v, lambda x: 1500 <= x <= 8191):
        if len(run) >= 6 and run[0] >= 8000 and all(b <= a for a, b in zip(run, run[1:])):
            curves.append(Curve("falloff", i * 2,
                                [x / TRANSMISSION_ONE for x in run], [], list(run)))
    for i, run in _runs(v, lambda x: 12000 <= x <= 21000):
        if len(run) >= 6 and run[0] == int(GAIN_ONE):
            curves.append(Curve("gain", i * 2,
                                [x / GAIN_ONE for x in run], [], list(run)))

    for c in curves:
        start = c.offset // 2
        best = None
        for ki, krun in knots:
            if len(krun) not in (len(c.values), len(c.values) - 1):
                continue
            d = abs(ki - start)
            if best is None or d < best[0]:
                best = (d, krun)
        if best:
            krun = best[1]
            scale = float(krun[-1])
            rad = [0.0] + [k / scale for k in krun] \
                if len(krun) == len(c.values) - 1 else [k / scale for k in krun]
            c.radii = rad[:len(c.values)]
            c.knots = list(krun)
    return curves


@dataclass
class LensCorrectionPacket:
    """Canon tag 0x4015 for this exposure."""
    version: int
    size: int
    header: List[int] = field(repr=False, default_factory=list)
    curves: List[Curve] = field(default_factory=list)

    @classmethod
    def parse(cls, blob: bytes) -> Optional["LensCorrectionPacket"]:
        if len(blob) < 64:
            return None
        head = _ints(blob[:64])
        return cls(version=blob[0], size=head[1] if len(head) > 1 else len(blob),
                   header=head, curves=_scan_curves(blob))

    @property
    def falloff(self) -> Optional[Curve]:
        for c in self.curves:
            if c.kind == "falloff" and c.radii:
                return c
        return None


# --------------------------------------------------------------------------
# File-level view
# --------------------------------------------------------------------------
OFF_ON = {0: "Off", 1: "On"}


@dataclass
class Geometry:
    """Frame geometry, in sensor (raw) pixel coordinates."""
    sensor_width: Optional[int] = None
    sensor_height: Optional[int] = None
    active_left: Optional[int] = None
    active_top: Optional[int] = None
    active_width: Optional[int] = None
    active_height: Optional[int] = None
    crop_left: int = 0
    crop_top: int = 0
    crop_width: Optional[int] = None
    crop_height: Optional[int] = None
    aspect: Optional[int] = None

    @property
    def optical_centre(self) -> Optional[Tuple[float, float]]:
        """Optical axis in cropped-image coordinates (x, y).

        With an in-camera aspect/APS-C crop the frame centre is not the axis,
        so the centre of the full active area is expressed relative to the
        crop origin.
        """
        if self.active_width is None or self.crop_width is None:
            return None
        return (self.active_width / 2.0 - self.crop_left,
                self.active_height / 2.0 - self.crop_top)


@dataclass
class CorrectionSettings:
    """What the camera was told to correct (from MakerNote 0x4016 / 0x4018)."""
    peripheral_lighting: Optional[int] = None
    chromatic_aberration: Optional[int] = None
    distortion: Optional[int] = None
    digital_lens_optimizer: Optional[int] = None
    peripheral_illumination_applied: Optional[int] = None

    def describe(self) -> Dict[str, str]:
        return {k: OFF_ON.get(v, "n/a") for k, v in self.__dict__.items()}


class Cr3:
    """A parsed CR3 file.  Raw pixels are left to LibRaw; this is metadata."""

    def __init__(self, path: str):
        self.path = path
        with open(path, "rb") as fh:
            self._buf = fh.read()
        if self._buf[4:8] != b"ftyp":
            raise ValueError(f"{path}: not an ISO-BMFF file")
        self.ifd0: Dict[int, Any] = {}
        self.exif: Dict[int, Any] = {}
        self.makernote: Dict[int, Any] = {}
        self._read_cmt()
        self.packet = self._read_packet()

    # -- metadata blocks ---------------------------------------------------
    def _read_cmt(self) -> None:
        for start, end in find_boxes(self._buf, "moov/uuid"):
            if self._buf[start:start + 16] != CANON_UUID:
                continue
            for typ, pos, size, hsize in iter_boxes(self._buf, start + 16, end):
                if typ not in ("CMT1", "CMT2", "CMT3", "CMT4"):
                    continue
                block = self._buf[pos + hsize:pos + size]
                tags = parse_tiff(block)
                if typ == "CMT1":
                    self.ifd0 = tags
                elif typ == "CMT2":
                    self.exif = tags
                elif typ == "CMT3":
                    self.makernote = tags

    def _read_packet(self) -> Optional[LensCorrectionPacket]:
        for rtype, payload in sorted(ctmd_records(self._buf).items()):
            tags = ctmd_exif_tags(payload)
            blob = tags.get(0x4015)
            if isinstance(blob, (bytes, bytearray)) and len(blob) > 64:
                packet = LensCorrectionPacket.parse(bytes(blob))
                if packet and packet.curves:
                    return packet
        return None

    # -- convenience accessors --------------------------------------------
    @property
    def camera(self) -> str:
        return str(self.ifd0.get(0x0110, "")).strip()

    @property
    def lens(self) -> str:
        return str(self.makernote.get(0x0095) or self.exif.get(0xA434) or "").strip()

    @property
    def focal_length(self) -> Optional[float]:
        v = self.exif.get(0x920A)
        return float(v) if v is not None else None

    @property
    def f_number(self) -> Optional[float]:
        v = self.exif.get(0x829D)
        return float(v) if v is not None else None

    @property
    def iso(self) -> Optional[int]:
        v = self.exif.get(0x8827)
        return int(v[0] if isinstance(v, tuple) else v) if v is not None else None

    @property
    def settings(self) -> CorrectionSettings:
        vc2, lop = self.makernote.get(0x4016), self.makernote.get(0x4018)
        return CorrectionSettings(
            peripheral_lighting=_at(vc2, 5, "<i"),
            chromatic_aberration=_at(vc2, 6, "<i"),
            distortion=_at(vc2, 7, "<i"),
            digital_lens_optimizer=_at(vc2, 9, "<i"),
            peripheral_illumination_applied=_at(lop, 1, "<i"),
        )

    @property
    def geometry(self) -> Geometry:
        si, ai = self.makernote.get(0x00E0), self.makernote.get(0x009A)
        g = Geometry()
        if si is not None:
            g.sensor_width, g.sensor_height = _at(si, 1), _at(si, 2)
            left, top = _at(si, 5), _at(si, 6)
            right, bottom = _at(si, 7), _at(si, 8)
            if None not in (left, top, right, bottom):
                g.active_left, g.active_top = left, top
                g.active_width, g.active_height = right - left + 1, bottom - top + 1
        if ai is not None:
            g.aspect = _at(ai, 0, "<I")
            g.crop_width, g.crop_height = _at(ai, 1, "<I"), _at(ai, 2, "<I")
            g.crop_left, g.crop_top = _at(ai, 3, "<I") or 0, _at(ai, 4, "<I") or 0
        if g.crop_width is None:
            g.crop_width, g.crop_height = g.active_width, g.active_height
        return g
