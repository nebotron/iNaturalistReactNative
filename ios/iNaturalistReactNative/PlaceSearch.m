#import <MapKit/MapKit.h>
#import <React/RCTBridgeModule.h>

// Apple Maps place search (addresses and points of interest) for the hotspot
// route fields. Keyless, and far closer to Google Maps' results than the OSM
// geocoders, which miss partial street addresses and most businesses.
@interface PlaceSearch : NSObject <RCTBridgeModule>
@end

@implementation PlaceSearch

RCT_EXPORT_MODULE( );

+ (BOOL)requiresMainQueueSetup { return NO; }

RCT_EXPORT_METHOD( search:( NSString * )query
                   latitude:( nonnull NSNumber * )latitude
                   longitude:( nonnull NSNumber * )longitude
                   radiusMeters:( nonnull NSNumber * )radiusMeters
                   limit:( nonnull NSNumber * )limit
                   resolve:( RCTPromiseResolveBlock )resolve
                   reject:( RCTPromiseRejectBlock )reject )
{
  MKLocalSearchRequest *request = [[MKLocalSearchRequest alloc] init];
  request.naturalLanguageQuery = query;
  request.resultTypes = MKLocalSearchResultTypeAddress
    | MKLocalSearchResultTypePointOfInterest;
  if ( radiusMeters.doubleValue > 0 ) {
    request.region = MKCoordinateRegionMakeWithDistance(
      CLLocationCoordinate2DMake( latitude.doubleValue, longitude.doubleValue ),
      radiusMeters.doubleValue * 2,
      radiusMeters.doubleValue * 2
    );
  }
  dispatch_async( dispatch_get_main_queue( ), ^{
    [[[MKLocalSearch alloc] initWithRequest:request]
      startWithCompletionHandler:^( MKLocalSearchResponse *response, NSError *error ) {
        // No matches comes back as an error; report it as an empty list.
        if ( error && error.code != MKErrorPlacemarkNotFound ) {
          reject( @"search_failed", error.localizedDescription, error );
          return;
        }
        NSMutableArray *results = [NSMutableArray array];
        for ( MKMapItem *item in response.mapItems ) {
          if ( results.count >= limit.unsignedIntegerValue ) break;
          CLLocationCoordinate2D coord = item.placemark.coordinate;
          NSString *address = item.placemark.title ?: @"";
          NSString *name = item.name ?: @"";
          // For a street address the name is the address's first line.
          NSString *displayName = name.length == 0 || [address hasPrefix:name]
            ? address
            : [NSString stringWithFormat:@"%@, %@", name, address];
          if ( displayName.length == 0 ) continue;
          [results addObject:@{
            @"place_id": [NSString stringWithFormat:@"apple-%f,%f", coord.latitude, coord.longitude],
            @"display_name": displayName,
            @"lat": [NSString stringWithFormat:@"%f", coord.latitude],
            @"lon": [NSString stringWithFormat:@"%f", coord.longitude],
          }];
        }
        resolve( results );
      }];
  } );
}

@end
