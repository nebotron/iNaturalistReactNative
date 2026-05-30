package org.inaturalist.iNaturalistMobile

import android.media.MediaExtractor
import android.media.MediaFormat
import android.media.MediaMetadataRetriever
import android.media.MediaMuxer
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import java.io.IOException
import java.nio.ByteBuffer
import java.util.regex.Pattern

class VideoAudioExtractorModule(
  reactContext: ReactApplicationContext,
) : ReactContextBaseJavaModule( reactContext ) {
  override fun getName(): String = "VideoAudioExtractor"

  @ReactMethod
  fun getVideoMetadata(
    videoPath: String,
    assetId: String?,
    promise: Promise,
  ) {
    val retriever = MediaMetadataRetriever()
    try {
      retriever.setDataSource( videoPath )

      val metadata = Arguments.createMap()
      val location = retriever.extractMetadata( MediaMetadataRetriever.METADATA_KEY_LOCATION )
      val timestamp = retriever.extractMetadata( MediaMetadataRetriever.METADATA_KEY_DATE )

      if ( location != null ) {
        parseIso6709Location( location )?.let { ( latitude, longitude ) ->
          metadata.putDouble( "latitude", latitude )
          metadata.putDouble( "longitude", longitude )
        }
      }

      if ( timestamp != null ) {
        metadata.putString( "timestamp", timestamp )
      }

      promise.resolve( metadata )
    } catch ( error: Exception ) {
      promise.reject( "READ_VIDEO_METADATA_FAILED", error.message, error )
    } finally {
      retriever.release()
    }
  }

  @ReactMethod
  fun extractAudio( videoPath: String, outputPath: String, promise: Promise ) {
    var extractor: MediaExtractor? = null
    var muxer: MediaMuxer? = null

    try {
      extractor = MediaExtractor()
      extractor.setDataSource( videoPath )

      var audioTrackIndex = -1
      for ( trackIndex in 0 until extractor.trackCount ) {
        val format = extractor.getTrackFormat( trackIndex )
        val mime = format.getString( MediaFormat.KEY_MIME ) ?: continue
        if ( mime.startsWith( "audio/" ) ) {
          audioTrackIndex = trackIndex
          break
        }
      }

      if ( audioTrackIndex < 0 ) {
        promise.reject( "NO_AUDIO_TRACK", "Video does not contain an audio track" )
        return
      }

      extractor.selectTrack( audioTrackIndex )
      val audioFormat = extractor.getTrackFormat( audioTrackIndex )

      muxer = MediaMuxer( outputPath, MediaMuxer.OutputFormat.MUXER_OUTPUT_MPEG_4 )
      val destinationTrackIndex = muxer.addTrack( audioFormat )
      muxer.start()

      val buffer = ByteBuffer.allocate( 1024 * 1024 )
      val bufferInfo = android.media.MediaCodec.BufferInfo()

      while ( true ) {
        bufferInfo.offset = 0
        bufferInfo.size = extractor.readSampleData( buffer, 0 )
        if ( bufferInfo.size < 0 ) {
          break
        }

        bufferInfo.presentationTimeUs = extractor.sampleTime
        bufferInfo.flags = extractor.sampleFlags
        muxer.writeSampleData( destinationTrackIndex, buffer, bufferInfo )
        extractor.advance()
      }

      promise.resolve( outputPath )
    } catch ( error: IOException ) {
      promise.reject( "EXTRACT_AUDIO_FAILED", error.message, error )
    } catch ( error: IllegalStateException ) {
      promise.reject( "EXTRACT_AUDIO_FAILED", error.message, error )
    } finally {
      try {
        muxer?.stop()
      } catch ( _error: IllegalStateException ) {
        // Muxer may not have started if extraction failed early.
      }
      muxer?.release()
      extractor?.release()
    }
  }

  private fun parseIso6709Location( location: String ): Pair<Double, Double>? {
    val pattern = Pattern.compile( "([+-]?\\d+(?:\\.\\d+)?)([+-]\\d+(?:\\.\\d+)?)" )
    val matcher = pattern.matcher( location )
    if ( !matcher.find() ) {
      return null
    }

    return Pair(
      matcher.group( 1 )!!.toDouble(),
      matcher.group( 2 )!!.toDouble(),
    )
  }
}
