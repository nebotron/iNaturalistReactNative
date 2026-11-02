#import <ImageIO/ImageIO.h>
#import <React/RCTBridgeModule.h>
#import <React/RCTUtils.h>
#import <UIKit/UIKit.h>
#import <UniformTypeIdentifiers/UniformTypeIdentifiers.h>

// Lets the user grant access to a folder (e.g. on a USB drive mounted in
// Files) via the system document picker, persists that grant as a
// security-scoped bookmark, then offloads not-yet-imported images: it lists
// them (listNewImages), copies each into the app's import staging folder
// (copyImageToFile), and once the whole batch is safely copied, deletes them
// from the source (deleteSourceImages). iOS offers no attach notification or unprompted volume
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

// A device with no room left is not a per-file problem: every remaining file in
// the run will fail the same way, instantly. JS abandons the run on this code
// rather than grinding through the card — the Aug 6 log has 1,084 error lines
// in 74 seconds, one per file per retry, from exactly that. Reported as a code
// because the message is localizedDescription, i.e. the user's language.
static BOOL errorIsOutOfSpace( NSError *error )
{
  if ( !error ) return NO;
  if ( [error.domain isEqualToString:NSCocoaErrorDomain]
       && error.code == NSFileWriteOutOfSpaceError ) return YES;
  if ( [error.domain isEqualToString:NSPOSIXErrorDomain] && error.code == ENOSPC ) return YES;
  return errorIsOutOfSpace( error.userInfo[NSUnderlyingErrorKey] );
}

// The watched folder's own name and its parent's. A camera writes into a
// numbered subfolder of DCIM (DCIM/101EOSR7), and abandons it for the next one
// when the card is formatted or a different card is used — so a bookmark on
// that subfolder ends up resolving to a folder that is reachable, empty, and
// will never receive another photo, while the camera writes into a sibling the
// app has no access to. Reported so JS can say so instead of silently scanning
// an empty folder forever.
static void addFolderNames( NSMutableDictionary *dict, NSURL *url )
{
  dict[@"name"] = url.lastPathComponent ?: @"";
  dict[@"parentName"] = url.URLByDeletingLastPathComponent.lastPathComponent ?: @"";
}

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
  NSMutableDictionary *diagnostics = [@{
    @"bookmarkPresent": @YES,
    @"resolved": url ? @YES : @NO,
    @"stale": @( stale ),
    @"reachable": @( reachable ),
    @"bookmarkBytes": @( (double)bookmark.length ),
  } mutableCopy];
  if ( url ) addFolderNames( diagnostics, url );
  resolve( diagnostics );
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
      @"hif",                           // Canon's HEIF extension
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
    // A folder that won't resolve is nearly always a drive that isn't mounted,
    // not a folder the user never picked — and now that JS scans on the
    // interval while unplugged (so a drive attached mid-session is noticed),
    // this is the reason the log sees most. Reporting it as "no-folder-saved"
    // read as a feature nobody had set up.
    BOOL hasBookmark =
      [[NSUserDefaults standardUserDefaults] dataForKey:kBookmarkKey] != nil;
    resolve( @{ @"available": @NO,
                @"reason": hasBookmark ? @"drive-disconnected" : @"no-folder-saved",
                @"images": @[] } );
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
  NSUInteger directoryCount = 0;
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
    } else {
      // Counted so a folder with nothing at all in it — no files and no
      // subfolders, the state a camera subfolder is left in once its card has
      // been offloaded and the camera has moved to the next folder — is
      // distinguishable from a drive whose photos are simply somewhere the
      // scan can't reach.
      directoryCount++;
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
  NSMutableDictionary *result = [@{
    @"available": @YES,
    @"reason": @"ok",
    @"images": images,
    @"regularFileCount": @( regularFileCount ),
    @"directoryCount": @( directoryCount ),
    @"imageFileCount": @( imageFileCount ),
    @"alreadyImportedCount": @( alreadyImportedCount ),
    @"extensions": extCounts,
  } mutableCopy];
  addFolderNames( result, folder );
  resolve( result );
}

// Copies one source image into a file the app owns (the import staging folder),
// without going through Photos. Written to a temp name and renamed, so a copy
// interrupted midway never leaves a partial file at destPath.
RCT_EXPORT_METHOD(copyImageToFile:(NSString *)relativePath
                         destPath:(NSString *)destPath
                          resolve:(RCTPromiseResolveBlock)resolve
                           reject:(RCTPromiseRejectBlock)reject)
{
  dispatch_async( dispatch_get_global_queue( QOS_CLASS_UTILITY, 0 ), ^{
    NSURL *folder = resolveSavedFolder( );
    if ( !folder || ![folder startAccessingSecurityScopedResource] ) {
      reject( @"unavailable", @"USB folder is not available", nil );
      return;
    }
    NSFileManager *fm = [NSFileManager defaultManager];
    NSString *partial = [destPath stringByAppendingString:@".partial"];
    [fm removeItemAtPath:partial error:nil];
    [fm createDirectoryAtPath:destPath.stringByDeletingLastPathComponent
  withIntermediateDirectories:YES attributes:nil error:nil];
    NSError *error = nil;
    BOOL ok = [fm copyItemAtPath:[folder.path stringByAppendingPathComponent:relativePath]
                          toPath:partial error:&error]
      && [fm moveItemAtPath:partial toPath:destPath error:&error];
    [folder stopAccessingSecurityScopedResource];
    if ( ok ) {
      resolve( @{ @"copied": @YES } );
      return;
    }
    [fm removeItemAtPath:partial error:nil];
    reject( errorIsOutOfSpace( error )
              ? @"out-of-space"
              : @"copy-failed",
            error.localizedDescription ?: @"Could not copy source file",
            error );
  } );
}

// Deletes the given source files (by relative path) from the saved folder.
// Called only after every file in the batch has been confirmed copied.
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
