/* eslint-disable i18next/no-literal-string */
import classnames from "classnames";
import { fontMonoClass, Pressable, View } from "components/styledComponents";
import React, { useCallback } from "react";
import { FlatList, Text } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import type { NetworkLogEntry } from "sharedHelpers/networkLogger";
import { useNetworkLog } from "sharedHelpers/networkLogger";

function formatBytes( bytes: number ): string {
  if ( bytes <= 0 ) return "–";
  if ( bytes < 1024 ) return `${bytes} B`;
  if ( bytes < 1024 * 1024 ) return `${( bytes / 1024 ).toFixed( 1 )} KB`;
  return `${( bytes / ( 1024 * 1024 ) ).toFixed( 1 )} MB`;
}

function formatTime( epochMs: number ): string {
  const d = new Date( epochMs );
  const hh = String( d.getHours( ) ).padStart( 2, "0" );
  const mm = String( d.getMinutes( ) ).padStart( 2, "0" );
  const ss = String( d.getSeconds( ) ).padStart( 2, "0" );
  const ms = String( d.getMilliseconds( ) ).padStart( 3, "0" );
  return `${hh}:${mm}:${ss}.${ms}`;
}

function formatLatency( ms: number | null ): string {
  if ( ms === null ) return "…";
  if ( ms >= 1000 ) return `${( ms / 1000 ).toFixed( 2 )}s`;
  return `${ms}ms`;
}

function shortenUrl( url: string ): string {
  try {
    const parsed = new URL( url );
    return `${parsed.hostname}${parsed.pathname}`;
  } catch {
    return url;
  }
}

function methodColor( method: string ): string {
  if ( method === "POST" || method === "PUT" || method === "PATCH" ) return "bg-warningYellow";
  if ( method === "DELETE" ) return "bg-warningRed";
  return "bg-darkGray";
}

function latencyColor( ms: number | null ): string {
  if ( ms === null ) return "text-mediumGray";
  if ( ms >= 1000 ) return "text-warningRed";
  if ( ms >= 200 ) return "text-warningYellow";
  return "text-inatGreen";
}

interface RowProps {
  entry: NetworkLogEntry;
}

const Row = React.memo( ( { entry }: RowProps ) => {
  const isError = entry.latencyMs !== null && entry.status === 0;
  const is4xx5xx = entry.status >= 400;

  return (
    <View className="px-3 py-2 border-b border-lightGray">
      <View className="flex-row items-center flex-wrap gap-x-2">
        <Text className={classnames( fontMonoClass, "text-xs text-mediumGray" )}>
          {formatTime( entry.startTime )}
        </Text>
        <View className={classnames( "px-1.5 rounded-sm", methodColor( entry.method ) )}>
          <Text className="text-xs text-white font-bold">{entry.method}</Text>
        </View>
        {entry.status > 0 && (
          <Text
            className={classnames(
              fontMonoClass,
              "text-xs",
              is4xx5xx || isError
                ? "text-warningRed"
                : "text-darkGray",
            )}
          >
            {entry.status}
          </Text>
        )}
        <Text className={classnames( fontMonoClass, "text-xs", latencyColor( entry.latencyMs ) )}>
          {formatLatency( entry.latencyMs )}
        </Text>
        <Text className={classnames( fontMonoClass, "text-xs text-mediumGray" )}>
          {formatBytes( entry.responseBytes )}
        </Text>
        {entry.cacheHit !== null && (
          <View
            className={classnames(
              "px-1 rounded-sm",
              entry.cacheHit
                ? "bg-inatGreen"
                : "bg-mediumGray",
            )}
          >
            <Text className="text-xs text-white">
              {entry.cacheHit
                ? "HIT"
                : "MISS"}
            </Text>
          </View>
        )}
      </View>
      <Text
        className={classnames( fontMonoClass, "text-xs text-darkGray mt-0.5" )}
        numberOfLines={1}
      >
        {shortenUrl( entry.url )}
      </Text>
    </View>
  );
} );

const keyExtractor = ( item: NetworkLogEntry ) => item.id;
const renderItem = ( { item }: { item: NetworkLogEntry } ) => <Row entry={item} />;

const NetworkLog = ( ) => {
  const { entries, clearNetworkLog } = useNetworkLog( );
  const { top } = useSafeAreaInsets( );

  const onClear = useCallback( ( ) => clearNetworkLog( ), [clearNetworkLog] );

  return (
    <View className="flex-1 bg-white" style={{ paddingTop: top }}>
      <View className="flex-row items-center justify-between px-4 py-3 border-b border-lightGray">
        <Text className="text-md font-bold text-darkGray">
          {`NETWORK LOG (${entries.length})`}
        </Text>
        <Pressable
          accessibilityRole="button"
          className="px-3 py-1.5 rounded bg-darkGray active:opacity-75"
          onPress={onClear}
        >
          <Text className="text-xs text-white">CLEAR</Text>
        </Pressable>
      </View>
      <FlatList
        data={entries}
        keyExtractor={keyExtractor}
        renderItem={renderItem}
        ListEmptyComponent={(
          <View className="p-6">
            <Text className="text-sm text-mediumGray text-center">No requests yet</Text>
          </View>
        )}
      />
    </View>
  );
};

export default NetworkLog;
