# Seattle species (10+ RG observations) that BirdNET v3.0 NA-west knows, and
# their class indices in the model -> keep_species.json, keep_idx.json.
import json
# iNaturalist and BirdNET disagree on a few names.
SYN={"Leuconotopicus villosus":"Dryobates villosus","Hesperiphona vespertina":"Coccothraustes vespertinus",
     "Vireo swainsoni":"Vireo gilvus"}
sp=[s for s in json.load(open("seattle_species.json")) if s["count"]>=10]
L3=[l.strip().split("_")[0] for l in open("birdnet-v3.0-preview3.1-north-america-west-labels-b1.txt")]
keep=[s for s in sp if SYN.get(s["name"],s["name"]) in L3]
json.dump([L3.index(SYN.get(s["name"],s["name"])) for s in keep],open("keep_idx.json","w"))
json.dump(keep,open("keep_species.json","w")); print(len(keep),"species")
