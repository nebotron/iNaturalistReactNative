import { RealmContext } from "providers/contexts";
import type { RealmTaxon } from "realmModels/types";

const { useRealm } = RealmContext;

interface Species { taxonId: number; commonName: string }

// The common name the rest of the app shows, per the account's or app's locale
// (e.g. "AMRO · American Robin"), else the model's English name
const useCommonName = ( sp?: Species ) => {
  const realm = useRealm( );
  return sp && ( realm.objectForPrimaryKey<RealmTaxon>( "Taxon", sp.taxonId )
    ?.preferredCommonName || sp.commonName );
};

export default useCommonName;
