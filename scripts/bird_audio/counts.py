import json,urllib.request,time
names=["Turdus migratorius","Melospiza melodia","Pipilo maculatus","Poecile atricapillus","Thryomanes bewickii","Junco hyemalis","Troglodytes pacificus","Zonotrichia leucophrys","Corvus brachyrhynchos","Cyanocitta stelleri","Colaptes auratus","Agelaius phoeniceus","Calypte anna","Poecile rufescens","Psaltriparus minimus","Regulus satrapa","Corthylio calendula","Ixoreus naevius","Catharus ustulatus","Haemorhous mexicanus","Dryobates pubescens","Empidonax difficilis","Strix varia","Bombycilla cedrorum","Cardellina pusilla","Leiothlypis celata","Pheucticus melanocephalus","Sitta canadensis","Certhia americana","Branta canadensis","Charadrius vociferus","Megaceryle alcyon","Spinus tristis","Setophaga coronata"]
out=[]
for n in names:
    t=json.load(urllib.request.urlopen("https://api.inaturalist.org/v1/taxa?rank=species&per_page=1&q="+n.replace(" ","%20")))["results"][0]
    c=json.load(urllib.request.urlopen(f"https://api.inaturalist.org/v1/observations?taxon_id={t['id']}&sounds=true&quality_grade=research&place_id=46,10,7085&per_page=0"))["total_results"]
    out.append((c,n,t["id"],t.get("preferred_common_name"))); print(c,n,t["id"],t.get("preferred_common_name"),flush=True); time.sleep(0.5)
json.dump(sorted(out,reverse=True),open("counts.json","w"))
