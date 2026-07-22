#import <ImageIO/ImageIO.h>
#import <React/RCTBridgeModule.h>
#import <React/RCTUtils.h>
#import <UIKit/UIKit.h>
#import <UniformTypeIdentifiers/UniformTypeIdentifiers.h>

// Lets the user grant access to a folder (e.g. on a USB drive mounted in
// Files) via the system document picker, persists that grant as a
// security-scoped bookmark, and copies not-yet-imported images out of the
// folder on demand. iOS offers no attach notification or unprompted volume
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
    exts = [NSSet setWithArray:@[@"jpg", @"jpeg", @"png", @"heic", @"heif",
                                 @"tif", @"tiff", @"dng", @"gif", @"webp", @"bmp"]];
  } );
  return [exts containsObject:name.pathExtension.lowercaseString];
}

// Copies images under the saved folder whose relative paths are not in
// knownNames into destDir. Resolves with { available, photos } — available is
// false when no folder is saved or the drive is not currently connected.
RCT_EXPORT_METHOD(importNewImages:(NSString *)destDir
                       knownNames:(NSArray<NSString *> *)knownNames
                         maxCount:(double)maxCount
                          resolve:(RCTPromiseResolveBlock)resolve
                           reject:(RCTPromiseRejectBlock)reject)
{
  NSURL *folder = resolveSavedFolder( );
  if ( !folder ) {
    // No bookmark saved: the user never picked a folder (or it was forgotten).
    resolve( @{ @"available": @NO, @"reason": @"no-folder-saved", @"photos": @[] } );
    return;
  }
  if ( ![folder startAccessingSecurityScopedResource] ) {
    // Bookmark resolved but iOS refused security-scoped access to it.
    resolve( @{ @"available": @NO, @"reason": @"access-denied", @"photos": @[] } );
    return;
  }
  if ( ![folder checkResourceIsReachableAndReturnError:nil] ) {
    // Folder resolved but isn't on disk right now — the drive is unplugged.
    [folder stopAccessingSecurityScopedResource];
    resolve( @{ @"available": @NO, @"reason": @"drive-disconnected", @"photos": @[] } );
    return;
  }

  NSFileManager *fm = [NSFileManager defaultManager];
  [fm createDirectoryAtPath:destDir withIntermediateDirectories:YES attributes:nil error:nil];

  NSSet<NSString *> *known = [NSSet setWithArray:knownNames ?: @[]];
  NSDirectoryEnumerator<NSURL *> *enumerator =
    [fm enumeratorAtURL:folder
      includingPropertiesForKeys:@[NSURLIsRegularFileKey, NSURLContentModificationDateKey,
                                   NSURLFileSizeKey]
                         options:NSDirectoryEnumerationSkipsHiddenFiles
                    errorHandler:nil];

  NSMutableArray<NSDictionary *> *candidates = [NSMutableArray array];
  NSUInteger folderPathLength = folder.path.length;
  // Diagnostic counters so the JS layer can tell an empty/disconnected drive
  // from one whose images have all already been imported.
  NSUInteger regularFileCount = 0;
  NSUInteger imageFileCount = 0;
  NSUInteger alreadyImportedCount = 0;
  for ( NSURL *file in enumerator ) {
    NSNumber *isRegular = nil;
    [file getResourceValue:&isRegular forKey:NSURLIsRegularFileKey error:nil];
    if ( isRegular.boolValue ) regularFileCount++;
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
    [candidates addObject:@{
      @"url": file,
      @"relativePath": relativePath,
      @"modified": modified ?: [NSDate distantPast],
    }];
  }

  // Newest first, so a huge archive drive yields its most recent photos
  // within the per-scan cap rather than years-old ones.
  [candidates sortUsingComparator:^NSComparisonResult( NSDictionary *a, NSDictionary *b ) {
    return [b[@"modified"] compare:a[@"modified"]];
  }];
  NSUInteger cap = maxCount > 0 ? (NSUInteger)maxCount : NSUIntegerMax;

  NSMutableArray<NSDictionary *> *photos = [NSMutableArray array];
  NSUInteger copyFailureCount = 0;
  for ( NSDictionary *candidate in candidates ) {
    if ( photos.count >= cap ) break;
    NSURL *src = candidate[@"url"];
    NSString *relativePath = candidate[@"relativePath"];
    NSString *destName = [relativePath stringByReplacingOccurrencesOfString:@"/"
                                                                 withString:@"_"];
    NSString *destPath = [destDir stringByAppendingPathComponent:destName];
    [fm removeItemAtPath:destPath error:nil];
    NSError *copyError = nil;
    // Byte-for-byte copy, so all EXIF (GPS, timestamp) is preserved.
    if ( ![fm copyItemAtURL:src toURL:[NSURL fileURLWithPath:destPath] error:&copyError] ) {
      copyFailureCount++;
      continue;
    }

    NSNumber *width = nil;
    NSNumber *height = nil;
    CGImageSourceRef imageSource =
      CGImageSourceCreateWithURL( (__bridge CFURLRef)[NSURL fileURLWithPath:destPath], NULL );
    if ( imageSource ) {
      NSDictionary *props = CFBridgingRelease(
        CGImageSourceCopyPropertiesAtIndex( imageSource, 0, NULL ) );
      width = props[(NSString *)kCGImagePropertyPixelWidth];
      height = props[(NSString *)kCGImagePropertyPixelHeight];
      CFRelease( imageSource );
    }

    NSNumber *fileSize = nil;
    [src getResourceValue:&fileSize forKey:NSURLFileSizeKey error:nil];
    NSDate *modified = candidate[@"modified"];
    [photos addObject:@{
      @"name": relativePath,
      @"uri": [NSString stringWithFormat:@"file://%@", destPath],
      @"fileName": destName,
      @"width": width ?: [NSNull null],
      @"height": height ?: [NSNull null],
      @"fileSize": fileSize ?: [NSNull null],
      @"timestamp": @( modified.timeIntervalSince1970 ),
    }];
  }

  [folder stopAccessingSecurityScopedResource];
  resolve( @{
    @"available": @YES,
    @"reason": @"ok",
    @"photos": photos,
    // Diagnostics: let JS log why a scan produced no photos.
    @"regularFileCount": @( regularFileCount ),
    @"imageFileCount": @( imageFileCount ),
    @"alreadyImportedCount": @( alreadyImportedCount ),
    @"copyFailureCount": @( copyFailureCount ),
  } );
}

@end
