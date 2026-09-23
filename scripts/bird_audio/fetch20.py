import json, os, urllib.request, concurrent.futures as cf, time
top=json.load(open("counts.json"))[:20]
SP={c[3]:c[2] for c in top}
CAP=450; NEG=1500
os.makedirs("raw",exist_ok=True)
def get(url):
    for i in range(5):
        try: return urllib.request.urlopen(url,timeout=90).read()
        except Exception: time.sleep(2**i)
    raise IOError(url)
def collect(q,label,cap):
    out,idp=[],None
    while len(out)<cap:
        d=json.loads(get(q+"&per_page=200&order_by=id&order=desc"+(f"&id_below={idp}" if idp else "")))
        if not d["results"]: break
        for o in d["results"]:
            idp=o["id"]
            s=[x for x in o["sounds"] if x.get("file_url")]
            if s and len(out)<cap: out.append(dict(obs=o["id"],user=o["user"]["id"],label=label,url=s[0]["file_url"],taxon=(o.get("taxon") or {}).get("name")))
        time.sleep(1)
    print(label,len(out),flush=True); return out
meta=[]
for name,tid in SP.items():
    meta+=collect(f"https://api.inaturalist.org/v1/observations?taxon_id={tid}&sounds=true&quality_grade=research&place_id=46,10,7085",name,CAP)
ids=",".join(str(t) for t in SP.values())
meta+=collect(f"https://api.inaturalist.org/v1/observations?sounds=true&place_id=46,10,7085&without_taxon_id={ids}&identified=true",None,NEG)
def dl(m):
    ext=m["url"].split("?")[0].rsplit(".",1)[-1][:4]
    p=f"raw/{m['obs']}.{ext}"; m["path"]=p
    if not os.path.exists(p):
        try: open(p,"wb").write(get(m["url"]))
        except Exception: m["path"]=None
    return m
with cf.ThreadPoolExecutor(12) as ex: meta=list(ex.map(dl,meta))
json.dump(meta,open("meta20.json","w"))
print(sum(1 for m in meta if m["path"]),"downloaded of",len(meta))
