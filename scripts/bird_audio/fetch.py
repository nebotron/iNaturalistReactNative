import json, os, urllib.request, concurrent.futures as cf, time
SP = {"American Robin":12727,"Song Sparrow":9100,"Spotted Towhee":9420,
      "Black-capped Chickadee":144815,"Bewick's Wren":7576}
CAP=300
os.makedirs("raw",exist_ok=True)
meta=[]
def get(url):
    for i in range(4):
        try: return urllib.request.urlopen(url,timeout=60).read()
        except Exception as e: time.sleep(2**i)
    raise
for name,tid in SP.items():
    page,got=1,0
    while got<CAP:
        d=json.loads(get(f"https://api.inaturalist.org/v1/observations?taxon_id={tid}&sounds=true&quality_grade=research&place_id=46&per_page=200&page={page}&order_by=id"))
        if not d["results"]: break
        for o in d["results"]:
            if got>=CAP: break
            s=[x for x in o["sounds"] if x.get("file_url")]
            if not s: continue
            meta.append(dict(obs=o["id"],user=o["user"]["id"],label=name,url=s[0]["file_url"]))
            got+=1
        page+=1; time.sleep(1)
    print(name,got)
def dl(m):
    ext=m["url"].split("?")[0].rsplit(".",1)[-1][:4]
    p=f"raw/{m['obs']}.{ext}"; m["path"]=p
    if not os.path.exists(p):
        try: open(p,"wb").write(get(m["url"]))
        except Exception: m["path"]=None
    return m
with cf.ThreadPoolExecutor(8) as ex: meta=list(ex.map(dl,meta))
json.dump(meta,open("meta.json","w"))
print(sum(1 for m in meta if m["path"]),"downloaded")
