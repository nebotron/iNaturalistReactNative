# Bird species with research-grade iNaturalist observations within 40 km of
# Seattle, with their observation counts -> seattle_species.json.
import json, urllib.request, time
out, page = [], 1
while True:
    d=json.load(urllib.request.urlopen("https://api.inaturalist.org/v1/observations/species_counts?taxon_id=3"
        f"&quality_grade=research&lat=47.61&lng=-122.33&radius=40&rank=species&per_page=500&page={page}"))
    out+=d["results"]
    if len(out)>=d["total_results"] or not d["results"]: break
    page+=1; time.sleep(1)
json.dump([dict(count=r["count"],id=r["taxon"]["id"],name=r["taxon"]["name"],
                common=r["taxon"].get("preferred_common_name")) for r in out],open("seattle_species.json","w"))
