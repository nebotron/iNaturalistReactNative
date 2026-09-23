# Multi-label training on synthetic soundscapes: each example mixes 0-3 target
# species with real background recordings (other animals, other birds, wind,
# traffic) in the power domain, so the model learns to report every bird
# present and nothing when none are.
import json, pickle, time, numpy as np, torch, torch.nn.functional as F
from sklearn.model_selection import StratifiedGroupKFold
from sklearn.metrics import average_precision_score
from model import Net, Deployed, FRAMES, WIN
torch.manual_seed(0); rng=np.random.default_rng(0); torch.set_num_threads(4)
meta,specs=pickle.load(open("data20.pkl","rb"))
top=json.load(open("counts.json"))[:20]
C=[t[3] for t in top]; NC=len(C)
y=np.array([C.index(m["label"]) if m["label"] else NC for m in meta]); g=np.array([m["user"] for m in meta])
pw=[np.exp(s.astype(np.float32)) for s in specs]                   # mel power
en=[np.log(p.mean(0)+1e-9) for p in pw]                              # per-frame log energy
folds=list(StratifiedGroupKFold(5,shuffle=True,random_state=0).split(np.zeros(len(y)),y,g))
te,va=folds[0][1],folds[1][1]; tr=np.setdiff1d(np.arange(len(y)),np.concatenate([te,va]))
print("clips train/val/test",len(tr),len(va),len(te),"| shared recordists train-test:",len(set(g[tr])&set(g[te])),flush=True)
W=FRAMES
def crop(i,r,best_of=3):
    p=pw[i]; n=p.shape[1]
    if n<W: p=np.pad(p,((0,0),(0,W-n)),mode="wrap"); return p
    st=r.integers(0,n-W+1,best_of)                                     # weak labels: prefer a loud crop
    j=st[np.argmax([en[i][k:k+W].max() for k in st])] if best_of>1 else st[0]
    return p[:,j:j+W]
def pools(idx): return {c:idx[y[idx]==c] for c in range(NC)}, idx[y[idx]==NC]
def sample(pool,neg,r):
    lab=np.zeros(NC,np.float32); mix=np.zeros((64,W),np.float32)
    if r.random()<0.2: k=0
    else: k=r.choice([1,2,3],p=[.55,.3,.15])
    for n,c in enumerate(r.choice(NC,k,replace=False)):
        mix+=crop(r.choice(pool[c]),r)*10**(-(0 if n==0 else r.uniform(0,15))/10); lab[c]=1
    if k==0 or r.random()<0.7:                                         # background, up to as loud as the bird
        mix+=crop(r.choice(neg),r,1)*(10**(-r.uniform(0,20)/10) if k else 1)
        if k==0 and r.random()<0.5: mix+=crop(r.choice(neg),r,1)
    m=np.log(mix+1e-6); m=(m-m.mean())/(m.std()+1e-5)
    return m,lab
def specaug(x,r):
    for _ in range(2):
        f=r.integers(0,8); f0=r.integers(0,64-f); x[f0:f0+f]=0
        t=r.integers(0,25); t0=r.integers(0,W-t); x[:,t0:t0+t]=0
    return x
def fixed_set(idx,n,seed):                                             # reproducible synthetic soundscapes
    r=np.random.default_rng(seed); p,neg=pools(idx); X,Y=zip(*[sample(p,neg,r) for _ in range(n)]); return np.stack(X),np.stack(Y)
net=Net(NC)
def probs(X):
    net.eval(); out=[]
    with torch.no_grad():
        for b in range(0,len(X),256): out.append(torch.sigmoid(net(torch.tensor(X[b:b+256]))).numpy())
    return np.concatenate(out)
def clip_windows(i):
    s=specs[i].astype(np.float32)
    if s.shape[1]<W: s=np.pad(s,((0,0),(0,W-s.shape[1])),mode="wrap")
    st=list(range(0,s.shape[1]-W+1,W//2)) or [0]
    return np.stack([(s[:,j:j+W]-s[:,j:j+W].mean())/(s[:,j:j+W].std()+1e-5) for j in st])
def clip_acc(idx):
    idx=[i for i in idx if y[i]<NC]
    P=np.array([probs(clip_windows(i)).mean(0) for i in idx]); t=y[idx]
    return (P.argmax(1)==t).mean(), np.mean([t[k] in np.argsort(-P[k])[:3] for k in range(len(t))])
Xv,Yv=fixed_set(va,3000,1)
tp,tneg=pools(tr)
E=int(__import__("os").environ.get("EPOCHS",30)); STEPS=int(__import__("os").environ.get("STEPS",180)); BS=32
opt=torch.optim.AdamW(net.parameters(),2e-3,weight_decay=1e-3)
sched=torch.optim.lr_scheduler.OneCycleLR(opt,3e-3,total_steps=E*STEPS)
best,bstate=0,None; t0=time.time()
for ep in range(E):
    net.train()
    for _ in range(STEPS):
        X,Y=zip(*[sample(tp,tneg,rng) for _ in range(BS)])
        X=torch.tensor(np.stack([specaug(x,rng) for x in X])); Y=torch.tensor(np.stack(Y))
        loss=F.binary_cross_entropy_with_logits(net(X),Y)
        opt.zero_grad(); loss.backward(); opt.step(); sched.step()
    P=probs(Xv); m=average_precision_score(Yv,P,average="micro")
    print(f"ep{ep} loss {loss.item():.3f} val mAP {m:.3f} {time.time()-t0:.0f}s",flush=True)
    if m>=best: best,bstate=m,{k:v.clone() for k,v in net.state_dict().items()}
net.load_state_dict(bstate); torch.save(bstate,"net20.pt")
# Per-species thresholds: best F1 on validation soundscapes, kept within [0.3, 0.9].
P=probs(Xv); th=[]
for c in range(NC):
    cand=np.arange(0.3,0.91,0.05); f1=[]
    for t in cand:
        pr=P[:,c]>=t; tp_=(pr&(Yv[:,c]==1)).sum(); f1.append(2*tp_/(pr.sum()+Yv[:,c].sum()+1e-9))
    th.append(round(float(cand[int(np.argmax(f1))]),2))
# ---- test ----
Xt,Yt=fixed_set(te,3000,2); Pt=probs(Xt); pred=Pt>=np.array(th)
tp_=(pred&(Yt==1)).sum(); prec=tp_/max(pred.sum(),1); rec=tp_/Yt.sum()
bg=Yt.sum(1)==0; exact=(pred==(Yt==1)).all(1)
a1,a3=clip_acc(te)
rep=dict(species=C,thresholds=th,
 clip_top1=float(a1),clip_top3=float(a3),
 soundscape_mAP=float(average_precision_score(Yt,Pt,average="micro")),
 soundscape_precision=float(prec),soundscape_recall=float(rec),soundscape_f1=float(2*prec*rec/(prec+rec)),
 exact_set_match=float(exact.mean()),
 recall_by_birds_in_window={k:float(((pred&(Yt==1)).sum(1)[Yt.sum(1)==k]).sum()/(k*(Yt.sum(1)==k).sum())) for k in (1,2,3)},
 background_windows_with_false_alarm=float(pred[bg].any(1).mean()),
 per_species={C[c]:dict(AP=float(average_precision_score(Yt[:,c],Pt[:,c])),
   precision=float((pred[:,c]&(Yt[:,c]==1)).sum()/max(pred[:,c].sum(),1)),
   recall=float((pred[:,c]&(Yt[:,c]==1)).sum()/max(Yt[:,c].sum(),1))) for c in range(NC)})
json.dump(rep,open("report20.json","w"),indent=1); print(json.dumps({k:v for k,v in rep.items() if k!="per_species"},indent=1))
for k,v in rep["per_species"].items(): print(f"{k:28s} AP {v['AP']:.3f}  P {v['precision']:.3f}  R {v['recall']:.3f}")
# ---- export ----
dep=Deployed(net).eval(); x=torch.randn(1,WIN)*0.05
torch.onnx.export(dep,x,"audio_birds.onnx",input_names=["audio"],output_names=["probs"],opset_version=17,dynamo=False)
import onnxruntime as ort
o=ort.InferenceSession("audio_birds.onnx").run(None,{"audio":x.numpy()})[0]
print("onnx vs torch max diff",np.abs(o-dep(x).detach().numpy()).max())
