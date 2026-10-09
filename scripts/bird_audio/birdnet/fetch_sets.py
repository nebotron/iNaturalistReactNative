# Eval set (recent research-grade sound observations, created after the BirdNET
# v3.0 preview's training data was gathered, from WA/OR/BC, <=30/species) and a
# training set for head_birdnet.py (created before 2025-06-01, <=40/species).
import json, os, sys, urllib.request, concurrent.futures as cf, time
keep=json.load(open("keep_species.json"))
def get(url):
    for i in range(5):
        try: return urllib.request.urlopen(url,timeout=90).read()
        except Exception: time.sleep(2**i)
    raise IOError(url)
def fetch(name,q,per):
    meta=[]
    for s in keep:
        d=json.loads(get(f"https://api.inaturalist.org/v1/observations?taxon_id={s['id']}&sounds=true&quality_grade=research&place_id=46,10,7085&{q}&per_page={per}&order_by=id"))
        for o in d["results"]:
            f=[x for x in o["sounds"] if x.get("file_url")]
            if f:
                ll=(o.get("location") or ",").split(",")
                meta.append(dict(obs=o["id"],user=o["user"]["id"],taxon_id=s["id"],url=f[0]["file_url"],
                    date=o.get("observed_on"),lat=float(ll[0]) if ll[0] else None,lng=float(ll[1]) if ll[1] else None))
        time.sleep(0.7)
    print(name,len(meta),flush=True)
    os.makedirs("raw",exist_ok=True)
    def dl(m):
        ext=m["url"].split("?")[0].rsplit(".",1)[-1][:4]; p=f"raw/{m['obs']}.{ext}"; m["path"]=p
        if not os.path.exists(p):
            try: open(p,"wb").write(get(m["url"]))
            except Exception: m["path"]=None
        return m
    with cf.ThreadPoolExecutor(12) as ex: meta=list(ex.map(dl,meta))
    json.dump([m for m in meta if m["path"]],open(f"{name}_meta.json","w"))
    print(name,"done",flush=True)
fetch("eval","created_d1=2025-09-01",30)
fetch("train","created_d2=2025-06-01&order=desc",40)
