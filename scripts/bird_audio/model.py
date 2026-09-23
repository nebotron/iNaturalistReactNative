# Shared model definition: the log-mel frontend is part of the network so the
# exported ONNX model takes raw 22.05 kHz mono audio and the app needs no DSP.
import numpy as np, torch, torch.nn as nn, torch.nn.functional as F, librosa
SR=22050; NFFT=1024; HOP=320; NMELS=64; FMIN=500; FMAX=10000
WIN_S=3.0; WIN=int(SR*WIN_S)            # 66150 samples per inference window
FRAMES=WIN//HOP+1                        # 207 frames with center padding
class LogMel(nn.Module):
    def __init__(s):
        super().__init__()
        n=np.arange(NFFT); w=np.hanning(NFFT+1)[:-1]
        k=np.arange(NFFT//2+1)[:,None]
        s.register_buffer("re",torch.tensor((np.cos(2*np.pi*k*n/NFFT)*w)[:,None,:],dtype=torch.float32))
        s.register_buffer("im",torch.tensor((-np.sin(2*np.pi*k*n/NFFT)*w)[:,None,:],dtype=torch.float32))
        s.register_buffer("mel",torch.tensor(librosa.filters.mel(sr=SR,n_fft=NFFT,n_mels=NMELS,fmin=FMIN,fmax=FMAX),dtype=torch.float32))
    def forward(s,x):                    # x [B,T] -> log power mel [B,64,frames]
        x=F.pad(x[:,None],(NFFT//2,NFFT//2),mode="reflect")
        p=F.conv1d(x,s.re,stride=HOP)**2+F.conv1d(x,s.im,stride=HOP)**2
        return torch.log(torch.matmul(s.mel,p)+1e-6)
def norm(m):                             # per-window standardisation
    mu=m.mean(dim=(1,2),keepdim=True); sd=m.std(dim=(1,2),keepdim=True)
    return (m-mu)/(sd+1e-5)
def blk(i,o): return nn.Sequential(nn.Conv2d(i,o,3,padding=1,bias=False),nn.BatchNorm2d(o),nn.ReLU(),
                                   nn.Conv2d(o,o,3,padding=1,bias=False),nn.BatchNorm2d(o),nn.ReLU(),nn.MaxPool2d(2))
class Net(nn.Module):
    def __init__(s,nc):
        super().__init__()
        s.f=nn.Sequential(blk(1,32),blk(32,64),blk(64,128),blk(128,256))
        s.drop=nn.Dropout(0.3); s.fc=nn.Linear(256,nc)
    def forward(s,m):                    # m: normalised log-mel [B,64,F] -> logits
        h=s.f(m[:,None]).mean(2)         # [B,256,T']
        h=h.amax(2)+h.mean(2)            # max+mean pooling over time: a short call counts
        return s.fc(s.drop(h))
class Deployed(nn.Module):               # waveform [1,WIN] -> per-species probabilities
    def __init__(s,net): super().__init__(); s.fe=LogMel(); s.net=net
    def forward(s,x): return torch.sigmoid(s.net(norm(s.fe(x))))
