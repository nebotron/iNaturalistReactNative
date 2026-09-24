# Accuracy of the exact model shipped in the app (audio_birds.onnx, fp16,
# 229 Seattle species), fed the way the app feeds it: 5 s windows at 32 kHz.
import json, subprocess, numpy as np, onnxruntime as ort, imageio_ffmpeg, concurrent.futures as cf
FF=imageio_ffmpeg.get_ffmpeg_exe(); TH=0.5
keep=json.load(open("keep_species.json")); tid=[s["id"] for s in keep]
meta=[m for m in json.load(open("eval_meta.json")) if m["taxon_id"] in tid]
s=ort.InferenceSession("audio_birds.onnx")
def run(m):
    try:
        y=np.frombuffer(subprocess.run([FF,"-v","quiet","-i",m["path"],"-t","30","-ac","1","-ar","32000","-f","f32le","-"],capture_output=True,timeout=120).stdout,np.float32)
        if len(y)<16000: return None
        if len(y)<160000: y=np.pad(y,(0,160000-len(y)))
        X=np.stack([y[j:j+160000] for j in range(0,len(y)-160000+1,32000)])
        return tid.index(m["taxon_id"]),s.run(None,{"input":X})[0].max(0)
    except Exception: return None
with cf.ThreadPoolExecutor(3) as ex: R=[r for r in ex.map(run,meta) if r]
t=np.array([r[0] for r in R]); P=np.stack([r[1] for r in R])
top=lambda k: np.mean([t[i] in np.argsort(-P[i])[:k] for i in range(len(t))])
c=P.argmax(1)==t; det=P>=TH
rep=dict(model="BirdNET v3.0 preview 3.1, NA-west, sliced to Seattle species, fp16",species=len(keep),
  eval_recordings=len(t),eval_species=int(len(np.unique(t))),top1=float(top(1)),top5=float(top(5)),
  macro_top1=float(np.mean([c[t==k].mean() for k in np.unique(t)])),threshold=TH,
  recall_at_threshold=float(det[np.arange(len(t)),t].mean()),
  other_species_flagged_per_recording=float((det.sum(1)-det[np.arange(len(t)),t]).mean()),
  per_species={keep[k]["common"]:dict(n=int((t==k).sum()),top1=float(c[t==k].mean())) for k in np.unique(t)})
json.dump(rep,open("report_birdnet.json","w"),indent=1)
print(json.dumps({k:v for k,v in rep.items() if k!="per_species"},indent=1))
ps=sorted(rep["per_species"].items(),key=lambda kv:kv[1]["top1"])
print("weakest:",[(k,v["n"],round(v["top1"],2)) for k,v in ps[:10] if v["n"]>=5])
