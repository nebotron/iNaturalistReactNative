package org.inaturalist.iNaturalistMobile

import android.graphics.Bitmap
import java.io.OutputStream

// Produces animated GIF files.
// Uses NeuQuant (Anthony Dekker / Kevin Weiner Java port) for color quantization
// and a standard GIF89a LZW encoder.
class GifWriter( private val out: OutputStream ) {
  private var firstFrame = true
  private val delayCs = 50 // centiseconds per frame (2 fps)

  fun start() {
    out.write( "GIF89a".toByteArray() )
  }

  fun addFrame( bitmap: Bitmap ) {
    val w = bitmap.width
    val h = bitmap.height
    val pixelCount = w * h

    val raw = IntArray( pixelCount )
    bitmap.getPixels( raw, 0, w, 0, 0, w, h )

    // Build RGB byte array (R, G, B order) for NeuQuant
    val rgb = ByteArray( pixelCount * 3 )
    for ( i in 0 until pixelCount ) {
      val p = raw[i]
      rgb[i * 3]     = ( ( p shr 16 ) and 0xFF ).toByte()
      rgb[i * 3 + 1] = ( ( p shr 8 ) and 0xFF ).toByte()
      rgb[i * 3 + 2] = ( p and 0xFF ).toByte()
    }

    val nq = NeuQuant( rgb, 10 )
    val palette = nq.buildColormap() // 768 bytes: B G R order from NeuQuant

    // Map each pixel to nearest palette index
    val indices = ByteArray( pixelCount )
    for ( i in 0 until pixelCount ) {
      val r = rgb[i * 3].toInt() and 0xFF
      val g = rgb[i * 3 + 1].toInt() and 0xFF
      val b = rgb[i * 3 + 2].toInt() and 0xFF
      indices[i] = nq.map( b, g, r ).toByte()
    }

    if ( firstFrame ) {
      writeLSD( w, h )
      writePalette( palette )
      writeNetscapeExt()
    }
    writeGCE()
    writeImageDesc( w, h, firstFrame )
    if ( !firstFrame ) writePalette( palette )
    LZWEncoder( w, h, indices, 8 ).encode( out )
    firstFrame = false
  }

  fun finish() {
    out.write( 0x3B ) // GIF trailer
    out.flush()
  }

  private fun writeLSD( w: Int, h: Int ) {
    out.write( w and 0xFF ); out.write( ( w shr 8 ) and 0xFF )
    out.write( h and 0xFF ); out.write( ( h shr 8 ) and 0xFF )
    out.write( 0xF7 ) // GCT flag=1, color res=7, sort=0, GCT size=7 (256 colors)
    out.write( 0 ); out.write( 0 )
  }

  private fun writePalette( palette: ByteArray ) {
    out.write( palette )
    val pad = 768 - palette.size
    repeat( pad ) { out.write( 0 ) }
  }

  private fun writeNetscapeExt() {
    out.write( byteArrayOf(
      0x21.toByte(), 0xFF.toByte(), 11,
      *"NETSCAPE2.0".toByteArray(),
      3, 1, 0, 0, 0,
    ) )
  }

  private fun writeGCE() {
    out.write( byteArrayOf(
      0x21.toByte(), 0xF9.toByte(), 4, 0,
      ( delayCs and 0xFF ).toByte(), ( ( delayCs shr 8 ) and 0xFF ).toByte(),
      0, 0,
    ) )
  }

  private fun writeImageDesc( w: Int, h: Int, global: Boolean ) {
    out.write( 0x2C )
    out.write( 0 ); out.write( 0 ); out.write( 0 ); out.write( 0 )
    out.write( w and 0xFF ); out.write( ( w shr 8 ) and 0xFF )
    out.write( h and 0xFF ); out.write( ( h shr 8 ) and 0xFF )
    out.write( if ( global ) 0 else 0x87 ) // local color table on subsequent frames
  }
}

// GIF LZW encoder (standard algorithm).
private class LZWEncoder(
  private val width: Int,
  private val height: Int,
  private val pixels: ByteArray,
  codeSize: Int,
) {
  private val initCodeSize = maxOf( 2, codeSize )

  fun encode( os: OutputStream ) {
    os.write( initCodeSize )

    val accum = ByteArray( 256 )
    val htab = IntArray( HTS ) { -1 }
    val codetab = IntArray( HTS )

    val clearCode = 1 shl initCodeSize
    val eofCode = clearCode + 1
    var freeEnt = clearCode + 2
    var curAccum = 0; var curBits = 0; var aCount = 0
    var codeSize = initCodeSize + 1
    var maxCode = 1 shl codeSize

    fun flush() {
      if ( aCount > 0 ) { os.write( aCount ); os.write( accum, 0, aCount ); aCount = 0 }
    }

    fun emit( code: Int ) {
      curAccum = curAccum or ( code shl curBits ); curBits += codeSize
      while ( curBits >= 8 ) {
        accum[aCount++] = ( curAccum and 0xFF ).toByte()
        curAccum = curAccum ushr 8; curBits -= 8
        if ( aCount >= 255 ) flush()
      }
    }

    fun reset() {
      htab.fill( -1 ); freeEnt = clearCode + 2
      emit( clearCode ); codeSize = initCodeSize + 1; maxCode = 1 shl codeSize
    }

    emit( clearCode )

    var ent = pixels[0].toInt() and 0xFF
    for ( i in 1 until pixels.size ) {
      val c = pixels[i].toInt() and 0xFF
      val fcode = ( c shl BITS ) + ent
      var idx = ( c shl 3 ) xor ent

      if ( htab[idx] == fcode ) {
        ent = codetab[idx]
      } else {
        if ( htab[idx] >= 0 ) {
          var disp = HTS - idx; if ( idx == 0 ) disp = 1
          do { idx -= disp; if ( idx < 0 ) idx += HTS } while ( htab[idx] >= 0 && htab[idx] != fcode )
        }
        if ( htab[idx] == fcode ) {
          ent = codetab[idx]
        } else {
          emit( ent ); ent = c
          if ( freeEnt < MAXCODE ) { codetab[idx] = freeEnt++; htab[idx] = fcode }
          else { reset() }
          if ( freeEnt > maxCode && codeSize < BITS ) {
            codeSize++; maxCode = if ( codeSize == BITS ) MAXCODE else 1 shl codeSize
          }
        }
      }
    }

    emit( ent ); emit( eofCode )
    if ( curBits > 0 ) accum[aCount++] = ( curAccum and 0xFF ).toByte()
    flush()
    os.write( 0 )
  }

  companion object { const val BITS = 12; const val HTS = 5003; const val MAXCODE = 1 shl BITS }
}

// NeuQuant color quantizer — port of Anthony Dekker's algorithm (Java version by Kevin Weiner).
// Produces a 768-byte palette (256 colors × B G R bytes).
class NeuQuant( private val pixels: ByteArray, sampleFac: Int ) {
  private val netsize = 256
  private val sfac = sampleFac.coerceIn( 1, 30 )

  private val net = Array( netsize ) { i ->
    val v = ( ( i shl ( netbiasshift + 8 ) ) / netsize )
    intArrayOf( v, v, v, 0 )
  }
  private val netindex = IntArray( 256 )
  private val bias = IntArray( netsize )
  private val freq = IntArray( netsize ) { intbias / netsize }
  private val radpower = IntArray( initrad )

  fun buildColormap(): ByteArray {
    learn(); unbiasnet(); buildIndex()
    val map = ByteArray( netsize * 3 )
    for ( i in 0 until netsize ) {
      map[i * 3]     = net[i][2].toByte()
      map[i * 3 + 1] = net[i][1].toByte()
      map[i * 3 + 2] = net[i][0].toByte()
    }
    return map
  }

  fun map( b: Int, g: Int, r: Int ): Int {
    var bestd = Int.MAX_VALUE; var best = -1
    var i = netindex[g]; var j = i - 1
    while ( i < netsize || j >= 0 ) {
      if ( i < netsize ) {
        val p = net[i]
        val dist = ( p[1] - g ).let { it * it }.let { it + ( ( p[0] - b ).let { d -> d * d } ) }
        if ( dist >= bestd ) { i = netsize } else {
          i++
          val dist2 = dist + ( p[2] - r ).let { it * it }
          if ( dist2 < bestd ) { bestd = dist2; best = p[3] }
        }
      }
      if ( j >= 0 ) {
        val p = net[j]
        val dist = ( g - p[1] ).let { it * it }.let { it + ( ( p[0] - b ).let { d -> d * d } ) }
        if ( dist >= bestd ) { j = -1 } else {
          j--
          val dist2 = dist + ( p[2] - r ).let { it * it }
          if ( dist2 < bestd ) { bestd = dist2; best = p[3] }
        }
      }
    }
    return best
  }

  private fun learn() {
    val lengthcount = pixels.size
    val alphadec = 30 + ( ( sfac - 1 ) / 3 )
    val samplepixels = lengthcount / ( 3 * sfac )
    var delta = samplepixels / ncycles
    if ( delta == 0 ) delta = 1
    var alpha = initalpha
    var rad = initradius
    var radSq = rad ushr radiusbiasshift
    if ( radSq <= 1 ) radSq = 0
    for ( i in 0 until radSq ) radpower[i] = alpha * ( ( ( radSq * radSq - i * i ) * radbias ) / ( radSq * radSq ) )

    var step = if ( lengthcount < minpicturebytes ) 3 else if ( ( lengthcount / 3 ) % prime4 != 0 ) 3 * prime4 else if ( ( lengthcount / 3 ) % prime3 != 0 ) 3 * prime3 else if ( ( lengthcount / 3 ) % prime2 != 0 ) 3 * prime2 else 3 * prime1
    var pix = 0; var i = 0
    while ( i < samplepixels ) {
      val b = ( pixels[pix].toInt() and 0xFF ) shl netbiasshift
      val g = ( pixels[pix + 1].toInt() and 0xFF ) shl netbiasshift
      val r = ( pixels[pix + 2].toInt() and 0xFF ) shl netbiasshift
      val j = contest( b, g, r )
      altersingle( alpha, j, b, g, r )
      if ( radSq != 0 ) alterneigh( radSq, j, b, g, r )
      pix += step
      if ( pix >= lengthcount ) pix -= lengthcount
      i++
      if ( i % delta == 0 ) { alpha -= alpha / alphadec; rad -= rad / radiusdec; radSq = rad ushr radiusbiasshift; if ( radSq <= 1 ) radSq = 0; for ( k in 0 until radSq ) radpower[k] = alpha * ( ( ( radSq * radSq - k * k ) * radbias ) / ( radSq * radSq ) ) }
    }
  }

  private fun altersingle( alpha: Int, i: Int, b: Int, g: Int, r: Int ) {
    net[i][0] -= ( alpha * ( net[i][0] - b ) ) / initalpha
    net[i][1] -= ( alpha * ( net[i][1] - g ) ) / initalpha
    net[i][2] -= ( alpha * ( net[i][2] - r ) ) / initalpha
  }

  private fun alterneigh( rad: Int, i: Int, b: Int, g: Int, r: Int ) {
    val lo = maxOf( i - rad, -1 ); val hi = minOf( i + rad, netsize )
    var j = i + 1; var k = i - 1; var m = 1
    while ( j < hi || k > lo ) {
      val a = radpower[m++]
      if ( j < hi ) { altersingle( a, j, b, g, r ); j++ }
      if ( k > lo ) { altersingle( a, k, b, g, r ); k-- }
    }
  }

  private fun contest( b: Int, g: Int, r: Int ): Int {
    var bestd = Int.MAX_VALUE; var bestbiasd = bestd; var bestpos = -1; var bestbiaspos = bestpos
    for ( i in 0 until netsize ) {
      val p = net[i]
      var dist = ( p[0] - b ).let { if ( it < 0 ) -it else it }
      dist += ( p[1] - g ).let { if ( it < 0 ) -it else it }
      dist += ( p[2] - r ).let { if ( it < 0 ) -it else it }
      if ( dist < bestd ) { bestd = dist; bestpos = i }
      val biasdist = dist - ( bias[i] ushr ( intbiasshift - netbiasshift ) )
      if ( biasdist < bestbiasd ) { bestbiasd = biasdist; bestbiaspos = i }
      val betafreq = freq[i] ushr betashift
      freq[i] -= betafreq; bias[i] += betafreq shl gammashift
    }
    freq[bestpos] += beta; bias[bestpos] -= betagamma
    return bestbiaspos
  }

  private fun unbiasnet() { for ( i in 0 until netsize ) { net[i][0] = net[i][0] ushr netbiasshift; net[i][1] = net[i][1] ushr netbiasshift; net[i][2] = net[i][2] ushr netbiasshift; net[i][3] = i } }

  private fun buildIndex() {
    var previouscol = 0; var startpos = 0
    for ( i in 0 until netsize ) {
      val p = net[i]; var smallpos = i; var smallval = p[1]
      for ( j in i + 1 until netsize ) { if ( net[j][1] < smallval ) { smallpos = j; smallval = net[j][1] } }
      val q = net[smallpos]
      if ( i != smallpos ) { val tmp = p.copyOf(); p[0] = q[0]; p[1] = q[1]; p[2] = q[2]; p[3] = q[3]; q[0] = tmp[0]; q[1] = tmp[1]; q[2] = tmp[2]; q[3] = tmp[3] }
      if ( smallval != previouscol ) { netindex[previouscol] = ( startpos + i ) ushr 1; for ( j in previouscol + 1 until smallval ) netindex[j] = i; previouscol = smallval; startpos = i }
    }
    netindex[previouscol] = ( startpos + maxnetpos ) ushr 1
    for ( j in previouscol + 1..255 ) netindex[j] = maxnetpos
  }

  companion object {
    private const val maxnetpos = 255
    private const val netbiasshift = 4
    private const val ncycles = 100
    private const val intbiasshift = 16
    private const val intbias = 1 shl intbiasshift
    private const val gammashift = 10
    private const val gamma = 1 shl gammashift
    private const val betashift = 10
    private const val beta = intbias ushr betashift
    private const val betagamma = intbias shl ( gammashift - betashift )
    private const val initrad = 32 // netsize / 8
    private const val radiusbiasshift = 6
    private const val radiusbias = 1 shl radiusbiasshift
    private const val initradius = initrad * radiusbias
    private const val radiusdec = 30
    private const val alphabiasshift = 10
    private const val initalpha = 1 shl alphabiasshift
    private const val radbiasshift = 8
    private const val radbias = 1 shl radbiasshift
    private const val alpharadbshift = alphabiasshift + radbiasshift
    private const val alpharadbias = 1 shl alpharadbshift
    private const val prime1 = 499; private const val prime2 = 491
    private const val prime3 = 487; private const val prime4 = 503
    private const val minpicturebytes = 3 * prime4
  }
}
