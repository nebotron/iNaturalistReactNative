"""Shared config, audio I/O and feature extraction for the iNat sound model.

Decoding tries libsndfile (via soundfile) first, which covers the WAV and MP3
uploads, then falls back to PyAV for AAC/M4A. The fallback is not optional:
recordings made in the iNaturalist iOS app are M4A, and they are a large share
of the corpus, so a libsndfile-only reader silently throws away much of the
data and skews the dataset toward desktop uploaders.
"""
from __future__ import annotations

import pathlib

import av
import numpy as np
import soundfile as sf
import torch
import torchaudio

ROOT = pathlib.Path( __file__ ).resolve().parent
DATA = ROOT / "data"
AUDIO = DATA / "audio"
RUNS = ROOT / "runs"

# Feature config. 3 s windows at 22.05 kHz matches the framing most birdsong
# classifiers use, and 22.05 kHz is the rate iNatSounds is distributed at.
SAMPLE_RATE = 22_050
WINDOW_SECONDS = 3.0
WINDOW_SAMPLES = int( SAMPLE_RATE * WINDOW_SECONDS )
N_FFT = 1024
HOP = 512
N_MELS = 64
F_MIN = 40.0
F_MAX = 11_000.0
N_FRAMES = WINDOW_SAMPLES // HOP + 1

_MEL = None


def mel_transform() -> torch.nn.Module:
    """Log-mel spectrogram transform, built once and reused."""
    global _MEL
    if _MEL is None:
        _MEL = torch.nn.Sequential(
            torchaudio.transforms.MelSpectrogram(
                sample_rate=SAMPLE_RATE,
                n_fft=N_FFT,
                hop_length=HOP,
                n_mels=N_MELS,
                f_min=F_MIN,
                f_max=F_MAX,
                power=2.0,
            ),
            torchaudio.transforms.AmplitudeToDB( stype="power", top_db=80.0 ),
        )
        _MEL.eval()
    return _MEL


def _load_with_av( path ) -> np.ndarray:
    """Decode via PyAV's bundled ffmpeg, resampling to mono float32."""
    with av.open( str( path ) ) as container:
        if not container.streams.audio:
            raise ValueError( "no audio stream" )
        stream = container.streams.audio[0]
        resampler = av.AudioResampler( format="fltp", layout="mono", rate=SAMPLE_RATE )
        chunks = []
        for frame in container.decode( stream ):
            for resampled in resampler.resample( frame ):
                chunks.append( resampled.to_ndarray().reshape( -1 ) )
        for resampled in resampler.resample( None ):  # flush
            chunks.append( resampled.to_ndarray().reshape( -1 ) )
    if not chunks:
        raise ValueError( "decoded to zero samples" )
    return np.concatenate( chunks ).astype( np.float32 )


def load_audio( path ) -> np.ndarray:
    """Decode any file to mono float32 at SAMPLE_RATE."""
    try:
        data, sr = sf.read( str( path ), dtype="float32", always_2d=True )
    except sf.LibsndfileError:
        return _load_with_av( path )
    wav = data.mean( axis=1 )
    if sr != SAMPLE_RATE:
        wav = torchaudio.functional.resample(
            torch.from_numpy( wav ), sr, SAMPLE_RATE
        ).numpy()
    return np.ascontiguousarray( wav, dtype=np.float32 )


def _tile_to_length( wav: np.ndarray, length: int ) -> np.ndarray:
    if wav.size == 0:
        return np.zeros( length, dtype=np.float32 )
    reps = int( np.ceil( length / wav.size ) )
    return np.tile( wav, reps )[:length]


def pick_windows( wav: np.ndarray, max_windows: int ) -> np.ndarray:
    """Slice audio into fixed windows, keeping the most acoustically active ones.

    iNaturalist recordings are weakly labeled and often mostly silence or
    handling noise, so we rank windows by the energy of the first-difference of
    the signal. Differencing acts as a crude high-pass, which keeps windows
    scored on calls rather than on wind and traffic rumble.

    Returns an array of shape ( n, WINDOW_SAMPLES ).
    """
    if wav.size < WINDOW_SAMPLES:
        wav = _tile_to_length( wav, WINDOW_SAMPLES )
    n = wav.size // WINDOW_SAMPLES
    windows = wav[: n * WINDOW_SAMPLES].reshape( n, WINDOW_SAMPLES )
    if n <= max_windows:
        return windows
    scores = np.sqrt( ( np.diff( windows, axis=1 ) ** 2 ).mean( axis=1 ) )
    keep = np.sort( np.argsort( scores )[::-1][:max_windows] )
    return windows[keep]


def log_mel( windows: np.ndarray ) -> np.ndarray:
    """( n, WINDOW_SAMPLES ) waveform -> ( n, N_MELS, N_FRAMES ) log-mel."""
    with torch.no_grad():
        spec = mel_transform()( torch.from_numpy( windows ) )
    return spec.numpy()
