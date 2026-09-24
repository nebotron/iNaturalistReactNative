# Held-out evaluation set: recent research-grade sound observations (created
# after the BirdNET v3.0 preview's training data was gathered) from WA/OR/BC,
# up to 30 per Seattle-area species.
import json, os, urllib.request, concurrent.futures as cf, time
sp=[s for s in json.load(open("seattle_species.json")) if s["count"]>=10]
RAW="raw"; os.makedirs(RAW,exist_ok=True)
def get(url):
    for i in range(5):
        try: return urllib.request.urlopen(url,timeout=90).read()
        except Exception: time.sleep(2**i)
    raise IOError(url)
meta=[]
for s in sp:
    d=json.loads(get(f"https://api.inaturalist.org/v1/observations?taxon_id={s['id']}&sounds=true&quality_grade=research&place_id=46,10,7085&created_d1=2025-09-01&per_page=30&order_by=id"))
    for o in d["results"]:
        f=[x for x in o["sounds"] if x.get("file_url")]
        if f: meta.append(dict(obs=o["id"],user=o["user"]["id"],taxon_id=s["id"],name=s["name"],url=f[0]["file_url"]))
    time.sleep(0.7)
print(len(meta),"eval recordings,",len({m['taxon_id'] for m in meta}),"species",flush=True)
def dl(m):
    ext=m["url"].split("?")[0].rsplit(".",1)[-1][:4]; p=f"{RAW}/{m['obs']}.{ext}"; m["path"]=p
    if not os.path.exists(p):
        try: open(p,"wb").write(get(m["url"]))
        except Exception: m["path"]=None
    return m
with cf.ThreadPoolExecutor(12) as ex: meta=list(ex.map(dl,meta))
json.dump([m for m in meta if m["path"]],open("eval_meta.json","w"))
print("done")
