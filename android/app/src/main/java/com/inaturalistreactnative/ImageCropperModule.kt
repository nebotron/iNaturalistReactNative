package org.inaturalist.iNaturalistMobile

import android.graphics.Bitmap
import android.graphics.BitmapFactory
import androidx.exifinterface.media.ExifInterface
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import java.io.File
import java.io.FileOutputStream

class ImageCropperModule(
  reactContext: ReactApplicationContext,
) : ReactContextBaseJavaModule( reactContext ) {
  override fun getName(): String = "ImageCropper"

  @ReactMethod
  fun cropImage(
    inputPath: String,
    originX: Int,
    originY: Int,
    width: Int,
    height: Int,
    outputPath: String,
    promise: Promise,
  ) {
    try {
      val normalizedInput = inputPath.replace( "file://", "" )
      val normalizedOutput = outputPath.replace( "file://", "" )
      val bitmap = BitmapFactory.decodeFile( normalizedInput )
      if ( bitmap == null ) {
        promise.reject( "CROP_FAILED", "Could not decode image" )
        return
      }

      val ox = originX.coerceIn( 0, bitmap.width - 1 )
      val oy = originY.coerceIn( 0, bitmap.height - 1 )
      val w = width.coerceIn( 1, bitmap.width - ox )
      val h = height.coerceIn( 1, bitmap.height - oy )
      val cropped = Bitmap.createBitmap( bitmap, ox, oy, w, h )

      File( normalizedOutput ).parentFile?.mkdirs()
      FileOutputStream( normalizedOutput ).use { out ->
        cropped.compress( Bitmap.CompressFormat.JPEG, 100, out )
      }

      copyExifMetadata( normalizedInput, normalizedOutput, w, h )

      if ( cropped != bitmap ) {
        cropped.recycle()
      }
      bitmap.recycle()
      promise.resolve( normalizedOutput )
    } catch ( error: Exception ) {
      promise.reject( "CROP_FAILED", error.message, error )
    }
  }

  @ReactMethod
  fun preserveImageMetadata(
    sourcePath: String,
    destPath: String,
    width: Int,
    height: Int,
    promise: Promise,
  ) {
    try {
      val normalizedSource = sourcePath.replace( "file://", "" )
      val normalizedDest = destPath.replace( "file://", "" )
      copyExifMetadata( normalizedSource, normalizedDest, width, height )
      promise.resolve( normalizedDest )
    } catch ( error: Exception ) {
      promise.reject( "CROP_FAILED", error.message, error )
    }
  }

  private fun copyExifMetadata(
    sourcePath: String,
    destPath: String,
    width: Int,
    height: Int,
  ) {
    try {
      val source = ExifInterface( sourcePath )
      val dest = ExifInterface( destPath )

      ExifInterface::class.java.fields
        .filter { field ->
          field.name.startsWith( "TAG_" ) && field.type == String::class.java
        }
        .mapNotNull { field ->
          try {
            field.get( null ) as? String
          } catch ( _error: Exception ) {
            null
          }
        }
        .filter { tag -> tag !in EXIF_TAGS_TO_SKIP }
        .forEach { tag ->
          source.getAttribute( tag )?.let { value ->
            dest.setAttribute( tag, value )
          }
        }

      dest.setAttribute( ExifInterface.TAG_IMAGE_WIDTH, width.toString() )
      dest.setAttribute( ExifInterface.TAG_IMAGE_LENGTH, height.toString() )
      dest.setAttribute( ExifInterface.TAG_PIXEL_X_DIMENSION, width.toString() )
      dest.setAttribute( ExifInterface.TAG_PIXEL_Y_DIMENSION, height.toString() )
      dest.setAttribute(
        ExifInterface.TAG_ORIENTATION,
        ExifInterface.ORIENTATION_NORMAL.toString(),
      )
      dest.saveAttributes()
    } catch ( _error: Exception ) {
      // Cropped image is still usable without metadata.
    }
  }

  companion object {
    private val EXIF_TAGS_TO_SKIP = setOf(
      ExifInterface.TAG_IMAGE_WIDTH,
      ExifInterface.TAG_IMAGE_LENGTH,
      ExifInterface.TAG_PIXEL_X_DIMENSION,
      ExifInterface.TAG_PIXEL_Y_DIMENSION,
      ExifInterface.TAG_ORIENTATION,
      ExifInterface.TAG_JPEG_INTERCHANGE_FORMAT,
      ExifInterface.TAG_JPEG_INTERCHANGE_FORMAT_LENGTH,
      ExifInterface.TAG_STRIP_OFFSETS,
      ExifInterface.TAG_STRIP_BYTE_COUNTS,
      ExifInterface.TAG_ROWS_PER_STRIP,
      ExifInterface.TAG_THUMBNAIL_IMAGE_LENGTH,
      ExifInterface.TAG_THUMBNAIL_IMAGE_WIDTH,
      ExifInterface.TAG_ORF_PREVIEW_IMAGE_START,
      ExifInterface.TAG_ORF_PREVIEW_IMAGE_LENGTH,
    )
  }
}
