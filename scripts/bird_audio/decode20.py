import json, pickle, subprocess, numpy as np, imageio_ffmpeg, concurrent.futures as cf, torch
from model import LogMel, SR
FF=imageio_ffmpeg.get_ffmpeg_exe(); torch.set_num_threads(1)
fe=LogMel()
def dec(m):
    try:
        b=subprocess.run([FF,"-v","quiet","-i",m["path"],"-t","30","-ac","1","-ar",str(SR),"-f","f32le","-"],capture_output=True,timeout=120).stdout
        y=np.frombuffer(b,np.float32)
        if len(y)<SR: return None
        with torch.no_grad(): return fe(torch.tensor(y.copy())[None])[0].numpy().astype(np.float16)
    except Exception: return None
if __name__=="__main__":
    meta=[m for m in json.load(open("meta20.json")) if m["path"]]
    with cf.ProcessPoolExecutor(4) as ex: specs=list(ex.map(dec,meta,chunksize=8))
    keep=[(m,s) for m,s in zip(meta,specs) if s is not None]
    pickle.dump(([m for m,_ in keep],[s for _,s in keep]),open("data20.pkl","wb"),protocol=4)
    print(len(keep),"decoded of",len(meta))
