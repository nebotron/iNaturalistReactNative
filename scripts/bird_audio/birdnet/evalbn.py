# Clip-level accuracy of BirdNET v2.4 and v3.0 (NA-west) on the held-out
# Seattle-species set, with outputs restricted to the Seattle species list.
import json, subprocess, numpy as np, onnxruntime as ort, imageio_ffmpeg, concurrent.futures as cf, sys
FF=imageio_ffmpeg.get_ffmpeg_exe()
SYN={"Leuconotopicus villosus":"Dryobates villosus","Hesperiphona vespertina":"Coccothraustes vespertinus",
     "Vireo swainsoni":"Vireo gilvus"}
sp=[s for s in json.load(open("seattle_species.json")) if s["count"]>=10]
def labels(f): return [l.strip().split("_")[0] for l in open(f)]
L3=labels("birdnet-v3.0-preview3.1-north-america-west-labels-b1.txt"); L2=labels("BirdNET_GLOBAL_6K_V2.4_Labels.txt")
keep=[s for s in sp if SYN.get(s["name"],s["name"]) in L3 and SYN.get(s["name"],s["name"]) in L2]
i3=np.array([L3.index(SYN.get(s["name"],s["name"])) for s in keep]); i2=np.array([L2.index(SYN.get(s["name"],s["name"])) for s in keep])
tid=[s["id"] for s in keep]
meta=[m for m in json.load(open("eval_meta.json")) if m["taxon_id"] in tid]
print(len(keep),"species in both models;",len(meta),"eval clips",flush=True)
def load(p,sr):
    y=np.frombuffer(subprocess.run([FF,"-v","quiet","-i",p,"-t","30","-ac","1","-ar",str(sr),"-f","f32le","-"],capture_output=True,timeout=120).stdout,np.float32)
    return y
def frames(y,n):
    if len(y)<n: y=np.pad(y,(0,n-len(y)))
    return np.stack([y[j:j+n] for j in range(0,len(y)-n+1,n//2)])
s2=ort.InferenceSession("birdnet.onnx"); s3=ort.InferenceSession("birdnet-v3.0-preview3.1-north-america-west-fp32-b1.onnx")
def run(m):
    try:
        y48=load(m["path"],48000); y32=load(m["path"],32000)
        if len(y32)<16000: return None
        p2=1/(1+np.exp(-s2.run(None,{"input":frames(y48,144000)})[0][:,i2]))
        p3=s3.run(None,{"input":frames(y32,160000)})[0][:,i3]
        return tid.index(m["taxon_id"]),p2.max(0),p3.max(0)
    except Exception as e: return None
with cf.ThreadPoolExecutor(3) as ex: R=[r for r in ex.map(run,meta) if r]
t=np.array([r[0] for r in R]); P2=np.stack([r[1] for r in R]); P3=np.stack([r[2] for r in R])
np.savez("eval_scores.npz",t=t,P2=P2,P3=P3,obs=np.array([m["obs"] for m in meta]))
def acc(P,k=1): return np.mean([t[i] in np.argsort(-P[i])[:k] for i in range(len(t))])
def macro(P): 
    c=(P.argmax(1)==t); return np.mean([c[t==k].mean() for k in np.unique(t)])
for n,P in (("v2.4",P2),("v3.0",P3)):
    print(f"{n}: top1 {acc(P):.3f} top5 {acc(P,5):.3f} macro-avg per-species top1 {macro(P):.3f}  (n={len(t)} clips, {len(np.unique(t))} species)")
