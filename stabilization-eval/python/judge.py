"""Independent judge: dense DIS optical flow on the stabilized frames.

hold   = how far textured background pixels sit from where they were on
         frame 0 (what "lock to the first frame" promises).
jitter = how far they move between consecutive stabilized frames (the shake
         a viewer notices).
Both: per frame, mean |flow| over valid pixels after dropping the worst 25%
(leaves, the subject's edges), then RMS over frames. Reported in source px
(data px x 2).
"""
import cv2
import numpy as np

dis = cv2.DISOpticalFlow_create(cv2.DISOPTICAL_FLOW_PRESET_MEDIUM)


def flow_pair(a, b):
    f = dis.calc(a, b, None)
    g = dis.calc(b, a, None)
    h, w = a.shape
    xx, yy = np.meshgrid(np.arange(w, dtype=np.float32), np.arange(h, dtype=np.float32))
    gb = cv2.remap(g, xx + f[..., 0], yy + f[..., 1], cv2.INTER_LINEAR)
    fb = np.linalg.norm(f + gb, axis=2)
    return f, fb


def texture_mask(img):
    g = cv2.GaussianBlur(img, (0, 0), 1.0).astype(np.float32)
    gx = cv2.Sobel(g, cv2.CV_32F, 1, 0)
    gy = cv2.Sobel(g, cv2.CV_32F, 0, 1)
    mag = cv2.GaussianBlur(np.hypot(gx, gy), (0, 0), 4)
    return mag > 6


def score(a, b, valid):
    f, fb = flow_pair(a, b)
    m = valid & (fb < 1.0)
    if m.sum() < 500:
        return None
    d = np.linalg.norm(f[m], axis=1)
    d = np.sort(d)[: int(len(d) * 0.75)]
    return float(d.mean())


def judge(frames, locks, subject_box, step=1):
    n, H, W = frames.shape
    ones = np.ones((H, W), np.uint8)
    stab = [cv2.warpPerspective(frames[i], locks[i], (W, H)) for i in range(n)]
    cov = [cv2.warpPerspective(ones, locks[i], (W, H), flags=cv2.INTER_NEAREST).astype(bool) for i in range(n)]
    cov = [cv2.erode(c.astype(np.uint8), np.ones((9, 9), np.uint8)).astype(bool) for c in cov]
    not_subject = np.ones((H, W), bool)
    x0, y0, x1, y1 = subject_box
    not_subject[y0:y1, x0:x1] = False
    tex0 = texture_mask(frames[0]) & not_subject
    hold, jit = [], []
    for i in range(1, n, step):
        h = score(stab[0], stab[i], tex0 & cov[i])
        j = score(stab[i - 1], stab[i], texture_mask(stab[i - 1]) & not_subject & cov[i] & cov[i - 1])
        hold.append(h)
        jit.append(j)
    return hold, jit


def rms(xs):
    xs = [x for x in xs if x is not None]
    return 2 * float(np.sqrt(np.mean(np.square(xs)))) if xs else float("nan"), len(xs)


def edge_zoom(locks, W, H, cap=6.0):
    """Smallest zoom at which a centered crop stays inside every frame."""
    inv = [np.linalg.inv(L) for L in locks]

    def fits(z):
        w, h = W / z / 2, H / z / 2
        pts = np.array([[W / 2 - w, H / 2 - h, 1], [W / 2 + w, H / 2 - h, 1],
                        [W / 2 - w, H / 2 + h, 1], [W / 2 + w, H / 2 + h, 1]]).T
        for M in inv:
            q = M @ pts
            q = q[:2] / q[2]
            if (q[0] < -0.5).any() or (q[0] > W + 0.5).any() or (q[1] < -0.5).any() or (q[1] > H + 0.5).any():
                return False
        return True
    if not fits(cap):
        return float("inf")
    lo, hi = 1.0, cap
    if fits(lo):
        return 1.0
    for _ in range(30):
        mid = (lo + hi) / 2
        lo, hi = (lo, mid) if fits(mid) else (mid, hi)
    return hi
