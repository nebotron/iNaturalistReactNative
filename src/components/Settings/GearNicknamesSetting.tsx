import GearNicknameSheet from "components/GearNicknames/GearNicknameSheet";
import {
  Body3, Body4, Heading4,
} from "components/SharedComponents";
import { Pressable, View } from "components/styledComponents";
import { RealmContext } from "providers/contexts";
import React, { useMemo, useState } from "react";
import type { RealmObservation } from "realmModels/types";
import type { GearKind } from "sharedHelpers/gearNicknames";
import type { PhotoCameraInfo } from "sharedHelpers/photoCameraInfo";
import { useGearNicknames, useTranslation } from "sharedHooks";

const { useQuery } = RealmContext;

const KINDS: GearKind[] = ["camera", "lens"];

// Every camera and lens in photos added on this device, each renamable
const GearNicknamesSetting = ( ) => {
  const { t } = useTranslation( );
  const observations = useQuery<RealmObservation>( "Observation" );
  const { nicknames } = useGearNicknames( );
  const [editing, setEditing] = useState<{ kind: GearKind; name: string } | null>( null );

  const gear = useMemo( ( ) => {
    const found: Record<GearKind, Set<string>> = { camera: new Set( ), lens: new Set( ) };
    observations.forEach( observation => {
      observation.observationPhotos?.forEach( obsPhoto => {
        if ( !obsPhoto.cameraInfo ) return;
        let info: PhotoCameraInfo;
        try {
          info = JSON.parse( obsPhoto.cameraInfo );
        } catch {
          return;
        }
        KINDS.forEach( kind => {
          const name = info[kind];
          if ( name ) found[kind].add( name );
        } );
      } );
    } );
    // Nicknamed gear stays listed even with no photos left, so it can be cleared
    KINDS.forEach( kind => {
      Object.keys( nicknames[kind] ?? {} ).forEach( name => found[kind].add( name ) );
    } );
    return KINDS.map( kind => ( {
      kind,
      names: [...found[kind]].sort( ( a, b ) => a.localeCompare( b ) ),
    } ) );
  }, [observations, nicknames] );

  const empty = gear.every( ( { names } ) => names.length === 0 );

  return (
    <View className="mt-[30px]">
      <Heading4 className="mb-[15px]">{t( "CAMERA-AND-LENS-NICKNAMES" )}</Heading4>
      <Body3 className="mb-[15px]">
        {empty
          ? t( "Cameras-and-lenses-appear-here-once-you-add-photos" )
          : t( "Give-your-cameras-and-lenses-nicknames" )}
      </Body3>
      {gear.filter( ( { names } ) => names.length > 0 ).map( ( { kind, names } ) => (
        <View key={kind} className="mb-[15px]">
          <Body3 className="font-bold mb-1">
            {kind === "camera"
              ? t( "Camera" )
              : t( "Lens" )}
          </Body3>
          {names.map( name => {
            const nickname = nicknames[kind]?.[name];
            return (
              <Pressable
                key={name}
                accessibilityRole="button"
                accessibilityHint={t( "Renames-this-camera-or-lens" )}
                className="py-2 border-b border-lightGray"
                onPress={( ) => setEditing( { kind, name } )}
              >
                <Body3>{nickname || name}</Body3>
                {nickname && <Body4 className="text-darkGrayDisabled">{name}</Body4>}
              </Pressable>
            );
          } )}
        </View>
      ) )}
      {editing && (
        <GearNicknameSheet
          kind={editing.kind}
          name={editing.name}
          onPressClose={( ) => setEditing( null )}
        />
      )}
    </View>
  );
};

export default GearNicknamesSetting;
