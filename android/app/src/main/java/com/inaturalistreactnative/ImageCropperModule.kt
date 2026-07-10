package org.inaturalist.iNaturalistMobile

import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.Matrix
import android.graphics.RectF
import android.media.MediaCodec
import android.media.MediaExtractor
import android.media.MediaFormat
import android.media.MediaMetadataRetriever
import android.media.MediaMuxer
import android.net.Uri
import androidx.exifinterface.media.ExifInterface
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import com.facebook.react.bridge.WritableMap
import com.facebook.react.bridge.WritableNativeMap
import com.google.mlkit.vision.common.InputImage
import com.google.mlkit.vision.objects.DetectedObject
import com.google.mlkit.vision.objects.ObjectDetection
import com.google.mlkit.vision.objects.defaults.ObjectDetectorOptions
import java.io.File
import java.io.FileOutputStream
import java.nio.ByteBuffer

class ImageCropperModule(
  reactContext: ReactApplicationContext,
) : ReactContextBaseJavaModule( reactContext ) {
  override fun getName(): String = "ImageCropper"

  private val objectDetector by lazy {
    val options = ObjectDetectorOptions.Builder()
      .setDetectorMode( ObjectDetectorOptions.SINGLE_IMAGE_MODE )
      .enableMultipleObjects()
      .enableClassification()
      .build()
    ObjectDetection.getClient( options )
  }

  // BitmapFactory.decodeFile returns raw pixel data without applying EXIF orientation.
  // React Native's Image.getSize returns display-oriented dimensions (EXIF applied).
  // This helper rotates the bitmap to match the display orientation so that crop
  // coordinates computed in JavaScript map correctly onto the bitmap pixels.
  private fun applyExifRotation( path: String, bitmap: Bitmap ): Bitmap {
    val exif = try {
      ExifInterface( path )
    } catch ( _: Exception ) {
      return bitmap
    }
    val degrees = when (
      exif.getAttributeInt( ExifInterface.TAG_ORIENTATION, ExifInterface.ORIENTATION_NORMAL )
    ) {
      ExifInterface.ORIENTATION_ROTATE_90 -> 90f
      ExifInterface.ORIENTATION_ROTATE_180 -> 180f
      ExifInterface.ORIENTATION_ROTATE_270 -> 270f
      else -> return bitmap
    }
    val matrix = Matrix()
    matrix.postRotate( degrees )
    return Bitmap.createBitmap( bitmap, 0, 0, bitmap.width, bitmap.height, matrix, true )
  }


  // Decodes a bitmap subsampled to roughly maxDimension on its longest side.
  // Detection outputs normalized coords, so a downscaled input yields the same
  // bounds without paying the full-resolution decode cost.
  private fun decodeDownscaled( path: String, maxDimension: Int ): Bitmap? {
    val boundsOptions = BitmapFactory.Options().apply { inJustDecodeBounds = true }
    BitmapFactory.decodeFile( path, boundsOptions )
    val largestSide = maxOf( boundsOptions.outWidth, boundsOptions.outHeight )
    val decodeOptions = BitmapFactory.Options()
    if ( largestSide > 0 ) {
      var sampleSize = 1
      while ( largestSide / ( sampleSize * 2 ) >= maxDimension ) {
        sampleSize *= 2
      }
      decodeOptions.inSampleSize = sampleSize
    }
    return BitmapFactory.decodeFile( path, decodeOptions )
  }

  @ReactMethod
  fun detectSubjectBounds(
    inputPath: String,
    model: String?,
    promise: Promise,
  ) {
    try {
      val normalizedInput = inputPath.replace( "file://", "" )
      val rawBitmap = decodeDownscaled( normalizedInput, 1024 )
      if ( rawBitmap == null ) {
        promise.resolve( null )
        return
      }

      val bitmap = applyExifRotation( normalizedInput, rawBitmap )
      if ( bitmap != rawBitmap ) {
        rawBitmap.recycle()
      }


      val inputImage = InputImage.fromBitmap( bitmap, 0 )
      objectDetector.process( inputImage )
        .addOnSuccessListener { detectedObjects ->
          val bounds = unionDetectedObjectBounds(
            detectedObjects,
            bitmap.width,
            bitmap.height,
          )
          bitmap.recycle()
          promise.resolve( bounds )
        }
        .addOnFailureListener {
          bitmap.recycle()
          promise.resolve( null )
        }
    } catch ( _error: Exception ) {
      promise.resolve( null )
    }
  }

  private fun rectToWritableMap(
    rect: RectF,
  ): WritableMap? {
    val width = rect.right - rect.left
    val height = rect.bottom - rect.top
    if ( width <= 0f || height <= 0f ) {
      return null
    }

    return WritableNativeMap().apply {
      putDouble( "x", rect.left.toDouble() )
      putDouble( "y", rect.top.toDouble() )
      putDouble( "width", width.toDouble() )
      putDouble( "height", height.toDouble() )
    }
  }

  private fun detectedObjectToNormalizedRect(
    detectedObject: DetectedObject,
    imageWidth: Int,
    imageHeight: Int,
  ): RectF {
    val box = detectedObject.boundingBox
    return RectF(
      box.left.toFloat() / imageWidth,
      box.top.toFloat() / imageHeight,
      box.right.toFloat() / imageWidth,
      box.bottom.toFloat() / imageHeight,
    )
  }

  private fun detectedObjectScore(
    detectedObject: DetectedObject,
    rect: RectF,
  ): Float {
    val areaScore = kotlin.math.sqrt( rect.width( ) * rect.height( ) )
    val trackingScore = detectedObject.trackingId?.toFloat( ) ?: 1f
    val classificationBoost = detectedObject.labels.maxOfOrNull { label ->
      label.confidence
    } ?: 0f
    return areaScore * trackingScore * ( 1f + classificationBoost )
  }

  private fun unionDetectedObjectBounds(
    detectedObjects: List<DetectedObject>,
    imageWidth: Int,
    imageHeight: Int,
  ): WritableMap? {
    if ( detectedObjects.isEmpty( ) || imageWidth <= 0 || imageHeight <= 0 ) {
      return null
    }

    var unionRect: RectF? = null
    detectedObjects.forEach { detectedObject ->
      val normalized = detectedObjectToNormalizedRect(
        detectedObject,
        imageWidth,
        imageHeight,
      )
      unionRect = if ( unionRect == null ) {
        normalized
      } else {
        RectF(
          minOf( unionRect!!.left, normalized.left ),
          minOf( unionRect!!.top, normalized.top ),
          maxOf( unionRect!!.right, normalized.right ),
          maxOf( unionRect!!.bottom, normalized.bottom ),
        )
      }
    }

    return unionRect?.let( ::rectToWritableMap )
  }

  private fun bestWeightedDetectedObjectBounds(
    detectedObjects: List<DetectedObject>,
    imageWidth: Int,
    imageHeight: Int,
  ): WritableMap? {
    if ( detectedObjects.isEmpty( ) || imageWidth <= 0 || imageHeight <= 0 ) {
      return null
    }

    val bestRect = detectedObjects
      .map { detectedObject ->
        val rect = detectedObjectToNormalizedRect(
          detectedObject,
          imageWidth,
          imageHeight,
        )
        detectedObject to detectedObjectScore( detectedObject, rect )
      }
      .maxByOrNull { ( _, score ) -> score }
      ?.first
      ?: return null

    return rectToWritableMap(
      detectedObjectToNormalizedRect(
        bestRect,
        imageWidth,
        imageHeight,
      ),
    )
  }

  private fun largestDetectedObjectBounds(
    detectedObjects: List<DetectedObject>,
    imageWidth: Int,
    imageHeight: Int,
  ): WritableMap? {
    if ( detectedObjects.isEmpty( ) || imageWidth <= 0 || imageHeight <= 0 ) {
      return null
    }

    val largestRect = detectedObjects
      .maxByOrNull { detectedObject ->
        val rect = detectedObjectToNormalizedRect(
          detectedObject,
          imageWidth,
          imageHeight,
        )
        rect.width( ) * rect.height( )
      }
      ?: return null

    return rectToWritableMap(
      detectedObjectToNormalizedRect(
        largestRect,
        imageWidth,
        imageHeight,
      ),
    )
  }

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
      val rawBitmap = BitmapFactory.decodeFile( normalizedInput )
      if ( rawBitmap == null ) {
        promise.reject( "CROP_FAILED", "Could not decode image" )
        return
      }

      // Rotate to display orientation so the crop coordinates from JavaScript
      // (which use display-oriented dimensions from React Native's Image.getSize)
      // align with the bitmap pixels.
      val bitmap = applyExifRotation( normalizedInput, rawBitmap )
      if ( bitmap != rawBitmap ) {
        rawBitmap.recycle()
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

  @ReactMethod
  fun extractAudioFromVideo( videoUri: String, destPath: String, promise: Promise ) {
    Thread {
      try {
        val normalizedOutput = destPath.replace( "file://", "" )
        File( normalizedOutput ).parentFile?.mkdirs()

        val extractor = MediaExtractor()
        if ( videoUri.startsWith( "content://" ) ) {
          extractor.setDataSource( reactApplicationContext, Uri.parse( videoUri ), null )
        } else {
          extractor.setDataSource( videoUri.replace( "file://", "" ) )
        }

        var audioTrack = -1
        var audioFormat: MediaFormat? = null
        for ( i in 0 until extractor.trackCount ) {
          val fmt = extractor.getTrackFormat( i )
          val mime = fmt.getString( MediaFormat.KEY_MIME ) ?: continue
          if ( mime.startsWith( "audio/" ) ) { audioTrack = i; audioFormat = fmt; break }
        }
        if ( audioTrack < 0 || audioFormat == null ) {
          extractor.release()
          promise.reject( "AUDIO_EXTRACT_FAILED", "No audio track found" )
          return@Thread
        }

        extractor.selectTrack( audioTrack )
        val muxer = MediaMuxer( normalizedOutput, MediaMuxer.OutputFormat.MUXER_OUTPUT_MPEG_4 )
        val muxerTrack = muxer.addTrack( audioFormat )
        muxer.start()

        val buf = ByteBuffer.allocate( 1024 * 1024 )
        val info = MediaCodec.BufferInfo()
        while ( true ) {
          val size = extractor.readSampleData( buf, 0 )
          if ( size < 0 ) break
          info.offset = 0; info.size = size
          info.presentationTimeUs = extractor.sampleTime
          info.flags = extractor.sampleFlags
          muxer.writeSampleData( muxerTrack, buf, info )
          extractor.advance()
        }
        muxer.stop(); muxer.release(); extractor.release()
        promise.resolve( "file://$normalizedOutput" )
      } catch ( e: Exception ) {
        promise.reject( "AUDIO_EXTRACT_FAILED", e.message, e )
      }
    }.start()
  }

  @ReactMethod
  fun convertVideoToGif( videoUri: String, destPath: String, promise: Promise ) {
    Thread {
      try {
        val normalizedInput = videoUri.replace( "file://", "" )
        val normalizedOutput = destPath.replace( "file://", "" )
        File( normalizedOutput ).parentFile?.mkdirs()

        val retriever = MediaMetadataRetriever()
        if ( videoUri.startsWith( "content://" ) ) {
          retriever.setDataSource( reactApplicationContext, Uri.parse( videoUri ) )
        } else {
          retriever.setDataSource( normalizedInput )
        }

        val durationMs = retriever.extractMetadata( MediaMetadataRetriever.METADATA_KEY_DURATION )
          ?.toLongOrNull() ?: 1000L
        val cappedMs = minOf( durationMs, 10_000L )
        val fps = 2
        val numFrames = minOf( ( cappedMs * fps / 1000 ).toInt(), 20 ).coerceAtLeast( 1 )

        val maxDim = 480
        FileOutputStream( normalizedOutput ).use { fos ->
          val gif = GifWriter( fos )
          gif.start()
          for ( i in 0 until numFrames ) {
            val timeUs = ( cappedMs * 1000L / numFrames ) * i
            val bmp = retriever.getFrameAtTime( timeUs, MediaMetadataRetriever.OPTION_CLOSEST_SYNC )
              ?: continue
            val scaled = if ( bmp.width > maxDim || bmp.height > maxDim ) {
              val ratio = minOf( maxDim.toFloat() / bmp.width, maxDim.toFloat() / bmp.height )
              Bitmap.createScaledBitmap(
                bmp,
                ( bmp.width * ratio ).toInt().coerceAtLeast( 1 ),
                ( bmp.height * ratio ).toInt().coerceAtLeast( 1 ),
                true,
              )
            } else bmp
            gif.addFrame( scaled )
            if ( scaled != bmp ) scaled.recycle()
            bmp.recycle()
          }
          gif.finish()
        }
        retriever.release()
        promise.resolve( "file://$normalizedOutput" )
      } catch ( e: Exception ) {
        promise.reject( "GIF_FAILED", e.message, e )
      }
    }.start()
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
