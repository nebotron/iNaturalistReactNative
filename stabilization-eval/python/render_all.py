"""One video: each clip in turn as a grid of the original and each method,
frame-synced, labeled with the method and its scores."""
import subprocess

import cv2
import numpy as np

U = "/home/user/iNaturalistReactNative/stabilization-eval/clips/"
CW, CH = 1920, 800   # canvas
HEADER = 44


def color_frames(clip, W, H, n):
    p = subprocess.run(["ffmpeg", "-v", "error", "-i", f"{U}{clip}.mov", "-vf", f"scale={W}:{H}:flags=area",
                        "-pix_fmt", "bgr24", "-f", "rawvideo", "-"], capture_output=True)
    return np.frombuffer(p.stdout, np.uint8)[: n * H * W * 3].reshape(n, H, W, 3)


BAND = 50


def fit(text, width, scale):
    while scale > 0.3 and cv2.getTextSize(text, cv2.FONT_HERSHEY_SIMPLEX, scale, 1)[0][0] > width - 12:
        scale -= 0.02
    return scale


def label(band, lines):
    w = band.shape[1]
    y = 20
    for k, t in enumerate(lines):
        sc = fit(t, w, 0.62 if k == 0 else 0.5)
        cv2.putText(band, t, (6, y), cv2.FONT_HERSHEY_SIMPLEX, sc, (255, 255, 255) if k == 0 else (170, 210, 255),
                    1, cv2.LINE_AA)
        y += 22


def render(out, segments, fps=29.97):
    """segments: list of (title, clip, n, W, H, [(name, locks or None, note)])."""
    enc = subprocess.Popen(["ffmpeg", "-v", "error", "-y", "-f", "rawvideo", "-pix_fmt", "bgr24",
                            "-s", f"{CW}x{CH}", "-r", str(fps), "-i", "-", "-c:v", "libx264", "-crf", "21",
                            "-preset", "medium", "-pix_fmt", "yuv420p", "-movflags", "+faststart", out],
                           stdin=subprocess.PIPE)
    for title, clip, n, W, H, methods in segments:
        fr = color_frames(clip, W, H, n)
        k = len(methods)
        portrait = H > W
        cols = k if portrait else 3
        rows = 1 if portrait else (k + 2) // 3
        pw = CW // cols
        ph = min((CH - HEADER) // rows - BAND, int(pw * H / W))
        pw = int(ph * W / H)
        x0 = (CW - pw * cols) // 2
        for i in range(n):
            canvas = np.zeros((CH, CW, 3), np.uint8)
            cv2.putText(canvas, f"{title}   frame {i + 1}/{n}", (16, 32), cv2.FONT_HERSHEY_SIMPLEX, 0.9,
                        (230, 230, 230), 2, cv2.LINE_AA)
            for m, (name, locks, note) in enumerate(methods):
                img = fr[i] if locks is None else cv2.warpPerspective(fr[i], locks[i], (W, H))
                img = cv2.resize(img, (pw, ph), interpolation=cv2.INTER_AREA)
                r, c = divmod(m, cols)
                y = HEADER + r * (ph + BAND)
                x = x0 + c * pw
                label(canvas[y:y + BAND, x:x + pw], [name] + ([note] if note else []))
                canvas[y + BAND:y + BAND + ph, x:x + pw] = img
            enc.stdin.write(canvas.tobytes())
    enc.stdin.close()
    enc.wait()
