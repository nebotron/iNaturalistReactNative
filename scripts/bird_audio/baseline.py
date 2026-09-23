import json,pickle,numpy as np
from sklearn.model_selection import StratifiedGroupKFold
from sklearn.linear_model import LogisticRegression
from sklearn.preprocessing import StandardScaler
from sklearn.pipeline import make_pipeline
meta=json.load(open("meta_ok.json")); specs=pickle.load(open("specs.pkl","rb"))
C=sorted({m["label"] for m in meta}); y=np.array([C.index(m["label"]) for m in meta]); g=np.array([m["user"] for m in meta])
X=np.array([np.concatenate([s.mean(1),s.std(1),np.percentile(s,90,1),np.abs(np.diff(s,axis=1)).mean(1)]) for s in (s.astype(np.float32) for s in specs)])
folds=list(StratifiedGroupKFold(5,shuffle=True,random_state=0).split(X,y,g))
te=folds[0][1]; tr=np.setdiff1d(np.arange(len(y)),np.concatenate([te,folds[1][1]]))
m=make_pipeline(StandardScaler(),LogisticRegression(C=0.1,max_iter=3000)).fit(X[tr],y[tr]); print("baseline test acc",(m.predict(X[te])==y[te]).mean())
