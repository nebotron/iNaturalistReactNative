import subprocess, numpy as np, json, sys, os
U="/home/user/iNaturalistReactNative/stabilization-eval/clips/"
OUT=sys.argv[1]
for f in sorted(os.listdir(U)):
    if not f.endswith(".mov"): continue
    name=f[:8]
    # ffmpeg autorotates; scale long side to 960
    probe=subprocess.run(["ffprobe","-v","error","-select_streams","v:0","-show_entries","stream=width,height:stream_side_data=rotation","-of","json",U+f],capture_output=True,text=True).stdout
    j=json.loads(probe)["streams"][0]; w,h=j["width"],j["height"]
    rot=abs(int(j.get("side_data_list",[{}])[0].get("rotation",0) or 0))
    if rot in (90,270): w,h=h,w
    s=960/max(w,h); W=int(round(w*s/2)*2); H=int(round(h*s/2)*2)
    p=subprocess.run(["ffmpeg","-v","error","-i",U+f,"-vf",f"scale={W}:{H}:flags=area","-pix_fmt","gray","-f","rawvideo","-"],capture_output=True)
    a=np.frombuffer(p.stdout,np.uint8).reshape(-1,H,W)
    np.save(f"{OUT}/{name}.npy",a); print(name,w,h,rot,a.shape)
