#import <UIKit/UIKit.h>
#import <React/RCTViewManager.h>

// ─── View ─────────────────────────────────────────────────────────────────────

@interface PixelatedImageViewNative : UIView
@property (nonatomic, copy) NSString *uri;
@end

@implementation PixelatedImageViewNative {
  UIImageView          *_imageView;
  NSURLSessionDataTask *_task;
}

- (instancetype)init
{
  if ( (self = [super init]) ) {
    _imageView = [[UIImageView alloc] init];
    _imageView.contentMode               = UIViewContentModeScaleAspectFit;
    _imageView.layer.magnificationFilter = kCAFilterNearest;
    _imageView.layer.minificationFilter  = kCAFilterLinear;
    [self addSubview:_imageView];
  }
  return self;
}

- (void)layoutSubviews
{
  [super layoutSubviews];
  _imageView.frame = self.bounds;
}

- (void)setUri:(NSString *)uri
{
  if ( [_uri isEqualToString:uri] ) return;
  _uri = [uri copy];

  [_task cancel];
  _task = nil;
  _imageView.image = nil;

  if ( !uri.length ) return;

  NSURL *url = [NSURL URLWithString:uri];
  if ( !url ) return;

  if ( url.isFileURL ) {
    NSString *path = url.path;
    dispatch_async( dispatch_get_global_queue( QOS_CLASS_USER_INITIATED, 0 ), ^{
      UIImage *image = [UIImage imageWithContentsOfFile:path];
      dispatch_async( dispatch_get_main_queue(), ^{
        if ( [self->_uri isEqualToString:uri] ) self->_imageView.image = image;
      });
    });
    return;
  }

  __weak typeof(self) weakSelf = self;
  _task = [[NSURLSession sharedSession]
    dataTaskWithURL:url
    completionHandler:^( NSData *data, NSURLResponse *response, NSError *error ) {
      if ( !data ) return;
      UIImage *image = [UIImage imageWithData:data];
      if ( !image ) return;
      dispatch_async( dispatch_get_main_queue(), ^{
        typeof(weakSelf) strongSelf = weakSelf;
        if ( strongSelf && [strongSelf->_uri isEqualToString:uri] ) {
          strongSelf->_imageView.image = image;
        }
      });
    }];
  [_task resume];
}

@end

// ─── ViewManager ──────────────────────────────────────────────────────────────

@interface PixelatedImageViewManager : RCTViewManager
@end

@implementation PixelatedImageViewManager

RCT_EXPORT_MODULE( PixelatedImageView )

- (UIView *)view
{
  return [[PixelatedImageViewNative alloc] init];
}

RCT_EXPORT_VIEW_PROPERTY( uri, NSString )

@end
