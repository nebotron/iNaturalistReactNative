import json, pickle, numpy as np, torch, torch.nn as nn, torch.nn.functional as F, random
from sklearn.model_selection import StratifiedGroupKFold
from sklearn.metrics import confusion_matrix, classification_report
torch.manual_seed(0); np.random.seed(0); random.seed(0); torch.set_num_threads(4)
meta=json.load(open("meta_ok.json")); specs=pickle.load(open("specs.pkl","rb"))
C=sorted({m["label"] for m in meta}); y=np.array([C.index(m["label"]) for m in meta]); g=np.array([m["user"] for m in meta])
specs=[(s.astype(np.float32)-s.astype(np.float32).mean())/(s.astype(np.float32).std()+1e-5) for s in specs]
folds=list(StratifiedGroupKFold(5,shuffle=True,random_state=0).split(np.zeros(len(y)),y,g))
te=folds[0][1]; va=folds[1][1]; tr=np.setdiff1d(np.arange(len(y)),np.concatenate([te,va]))
print("train/val/test clips:",len(tr),len(va),len(te),"| users overlap:",len(set(g[tr])&set(g[te])))
W=256
def crop(s,train=True):
    if s.shape[1]<W: s=np.pad(s,((0,0),(0,W-s.shape[1])),mode="wrap")
    i=np.random.randint(0,s.shape[1]-W+1) if train else 0
    x=s[:,i:i+W].copy()
    if train:
        for _ in range(2):
            f=np.random.randint(0,8); f0=np.random.randint(0,64-f); x[f0:f0+f]=0
            t=np.random.randint(0,30); t0=np.random.randint(0,W-t); x[:,t0:t0+t]=0
    return x
def blk(i,o): return nn.Sequential(nn.Conv2d(i,o,3,padding=1),nn.BatchNorm2d(o),nn.ReLU(),nn.Conv2d(o,o,3,padding=1),nn.BatchNorm2d(o),nn.ReLU(),nn.MaxPool2d(2))
net=nn.Sequential(blk(1,32),blk(32,64),blk(64,128),blk(128,256),nn.AdaptiveAvgPool2d(1),nn.Flatten(),nn.Dropout(0.3),nn.Linear(256,len(C)))
def predict(idx):
    net.eval(); out=[]
    with torch.no_grad():
        for i in idx:
            s=specs[i]
            if s.shape[1]<W: s=np.pad(s,((0,0),(0,W-s.shape[1])),mode="wrap")
            st=list(range(0,s.shape[1]-W+1,W//2)) or [0]
            x=torch.tensor(np.stack([s[:,j:j+W] for j in st]))[:,None]
            out.append(F.softmax(net(x),1).mean(0).numpy())
    return np.array(out)
E=40; opt=torch.optim.AdamW(net.parameters(),2e-3,weight_decay=1e-3)
sched=torch.optim.lr_scheduler.OneCycleLR(opt,3e-3,total_steps=E*(len(tr)//32+1))
best,bstate=0,None
for ep in range(E):
    net.train(); p=np.random.permutation(tr)
    for b in range(0,len(p),32):
        ix=p[b:b+32]; x=torch.tensor(np.stack([crop(specs[i]) for i in ix]))[:,None]; t=torch.tensor(y[ix])
        lam=np.random.beta(0.4,0.4); perm=torch.randperm(len(ix))
        out=net(lam*x+(1-lam)*x[perm]); loss=lam*F.cross_entropy(out,t,label_smoothing=0.05)+(1-lam)*F.cross_entropy(out,t[perm],label_smoothing=0.05)
        opt.zero_grad(); loss.backward(); opt.step(); sched.step()
    if ep%2==1 or ep==E-1:
        acc=(predict(va).argmax(1)==y[va]).mean(); print(f"ep{ep} loss {loss.item():.3f} val acc {acc:.3f}",flush=True)
        if acc>=best: best,bstate=acc,{k:v.clone() for k,v in net.state_dict().items()}
net.load_state_dict(bstate); P=predict(te); pr=P.argmax(1)
print(f"\nTEST top-1 {(pr==y[te]).mean():.3f}  top-2 {np.mean([y[te][k] in np.argsort(-P[k])[:2] for k in range(len(te))]):.3f}  (best val {best:.3f})")
print(classification_report(y[te],pr,target_names=C,digits=3)); print(C); print(confusion_matrix(y[te],pr))
torch.save(net.state_dict(),"cnn.pt")
