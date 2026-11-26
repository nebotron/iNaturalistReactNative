#!/usr/bin/env python3
"""
Build src/appConstants/birdCodes.json, the official 4-letter bird codes that
loadBirdCodes stores on Realm taxa so offline search finds birds by code.

Codes come from the Institute for Bird Populations' alpha code list (updated
yearly after each AOS supplement), matched to iNaturalist taxa by the code
iNaturalist stores for the taxon, then scientific name, then English name.
Codes iNaturalist knows that the list no longer has (e.g. old codes like GRAJ)
are kept for the taxon iNaturalist gives them to.

Usage:
    python3 scripts/buildBirdCodes.py               # download everything
    python3 scripts/buildBirdCodes.py --birds b.json  # reuse a bird taxa download
"""
import argparse
import csv
import io
import json
import re
import time
import urllib.request
import zipfile

IBP_URL = "https://www.birdpop.org/docs/misc/IBPAOU.zip"
OUT = "src/appConstants/birdCodes.json"


def fetch_json( url ):
    for attempt in range( 6 ):
        try:
            with urllib.request.urlopen( url, timeout=60 ) as response:
                return json.load( response )
        except Exception as error:  # pylint: disable=broad-except
            print( "retrying", url, error )
            time.sleep( 10 * ( attempt + 1 ) )
    raise RuntimeError( f"failed to fetch {url}" )


def fetch_birds():
    """Every bird taxon on iNaturalist with its 4-letter codes and other names"""
    taxa, last_id = [], 0
    while True:
        results = fetch_json(
            "https://api.inaturalist.org/v1/taxa?taxon_id=3&per_page=200&order_by=id"
            f"&order=asc&id_above={last_id}&all_names=true&locale=en"
        )["results"]
        if not results:
            return taxa
        for taxon in results:
            names = taxon.get( "names", [] )
            taxa.append( {
                **{key: taxon.get( key ) for key in (
                    "id", "name", "preferred_common_name", "rank", "rank_level", "ancestor_ids",
                    "is_active",
                )},
                "codes": [n["name"] for n in names if n.get( "lexicon" ) == "aou-4-letter-codes"],
                "sci_names": [n["name"] for n in names if n.get( "lexicon" ) == "scientific-names"],
                "en_names": [n["name"] for n in names if n.get( "lexicon" ) == "english"],
            } )
        last_id = results[-1]["id"]
        print( len( taxa ), "bird taxa" )
        time.sleep( 1 )


def fetch_ibp_rows():
    with urllib.request.urlopen( IBP_URL, timeout=60 ) as response:
        archive = zipfile.ZipFile( io.BytesIO( response.read() ) )
    name = next( n for n in archive.namelist() if n.lower().endswith( ".csv" ) )
    text = archive.read( name ).decode( "latin-1" )
    return list( csv.DictReader( io.StringIO( text ) ) )


def norm( name ):
    # "Anas platyrhynchos x rubripes" and "Anas platyrhynchos × rubripes" match,
    # as do "Anatidae sp." and "Anatidae"
    name = re.sub( r"\b(x|sp|spp|ssp)\b|×", "", ( name or "" ).lower() )
    return re.sub( r"[^a-z0-9]", "", name )


def group_name( sci ):
    """
    The group a code for an unidentified bird, hybrid, or species pair covers,
    e.g. "Anatinae (gen, sp)" -> "Anatinae", "Spatula discors/cyanoptera" ->
    "Spatula", "Anas platyrhynchos x rubripes" -> "Anas"
    """
    name = re.sub( r"\(.*?\)|\bhybrid\b", "", sci ).strip()
    words = name.split()
    if re.search( r"\sx\s", name, re.IGNORECASE ):
        words = words[:1]
    for index, word in enumerate( words ):
        if "/" in word:
            words = words[:index]
            break
    return " ".join( words )


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument( "--birds", help="cached bird taxa JSON; downloaded and saved if missing" )
    args = parser.parse_args()

    birds = None
    if args.birds:
        try:
            with open( args.birds, encoding="utf-8" ) as file:
                birds = json.load( file )
        except FileNotFoundError:
            pass
    if birds is None:
        birds = fetch_birds()
        if args.birds:
            with open( args.birds, "w", encoding="utf-8" ) as file:
                json.dump( birds, file )
    active = [taxon for taxon in birds if taxon["is_active"]]

    by_code, by_sci, by_common = {}, {}, {}
    for taxon in active:
        for code in taxon["codes"]:
            by_code.setdefault( code.upper(), [] ).append( taxon )
        by_sci.setdefault( norm( taxon["name"] ), [] ).append( taxon )
        for name in taxon["sci_names"]:
            by_sci.setdefault( norm( name ), [] ).append( taxon )
        for name in {taxon["preferred_common_name"], *taxon["en_names"]}:
            if name:
                by_common.setdefault( norm( name ), [] ).append( taxon )

    def unique( candidates ):
        ids = {taxon["id"] for taxon in candidates}
        return candidates[0] if len( ids ) == 1 else None

    codes_by_taxon, unmatched = {}, []
    ibp_codes = set()
    for row in fetch_ibp_rows():
        code, sci, common = row["SPEC"].strip().upper(), row["SCINAME"], row["COMMONNAME"]
        if len( code ) != 4:
            continue
        ibp_codes.add( code )
        names = {norm( sci ), norm( common )}
        same_code = [
            taxon for taxon in by_code.get( code, [] )
            if names & {norm( n ) for n in [
                taxon["name"], taxon["preferred_common_name"], *taxon["sci_names"],
                *taxon["en_names"],
            ]}
        ]
        taxon = (
            unique( same_code )
            or unique( [t for t in by_sci.get( norm( sci ), [] ) if norm( t["name"] ) == norm( sci )] )
            or unique( by_sci.get( norm( sci ), [] ) )
            or unique( by_common.get( norm( common ), [] ) )
            or ( group_name( sci ) and unique( [
                t for t in by_sci.get( norm( group_name( sci ) ), [] )
                if norm( t["name"] ) == norm( group_name( sci ) )
            ] ) )
        )
        if taxon:
            codes_by_taxon.setdefault( taxon["id"], ( taxon, [] ) )[1].append( code )
        else:
            unmatched.append( f"{code} {common} ({sci})" )

    # Codes the list no longer has, but iNaturalist still knows
    for code, candidates in by_code.items():
        taxon = unique( candidates )
        if code not in ibp_codes and len( code ) == 4 and taxon:
            codes_by_taxon.setdefault( taxon["id"], ( taxon, [] ) )[1].append( code )

    entries = [
        [taxon["id"], taxon["name"], taxon["preferred_common_name"], taxon["rank"],
         taxon["rank_level"], taxon["ancestor_ids"], codes]
        for taxon, codes in sorted( codes_by_taxon.values(), key=lambda pair: pair[0]["id"] )
    ]
    with open( OUT, "w", encoding="utf-8" ) as file:
        json.dump( entries, file, ensure_ascii=False, separators=( ",", ":" ) )
    print( f"{sum( len( e[-1] ) for e in entries )} codes on {len( entries )} taxa -> {OUT}" )
    print( f"{len( unmatched )} codes with no iNaturalist taxon:" )
    print( "\n".join( unmatched ) )


if __name__ == "__main__":
    main()
