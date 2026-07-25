#import <ImageIO/ImageIO.h>
#import <Photos/Photos.h>
#import <React/RCTBridgeModule.h>
#import <React/RCTUtils.h>
#import <UIKit/UIKit.h>
#import <UniformTypeIdentifiers/UniformTypeIdentifiers.h>

// Lets the user grant access to a folder (e.g. on a USB drive mounted in
// Files) via the system document picker, persists that grant as a
// security-scoped bookmark, then offloads not-yet-imported images: it lists
// them (listNewImages), saves each into the Photos library (saveImageToPhotos),
// and once the whole batch is safely saved, deletes them from the source
// (deleteSourceImages). iOS offers no attach notification or unprompted volume
// enumeration for third-party apps, so a one-time user pick is required;
// after that, scans need no interaction while the drive is connected.

static NSString *const kBookmarkKey = @"UsbStorageFolderBookmark";

@interface UsbStorage : NSObject <RCTBridgeModule, UIDocumentPickerDelegate>
@end

@implementation UsbStorage {
  RCTPromiseResolveBlock _pickResolve;
}

RCT_EXPORT_MODULE( );

+ (BOOL)requiresMainQueueSetup { return NO; }

static NSURL *resolveSavedFolder( void )
{
  NSData *bookmark = [[NSUserDefaults standardUserDefaults] dataForKey:kBookmarkKey];
  if ( !bookmark ) return nil;
  BOOL stale = NO;
  NSURL *url = [NSURL URLByResolvingBookmarkData:bookmark
                                         options:NSURLBookmarkResolutionWithoutUI
                                   relativeToURL:nil
                             bookmarkDataIsStale:&stale
                                           error:nil];
  if ( url && stale ) {
    // Refresh the bookmark so it keeps resolving across future unplugs.
    NSData *fresh = [url bookmarkDataWithOptions:0
                  includingResourceValuesForKeys:nil
                                   relativeToURL:nil
                                           error:nil];
    if ( fresh ) [[NSUserDefaults standardUserDefaults] setObject:fresh forKey:kBookmarkKey];
  }
  return url;
}

// ─── Folder selection ───────────────────────────────────────────────────────

RCT_EXPORT_METHOD(pickFolder:(RCTPromiseResolveBlock)resolve
                      reject:(__unused RCTPromiseRejectBlock)reject)
{
  dispatch_async( dispatch_get_main_queue( ), ^{
    self->_pickResolve = resolve;
    UIDocumentPickerViewController *picker = [[UIDocumentPickerViewController alloc]
      initForOpeningContentTypes:@[UTTypeFolder]];
    picker.delegate = self;
    [RCTPresentedViewController( ) presentViewController:picker animated:YES completion:nil];
  } );
}

- (void)documentPicker:(__unused UIDocumentPickerViewController *)controller
  didPickDocumentsAtURLs:(NSArray<NSURL *> *)urls
{
  NSURL *url = urls.firstObject;
  NSString *name = nil;
  if ( url && [url startAccessingSecurityScopedResource] ) {
    NSData *bookmark = [url bookmarkDataWithOptions:0
                     includingResourceValuesForKeys:nil
                                      relativeToURL:nil
                                              error:nil];
    if ( bookmark ) {
      [[NSUserDefaults standardUserDefaults] setObject:bookmark forKey:kBookmarkKey];
      name = url.lastPathComponent;
    }
    [url stopAccessingSecurityScopedResource];
  }
  if ( _pickResolve ) _pickResolve( name );
  _pickResolve = nil;
}

- (void)documentPickerWasCancelled:(__unused UIDocumentPickerViewController *)controller
{
  if ( _pickResolve ) _pickResolve( [NSNull null] );
  _pickResolve = nil;
}

RCT_EXPORT_METHOD(getFolderName:(RCTPromiseResolveBlock)resolve
                         reject:(__unused RCTPromiseRejectBlock)reject)
{
  NSURL *url = resolveSavedFolder( );
  resolve( url ? url.lastPathComponent : [NSNull null] );
}

// Diagnostics for a null getFolderName: distinguishes "no bookmark was ever
// saved" (folder never picked, or the pick didn't persist) from "a bookmark is
// saved but won't resolve right now" (typically the drive isn't mounted). Both
// otherwise surface identically as a null folder name.
RCT_EXPORT_METHOD(getFolderDiagnostics:(RCTPromiseResolveBlock)resolve
                                reject:(__unused RCTPromiseRejectBlock)reject)
{
  NSData *bookmark = [[NSUserDefaults standardUserDefaults] dataForKey:kBookmarkKey];
  if ( !bookmark ) {
    resolve( @{ @"bookmarkPresent": @NO, @"resolved": @NO,
                @"stale": @NO, @"reachable": @NO } );
    return;
  }
  BOOL stale = NO;
  NSURL *url = [NSURL URLByResolvingBookmarkData:bookmark
                                         options:NSURLBookmarkResolutionWithoutUI
                                   relativeToURL:nil
                             bookmarkDataIsStale:&stale
                                           error:nil];
  BOOL reachable = url ? [url checkResourceIsReachableAndReturnError:nil] : NO;
  resolve( @{
    @"bookmarkPresent": @YES,
    @"resolved": url ? @YES : @NO,
    @"stale": @( stale ),
    @"reachable": @( reachable ),
    @"bookmarkBytes": @( (double)bookmark.length ),
  } );
}

RCT_EXPORT_METHOD(forgetFolder:(RCTPromiseResolveBlock)resolve
                        reject:(__unused RCTPromiseRejectBlock)reject)
{
  [[NSUserDefaults standardUserDefaults] removeObjectForKey:kBookmarkKey];
  resolve( nil );
}

// ─── Import ─────────────────────────────────────────────────────────────────

static BOOL isImageFile( NSString *name )
{
  static NSSet<NSString *> *exts;
  static dispatch_once_t once;
  dispatch_once( &once, ^{
    exts = [NSSet setWithArray:@[
      // Standard formats.
      @"jpg", @"jpeg", @"png", @"heic", @"heif",
      @"tif", @"tiff", @"gif", @"webp", @"bmp",
      // Camera raw formats. A Canon EOS R7 card (folder 101EOSR7) held only
      // .cr3 files, so a raw-only shooter saw nothing import. ImageIO decodes
      // these, so dimensions still read. Covers the common vendors:
      @"dng", @"cr2", @"cr3", @"crw",   // Adobe, Canon
      @"nef", @"nrw",                   // Nikon
      @"arw", @"sr2", @"srf",           // Sony
      @"raf",                           // Fujifilm
      @"orf",                           // Olympus / OM System
      @"rw2",                           // Panasonic
      @"pef",                           // Pentax
      @"srw",                           // Samsung
      @"x3f",                           // Sigma
      @"rwl",                           // Leica
      @"3fr", @"fff",                   // Hasselblad
      @"iiq",                           // Phase One
    ]];
  } );
  return [exts containsObject:name.pathExtension.lowercaseString];
}

// Enumerates images under the saved folder whose relative paths are not in
// knownNames, newest first, capped at maxCount. Returns lightweight metadata
// only ({ relativePath, fileSize }) — nothing is copied here, so a full card
// can be listed cheaply. Resolves with { available, reason, images, ...diag }.
RCT_EXPORT_METHOD(listNewImages:(NSArray<NSString *> *)knownNames
                        maxCount:(double)maxCount
                         resolve:(RCTPromiseResolveBlock)resolve
                          reject:(__unused RCTPromiseRejectBlock)reject)
{
  NSURL *folder = resolveSavedFolder( );
  if ( !folder ) {
    resolve( @{ @"available": @NO, @"reason": @"no-folder-saved", @"images": @[] } );
    return;
  }
  if ( ![folder startAccessingSecurityScopedResource] ) {
    resolve( @{ @"available": @NO, @"reason": @"access-denied", @"images": @[] } );
    return;
  }
  if ( ![folder checkResourceIsReachableAndReturnError:nil] ) {
    [folder stopAccessingSecurityScopedResource];
    resolve( @{ @"available": @NO, @"reason": @"drive-disconnected", @"images": @[] } );
    return;
  }

  NSFileManager *fm = [NSFileManager defaultManager];
  NSSet<NSString *> *known = [NSSet setWithArray:knownNames ?: @[]];
  NSDirectoryEnumerator<NSURL *> *enumerator =
    [fm enumeratorAtURL:folder
      includingPropertiesForKeys:@[NSURLIsRegularFileKey, NSURLContentModificationDateKey,
                                   NSURLFileSizeKey]
                         options:NSDirectoryEnumerationSkipsHiddenFiles
                    errorHandler:nil];

  NSMutableArray<NSDictionary *> *candidates = [NSMutableArray array];
  NSUInteger folderPathLength = folder.path.length;
  NSUInteger regularFileCount = 0;
  NSUInteger imageFileCount = 0;
  NSUInteger alreadyImportedCount = 0;
  NSMutableDictionary<NSString *, NSNumber *> *extCounts = [NSMutableDictionary dictionary];
  for ( NSURL *file in enumerator ) {
    NSNumber *isRegular = nil;
    [file getResourceValue:&isRegular forKey:NSURLIsRegularFileKey error:nil];
    if ( isRegular.boolValue ) {
      regularFileCount++;
      NSString *ext = file.pathExtension.lowercaseString;
      if ( ext.length == 0 ) ext = @"(none)";
      extCounts[ext] = @( extCounts[ext].integerValue + 1 );
    }
    if ( !isRegular.boolValue || !isImageFile( file.lastPathComponent ) ) continue;
    imageFileCount++;
    // Relative path is the stable identity of a file on the drive; camera
    // filenames like DSC_0001.JPG repeat across DCIM subfolders.
    NSString *relativePath = [file.path substringFromIndex:folderPathLength + 1];
    if ( [known containsObject:relativePath] ) {
      alreadyImportedCount++;
      continue;
    }
    NSDate *modified = nil;
    [file getResourceValue:&modified forKey:NSURLContentModificationDateKey error:nil];
    NSNumber *fileSize = nil;
    [file getResourceValue:&fileSize forKey:NSURLFileSizeKey error:nil];
    [candidates addObject:@{
      @"relativePath": relativePath,
      @"modified": modified ?: [NSDate distantPast],
      @"fileSize": fileSize ?: [NSNull null],
    }];
  }

  // Newest first, so a huge archive drive offloads its most recent photos
  // within the per-scan cap rather than years-old ones.
  [candidates sortUsingComparator:^NSComparisonResult( NSDictionary *a, NSDictionary *b ) {
    return [b[@"modified"] compare:a[@"modified"]];
  }];
  NSUInteger cap = maxCount > 0 ? (NSUInteger)maxCount : NSUIntegerMax;

  NSMutableArray<NSDictionary *> *images = [NSMutableArray array];
  for ( NSDictionary *candidate in candidates ) {
    if ( images.count >= cap ) break;
    [images addObject:@{
      @"relativePath": candidate[@"relativePath"],
      @"fileSize": candidate[@"fileSize"],
    }];
  }

  [folder stopAccessingSecurityScopedResource];
  resolve( @{
    @"available": @YES,
    @"reason": @"ok",
    @"images": images,
    @"regularFileCount": @( regularFileCount ),
    @"imageFileCount": @( imageFileCount ),
    @"alreadyImportedCount": @( alreadyImportedCount ),
    @"extensions": extCounts,
  } );
}

static NSString *photosStatusString( PHAuthorizationStatus status )
{
  switch ( status ) {
    case PHAuthorizationStatusAuthorized: return @"authorized";
    case PHAuthorizationStatusLimited:    return @"limited";
    case PHAuthorizationStatusDenied:     return @"denied";
    case PHAuthorizationStatusRestricted: return @"restricted";
    default:                              return @"notDetermined";
  }
}

// Requests add-only Photos permission up front, before any save. Doing this
// once (rather than lazily on the first saveImageToPhotos) keeps the system
// prompt from appearing mid-loop where a blocking overlay could hide it and
// stall the whole run. Resolves the resulting status as a string.
RCT_EXPORT_METHOD(requestPhotosPermission:(RCTPromiseResolveBlock)resolve
                                   reject:(__unused RCTPromiseRejectBlock)reject)
{
  PHAuthorizationStatus current =
    [PHPhotoLibrary authorizationStatusForAccessLevel:PHAccessLevelAddOnly];
  if ( current != PHAuthorizationStatusNotDetermined ) {
    resolve( photosStatusString( current ) );
    return;
  }
  [PHPhotoLibrary requestAuthorizationForAccessLevel:PHAccessLevelAddOnly
                                             handler:^( PHAuthorizationStatus status ) {
    resolve( photosStatusString( status ) );
  }];
}

// Caps how many performChanges calls below can be in flight at once. PhotoKit
// queues concurrent asset-creation writes internally anyway; letting the
// JS-side per-file timeout (useUsbAutoImport) abandon a slow save and
// immediately start the next one previously let performChanges calls pile up
// unbounded, each making every other one slower — producing a cascade of
// growing timeouts on a large batch of RAW files. dispatch_semaphore_wait is
// called off the main thread (this module's own background queue), so
// blocking here doesn't freeze the UI.
static const long kMaxConcurrentPhotosWrites = 2;

static dispatch_semaphore_t photosWriteSemaphore( void )
{
  static dispatch_semaphore_t sem;
  static dispatch_once_t once;
  dispatch_once( &once, ^{ sem = dispatch_semaphore_create( kMaxConcurrentPhotosWrites ); } );
  return sem;
}

// Saves one source image (identified by its relative path under the saved
// folder) into the user's Photos library. The source is first copied into the
// app's temp directory because PHPhotoLibrary's performChanges runs
// asynchronously and may outlive our security-scoped access to the drive; the
// temp file is moved into Photos (shouldMoveFile) so no manual cleanup is
// needed on success. Does not delete the source — deletion happens as a batch
// only after the whole set is safely saved (see deleteSourceImages).
RCT_EXPORT_METHOD(saveImageToPhotos:(NSString *)relativePath
                            resolve:(RCTPromiseResolveBlock)resolve
                             reject:(RCTPromiseRejectBlock)reject)
{
  NSURL *folder = resolveSavedFolder( );
  if ( !folder || ![folder startAccessingSecurityScopedResource] ) {
    reject( @"unavailable", @"USB folder is not available", nil );
    return;
  }
  NSString *srcPath = [folder.path stringByAppendingPathComponent:relativePath];
  NSFileManager *fm = [NSFileManager defaultManager];
  NSString *tempPath = [NSTemporaryDirectory( ) stringByAppendingPathComponent:
    [[[NSUUID UUID] UUIDString] stringByAppendingPathExtension:relativePath.pathExtension]];
  NSError *copyError = nil;
  BOOL copied = [fm copyItemAtPath:srcPath toPath:tempPath error:&copyError];
  [folder stopAccessingSecurityScopedResource];
  if ( !copied ) {
    reject( @"copy-failed", copyError.localizedDescription ?: @"Could not read source file", copyError );
    return;
  }

  void ( ^saveBlock )( void ) = ^{
    dispatch_semaphore_wait( photosWriteSemaphore( ), DISPATCH_TIME_FOREVER );
    [[PHPhotoLibrary sharedPhotoLibrary] performChanges:^{
      PHAssetCreationRequest *request = [PHAssetCreationRequest creationRequestForAsset];
      PHAssetResourceCreationOptions *options = [[PHAssetResourceCreationOptions alloc] init];
      options.shouldMoveFile = YES;
      [request addResourceWithType:PHAssetResourceTypePhoto
                           fileURL:[NSURL fileURLWithPath:tempPath]
                           options:options];
    } completionHandler:^( BOOL success, NSError *error ) {
      dispatch_semaphore_signal( photosWriteSemaphore( ) );
      if ( !success ) [fm removeItemAtPath:tempPath error:nil];
      if ( success ) {
        resolve( @{ @"saved": @YES } );
      } else {
        reject( @"save-failed", error.localizedDescription ?: @"Could not save to Photos", error );
      }
    }];
  };

  if ( [PHPhotoLibrary authorizationStatusForAccessLevel:PHAccessLevelAddOnly]
       == PHAuthorizationStatusAuthorized ) {
    saveBlock( );
  } else {
    [PHPhotoLibrary requestAuthorizationForAccessLevel:PHAccessLevelAddOnly
                                               handler:^( PHAuthorizationStatus status ) {
      if ( status == PHAuthorizationStatusAuthorized || status == PHAuthorizationStatusLimited ) {
        saveBlock( );
      } else {
        [fm removeItemAtPath:tempPath error:nil];
        reject( @"no-permission", @"Photos permission not granted", nil );
      }
    }];
  }
}

// Deletes the given source files (by relative path) from the saved folder.
// Called only after every file in the batch has been confirmed saved to Photos.
RCT_EXPORT_METHOD(deleteSourceImages:(NSArray<NSString *> *)relativePaths
                             resolve:(RCTPromiseResolveBlock)resolve
                              reject:(__unused RCTPromiseRejectBlock)reject)
{
  NSURL *folder = resolveSavedFolder( );
  if ( !folder || ![folder startAccessingSecurityScopedResource] ) {
    resolve( @{ @"deleted": @0, @"failed": @( relativePaths.count ), @"available": @NO } );
    return;
  }
  NSFileManager *fm = [NSFileManager defaultManager];
  NSUInteger deleted = 0;
  NSUInteger failed = 0;
  for ( NSString *relativePath in relativePaths ) {
    NSString *path = [folder.path stringByAppendingPathComponent:relativePath];
    if ( [fm removeItemAtPath:path error:nil] ) {
      deleted++;
    } else {
      failed++;
    }
  }
  [folder stopAccessingSecurityScopedResource];
  resolve( @{ @"deleted": @( deleted ), @"failed": @( failed ), @"available": @YES } );
}

@end
