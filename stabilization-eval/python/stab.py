"""Background-stabilization approaches, emulated off-device.

All transforms are 3x3 in "data" pixels (frames stored at 960 px long side)
and map frame i's pixels onto frame 0's (the lock L_i).
Vision's VNTranslationalImageRegistrationRequest is emulated with
Hanning-windowed phase correlation (cv2.phaseCorrelate).
"""
import cv2
import numpy as np

I3 = np.eye(3)


def T(x, y):
    m = np.eye(3)
    m[0, 2], m[1, 2] = x, y
    return m


def warp(img, M, shape=None):
    h, w = shape or img.shape
    return cv2.warpPerspective(img, M, (w, h), flags=cv2.INTER_LINEAR,
                               borderMode=cv2.BORDER_CONSTANT, borderValue=0)


_win = {}


def _opt(n):
    """Largest size <= n that OpenCV's DFT doesn't pad (padding biases the
    peak by half a pixel)."""
    while cv2.getOptimalDFTSize(n) != n:
        n -= 1
    return n


def register(targeted, reference, integer=False):
    """Shift (as 3x3) mapping `targeted` onto `reference`, and the peak response."""
    h, w = reference.shape
    oh, ow = _opt(h), _opt(w)
    y0, x0 = (h - oh) // 2, (w - ow) // 2
    a = reference[y0:y0 + oh, x0:x0 + ow].astype(np.float32)
    b = targeted[y0:y0 + oh, x0:x0 + ow].astype(np.float32)
    key = a.shape
    if key not in _win:
        _win[key] = cv2.createHanningWindow((a.shape[1], a.shape[0]), cv2.CV_32F)
    (dx, dy), resp = cv2.phaseCorrelate(a, b, _win[key])
    if integer:
        dx, dy = round(dx), round(dy)
    return T(-dx, -dy), resp


def shift_only(M, c):
    """Translation that M applies at point c (what the app's shiftOf does)."""
    p = M @ np.array([c[0], c[1], 1.0])
    p = p[:2] / p[2]
    return T(p[0] - c[0], p[1] - c[1])


def fit_similarity(P, Q, w):
    """Weighted LSQ similarity Q ~ [a -b; b a] P + t, Tukey IRLS."""
    w0 = w.copy()
    m = None
    for _ in range(8):
        A = np.zeros((2 * len(P), 4))
        A[0::2] = np.c_[P[:, 0], -P[:, 1], np.ones(len(P)), np.zeros(len(P))]
        A[1::2] = np.c_[P[:, 1], P[:, 0], np.zeros(len(P)), np.ones(len(P))]
        bvec = Q.reshape(-1)
        W = np.repeat(w, 2)
        if W.sum() < 1e-6 or (w > 0).sum() < 3:
            return None
        sol = np.linalg.lstsq(A * W[:, None] ** 0.5, bvec * W ** 0.5, rcond=None)[0]
        a, b, tx, ty = sol
        m = np.array([[a, -b, tx], [b, a, ty], [0, 0, 1]])
        r = np.linalg.norm((A @ sol - bvec).reshape(-1, 2), axis=1)
        c = max(1.5, 3 * 1.4826 * np.median(r[w > 0]))
        w = w0 * np.where(r < c, (1 - (r / c) ** 2) ** 2, 0)
    return m


class Analyzer:
    """One pass over a clip, mirroring VideoStabilizer.m's analyze()."""

    def __init__(self, frames, *, scale=0.5, integer=False, tiles=None,
                 similarity=False, subject=None, keyframes=False, tile_scale=1.0, step_tiles=False, max_roll=None, gate=None):
        self.f = frames
        self.H, self.W = frames.shape[1:]
        self.scale = scale              # analysis size relative to data (0.5 => 480 px)
        self.integer = integer
        self.tiles = tiles              # (cols, rows) for tile registration, or None
        self.similarity = similarity
        self.subject = subject          # (cx, cy, half) box in frame-0 data px to skip
        self.keyframes = keyframes
        self.tile_scale = tile_scale
        self.step_tiles = step_tiles
        self.max_roll = max_roll
        self.gate = gate

    def small(self, img, s=None):
        s = s or self.scale
        if s == 1:
            return img
        return cv2.resize(img, None, fx=s, fy=s, interpolation=cv2.INTER_AREA)

    def S(self, s=None):
        s = s or self.scale
        return np.diag([s, s, 1.0])

    def reg_data(self, targeted, reference, s=None):
        """Register two data-size images at analysis scale; result in data px."""
        S = self.S(s)
        M, r = register(self.small(targeted, s), self.small(reference, s), self.integer)
        return np.linalg.inv(S) @ M @ S, r

    def tile_residual(self, aligned, cover, ref, similarity=None, subject=True):
        """Robust residual from tiles of `aligned` (frame warped into ref coords)."""
        cols, rows = self.tiles
        tw, th = (self.W // cols) // 4 * 4, (self.H // rows) // 4 * 4
        P, Q, w = [], [], []
        for j in range(rows):
            for i in range(cols):
                x0, y0 = i * tw, j * th
                if subject and self.subject is not None:
                    cx, cy, hs = self.subject
                    if x0 < cx + hs and x0 + tw > cx - hs and y0 < cy + hs and y0 + th > cy - hs:
                        continue
                if cover[y0:y0 + th, x0:x0 + tw].mean() < 0.95:
                    continue
                a = aligned[y0:y0 + th, x0:x0 + tw]
                b = ref[y0:y0 + th, x0:x0 + tw]
                tex = cv2.Laplacian(b, cv2.CV_32F).std()
                if tex < 1.0:
                    continue
                M, resp = self.reg_data(a, b, self.tile_scale)
                c = np.array([x0 + tw / 2, y0 + th / 2])
                P.append(c)
                Q.append(c + M[:2, 2])
                w.append(max(0.0, min(1.0, resp / 0.1)) * min(1.0, tex / 4))
        if len(P) < 2:
            return None
        P, Q, w = np.array(P), np.array(Q), np.array(w)
        if self.similarity if similarity is None else similarity:
            m = fit_similarity(P, Q, w)
            if m is not None and np.isfinite(m).all():
                ang = np.degrees(np.arctan2(m[1, 0], m[0, 0]))
                sc = np.hypot(m[0, 0], m[1, 0])
                if self.max_roll is None or (abs(ang) <= self.max_roll and abs(sc - 1) <= 0.01):
                    return m
        d = Q - P
        # weighted median shift
        med = np.array([np.median(d[:, 0]), np.median(d[:, 1])])
        return T(*med)

    def run(self):
        f = self.f
        n = len(f)
        c = (self.W / 2, self.H / 2)
        ones = np.ones((self.H, self.W), np.float32)
        steps, step_ok = [I3], [1.0]
        locks, lock_ok = [I3], [1.0]
        chain = I3.copy()
        kf_img, kf_lock = f[0], I3.copy()   # current reference and its lock
        for i in range(1, n):
            st, resp = self.reg_data(f[i], f[i - 1])
            if self.step_tiles:
                # predict with the previous step, then a tile median against frame i-1
                pred = steps[-1]
                al = warp(f[i], pred)
                tr = self.tile_residual(al, warp(ones, pred), f[i - 1], similarity=False, subject=False)
                if tr is not None:
                    st, resp = tr @ pred, 1.0
            steps.append(st)
            step_ok.append(1.0 if resp > 0.02 else 0.0)
            chain = chain @ st if resp > 0.02 else chain
            # residual against the reference (frame 0, or a keyframe)
            to_ref = np.linalg.inv(kf_lock) @ chain
            aligned = warp(f[i], to_ref)
            ok = 0.0
            if self.tiles:
                cover = warp(ones, to_ref)
                res = self.tile_residual(aligned, cover, kf_img)
                if res is not None and np.hypot(res[0, 2], res[1, 2]) < 0.2 * max(self.W, self.H):
                    chain = kf_lock @ res @ to_ref
                    ok = 1.0
            else:
                res, r = self.reg_data(aligned, kf_img)
                g = self.gate if self.gate is not None else 0.2 * max(self.W, self.H)
                if np.hypot(res[0, 2], res[1, 2]) < g:
                    chain = kf_lock @ res @ to_ref
                    ok = 1.0
            if self.keyframes:
                # Overlap of this frame with the reference; move the reference on
                # once less than 70% of the frame still overlaps it.
                to_ref = np.linalg.inv(kf_lock) @ chain
                cover = warp(ones, to_ref).mean()
                if cover < 0.7 and ok:
                    kf_img, kf_lock = f[i], chain.copy()
            if not self.similarity:
                chain = shift_only(chain, c)
            locks.append(chain.copy())
            lock_ok.append(ok)
        return dict(steps=steps, step_ok=np.array(step_ok), locks=locks,
                    lock_ok=np.array(lock_ok))


def fuse(analysis, lam, center):
    """Proposal A: least squares over the steps (relative) and the locks
    (absolute). Fuses translation about the frame center; rotation/scale of
    each lock is kept."""
    locks, steps = analysis["locks"], analysis["steps"]
    n = len(locks)
    c = np.array([center[0], center[1], 1.0])
    # translation each lock applies at the center
    t = np.array([(L @ c)[:2] - c[:2] for L in locks])
    d = np.array([s[:2, 2] for s in steps])
    ws = analysis["step_ok"]
    wl = analysis["lock_ok"] * lam
    wl[0] = 1e6   # frame 0 is the reference
    # tridiagonal normal equations, per axis
    A = np.zeros((n, n))
    for i in range(n):
        A[i, i] += wl[i]
    for i in range(1, n):
        A[i, i] += ws[i]
        A[i - 1, i - 1] += ws[i]
        A[i, i - 1] -= ws[i]
        A[i - 1, i] -= ws[i]
    out = []
    X = np.zeros((n, 2))
    for ax in range(2):
        b = wl * t[:, ax]
        for i in range(1, n):
            b[i] += ws[i] * d[i, ax]
            b[i - 1] -= ws[i] * d[i, ax]
        X[:, ax] = np.linalg.solve(A, b)
    for L, x, t0 in zip(locks, X, t):
        out.append(T(*(x - t0)) @ L)
    return out


def fuse_robust(analysis, lam, center, c_px=4.0, iters=6):
    """A, robust: lock readings that disagree with the step-chained path by
    more than ~c_px are down-weighted (Tukey), so a reading that jumps to a
    different depth plane or a wrong peak is dropped instead of averaged in."""
    a = dict(analysis)
    base_ok = analysis["lock_ok"].copy()
    w = base_ok.copy()
    c = np.array([center[0], center[1], 1.0])
    t = np.array([(L @ c)[:2] - c[:2] for L in analysis["locks"]])
    out = None
    for k in range(iters):
        a["lock_ok"] = w
        out = fuse(a, lam, center)
        x = np.array([(L @ c)[:2] - c[:2] for L in out])
        r = np.linalg.norm(x - t, axis=1)
        # start loose, tighten to c_px
        cc = max(c_px, 64.0 / (2 ** k))
        w = base_ok * np.where(r < cc, (1 - (r / cc) ** 2) ** 2, 0)
    return out
