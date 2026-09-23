import json, subprocess, numpy as np, imageio_ffmpeg, concurrent.futures as cf, librosa
FF=imageio_ffmpeg.get_ffmpeg_exe(); SR=22050
meta=[m for m in json.load(open("meta.json")) if m["path"]]
def dec(m):
    try:
        b=subprocess.run([FF,"-v","quiet","-i",m["path"],"-t","30","-ac","1","-ar",str(SR),"-f","f32le","-"],capture_output=True,timeout=120).stdout
        y=np.frombuffer(b,np.float32)
        if len(y)<SR: return None
        S=librosa.feature.melspectrogram(y=y,sr=SR,n_fft=1024,hop_length=320,n_mels=64,fmin=500,fmax=10000)
        return np.log(S+1e-6).astype(np.float16)
    except Exception: return None
with cf.ProcessPoolExecutor(4) as ex: specs=list(ex.map(dec,meta))
keep=[(m,s) for m,s in zip(meta,specs) if s is not None]
import pickle; pickle.dump([s for _,s in keep],open("specs.pkl","wb"))
json.dump([m for m,_ in keep],open("meta_ok.json","w"))
print(len(keep),"decoded; median frames",np.median([s.shape[1] for _,s in keep]))
