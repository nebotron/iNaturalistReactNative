import FineSlider from "components/MediaViewer/FineSlider";
import {
  Body2,
  Body3,
  Button,
  Heading4,
  SwitchRow,
} from "components/SharedComponents";
import { ScrollView, View } from "components/styledComponents";
import React, { useEffect, useMemo, useState } from "react";
import { Alert, Share, useWindowDimensions } from "react-native";
import { holdKeepAwake, releaseKeepAwake } from "sharedHelpers/keepAwake";
import { log } from "sharedHelpers/logger";
import { enqueuePhotoLibraryWrite } from "sharedHelpers/promptDeleteOriginalDevicePhotos";
import type {
  Point,
  ReadoutEstimate,
  StabilizationSettings,
  VideoAnalysis,
} from "sharedHelpers/videoStabilization";
import {
  estimateReadout,
  flattenTransforms,
  outputSize,
  planStabilization,
} from "sharedHelpers/videoStabilization";
import {
  analyzeVideo,
  cancelVideoStabilizer,
  clearVideoStabilizerFiles,
  isCancellation,
  isVideoStabilizerSupported,
  onVideoStabilizerProgress,
  pickVideo,
  playVideo,
  probeVideo,
  renderStabilizedVideo,
  saveStabilizedVideo,
  videoFrameAt,
  VideoStabilizerComparison,
} from "sharedHelpers/videoStabilizerNative";
import { useTranslation } from "sharedHooks";
import type { BusyPhase } from "stores/videoStabilizer";
import useVideoStabilizer from "stores/videoStabilizer";

import FramePreview from "./FramePreview";
import type { ZoomWindow } from "./PinchCrop";
import PinchCrop from "./PinchCrop";

const logger = log.extend( "VideoStabilizer" );

const KEEP_AWAKE_HOLDER = "videoStabilizer";
const FRAME_MAX_DIMENSION = 1080;
const PREVIEW_MAX_DIMENSION = 640;
const EXPORT_MAX_DIMENSION = 1920;
const MAX_ZOOM = 6;

// The job the screen last started. Kept outside the component so that a
// remount (a tab switch) neither repeats a job that's still running nor
// lets a superseded job's result overwrite a newer one.
let activeJob: { id: number; key: string } | null = null;
let jobCount = 0;

const formatTime = ( seconds: number ) => {
  const minutes = Math.floor( seconds / 60 );
  return `${minutes}:${( seconds - minutes * 60 ).toFixed( 1 ).padStart( 4, "0" )}`;
};

const percent = ( progress: number ) => Math.round( progress * 100 );

interface Choices {
  rollingShutter: boolean;
  zoom: number;
  avoidEdges: boolean;
  cropCenter: Point | null;
}

const settingsFor = (
  analysis: VideoAnalysis,
  maxDimension: number,
  choices: Choices,
  readout: ReadoutEstimate | null,
): StabilizationSettings => {
  const size = outputSize( analysis.width, analysis.height, maxDimension );
  return {
    rollingShutter: choices.rollingShutter
      ? readout?.readout ?? 0
      : 0,
    zoom: choices.zoom,
    avoidEdges: choices.avoidEdges,
    maxZoom: MAX_ZOOM,
    cropCenter: choices.cropCenter
      ? { x: choices.cropCenter.x * analysis.width, y: choices.cropCenter.y * analysis.height }
      : undefined,
    outputWidth: size.width,
    outputHeight: size.height,
  };
};

const VideoStabilizer = ( ) => {
  const { t } = useTranslation( );
  const { width: windowWidth, height: windowHeight } = useWindowDimensions( );
  const {
    videoPath, info, frame, start, cropCenter, rollingShutter,
    zoom, avoidEdges, analysis, analysisKey, busy, previewUri, previewKey, previewStart,
    previewCrop, exportUri, exportKey, set, setStart,
  } = useVideoStabilizer( );
  // Slider positions while dragging; settings are only committed on release.
  const [startDraft, setStartDraft] = useState<number | null>( null );
  // Set while a zoom rectangle is being dragged, so the page doesn't scroll.
  const [pinchingCrop, setPinchingCrop] = useState( false );

  useEffect( ( ) => onVideoStabilizerProgress( ( { progress, job } ) => {
    const current = useVideoStabilizer.getState( ).busy;
    if ( current && current.job !== undefined && current.job === job ) {
      set( { busy: { ...current, progress } } );
    }
  } ), [set] );

  // Opened with no session: anything on disk is left over from an earlier run.
  useEffect( ( ) => {
    const { videoPath: current, busy: working } = useVideoStabilizer.getState( );
    if ( !current && !working ) clearVideoStabilizerFiles( ).catch( ( ) => undefined );
  }, [] );

  const showError = ( error: unknown, context: string ) => {
    if ( isCancellation( error ) ) return;
    logger.error( `${context} failed`, error );
    Alert.alert(
      t( "Video-stabilizer-failed" ),
      ( error as Error )?.message || t( "Something-went-wrong" ),
    );
  };

  // What each result has to have been made with to be current. A result made
  // with anything else is stale, and the effect below reruns it.
  // Rolling-shutter correction needs the strips measured; an analysis that
  // has them serves just as well with the correction off.
  const analysisKeyFor = ( strips: boolean ) => (
    videoPath
      ? JSON.stringify( [videoPath, start, strips] )
      : null
  );
  const wantedAnalysisKey = analysisKeyFor( rollingShutter );
  const currentAnalysis = analysis && (
    analysisKey === wantedAnalysisKey
    || ( !rollingShutter && analysisKey === analysisKeyFor( true ) )
  )
    ? analysis
    : null;
  const readout = useMemo(
    ( ) => ( currentAnalysis
      ? estimateReadout( currentAnalysis )
      : null ),
    [currentAnalysis],
  );
  const choices: Choices = {
    rollingShutter, zoom, avoidEdges, cropCenter,
  };
  const wantedPreviewKey = currentAnalysis
    ? JSON.stringify( [wantedAnalysisKey, choices] )
    : null;
  const currentExport = exportUri && exportKey === wantedPreviewKey
    ? exportUri
    : null;
  const exporting = busy?.phase === "exporting";

  // Recomputed only when a setting is committed, never per drag event.
  const plan = useMemo( ( ) => (
    currentAnalysis
      ? planStabilization( currentAnalysis, settingsFor( currentAnalysis, EXPORT_MAX_DIMENSION, {
        rollingShutter, zoom, avoidEdges, cropCenter,
      }, readout ) )
      : null
  ), [currentAnalysis, rollingShutter, zoom, avoidEdges, cropCenter, readout] );

  // Runs one native job. Starting a job cancels the one before (natively,
  // too), and only the latest job's result, error and progress count.
  const runJob = async <T, >(
    key: string,
    phase: BusyPhase,
    work: ( job: number ) => Promise<T>,
    onDone: ( result: T ) => void,
  ) => {
    jobCount += 1;
    const id = jobCount;
    activeJob = { id, key };
    holdKeepAwake( KEEP_AWAKE_HOLDER );
    set( { busy: { phase, progress: 0, job: id } } );
    try {
      const result = await work( id );
      if ( activeJob?.id === id ) onDone( result );
    } catch ( error ) {
      if ( activeJob?.id === id ) showError( error, phase );
    } finally {
      if ( activeJob?.id === id ) {
        releaseKeepAwake( KEEP_AWAKE_HOLDER );
        set( { busy: null } );
      }
    }
  };

  const runAnalysis = ( key: string ) => {
    const {
      videoPath: path, start: from, rollingShutter: strips,
    } = useVideoStabilizer.getState( );
    if ( !path ) return;
    runJob(
      key,
      "analyzing",
      job => analyzeVideo( path, {
        start: from,
        strips,
        job,
      } ),
      result => {
        const lost = result.frames.filter( f => !f.ok ).length;
        const measured = strips
          ? estimateReadout( result )
          : null;
        let readoutNote = "";
        if ( strips ) {
          readoutNote = measured
            ? `, readout ${measured.readout.toFixed( 3 )}±${measured.error.toFixed( 3 )}`
              + ` of a frame from ${measured.frames} frames`
            : ", readout not measurable";
        }
        logger.info(
          `analyzed ${result.frames.length} frames, ${lost} unusable, `
          + `${result.refinedFrames} locked to the first frame${readoutNote}`,
        );
        set( { analysis: result, analysisKey: key } );
      },
    );
  };

  const render = ( key: string, preview: boolean ) => {
    const state = useVideoStabilizer.getState( );
    if ( !state.videoPath || !currentAnalysis ) return;
    const path = state.videoPath;
    const settings = settingsFor(
      currentAnalysis,
      preview
        ? PREVIEW_MAX_DIMENSION
        : EXPORT_MAX_DIMENSION,
      choices,
      readout,
    );
    const rendered = planStabilization( currentAnalysis, settings );
    runJob(
      preview
        ? key
        : `export:${key}`,
      preview
        ? "previewing"
        : "exporting",
      job => renderStabilizedVideo( path, {
        start: state.start,
        transforms: flattenTransforms( rendered.transforms ),
        outputWidth: settings.outputWidth,
        outputHeight: settings.outputHeight,
        preview,
        job,
      } ),
      result => {
        if ( preview ) {
          set( {
            previewUri: result.uri,
            previewKey: key,
            previewStart: state.start,
            previewCrop: {
              corners: rendered.firstFrameCrop.map( p => ( {
                x: p.x / currentAnalysis.width,
                y: p.y / currentAnalysis.height,
              } ) ),
              zoom: rendered.zoom,
            },
          } );
          return;
        }
        logger.info(
          `exported ${result.frames} frames at ${settings.outputWidth}x${settings.outputHeight}, `
          + `zoom ${rendered.zoom.toFixed( 2 )}`,
        );
        set( { exportUri: result.uri, exportKey: key } );
      },
    );
  };

  // Analyze as soon as there's a video and whenever a setting the analysis
  // depends on changes; once it's current, keep the preview up to date.
  useEffect( ( ) => {
    if ( !videoPath || exporting || busy?.phase === "importing" ) return;
    if ( wantedAnalysisKey && !currentAnalysis ) {
      if ( activeJob?.key !== wantedAnalysisKey ) runAnalysis( wantedAnalysisKey );
      return;
    }
    if (
      wantedPreviewKey
      && previewKey !== wantedPreviewKey
      && activeJob?.key !== wantedPreviewKey
    ) {
      render( wantedPreviewKey, true );
    }
  // runAnalysis and render read the latest settings when they're called.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    videoPath, exporting, busy?.phase, wantedAnalysisKey, currentAnalysis,
    wantedPreviewKey, previewKey,
  ] );

  // Also serves "choose another video": work on the current one stops, and it
  // stays loaded if the picker is dismissed. Importing replaces its files.
  const importVideo = async ( ) => {
    activeJob = null;
    cancelVideoStabilizer( );
    holdKeepAwake( KEEP_AWAKE_HOLDER );
    set( { busy: { phase: "importing", progress: 0 } } );
    try {
      const path = await pickVideo( );
      if ( !path ) return;
      const probed = await probeVideo( path );
      const firstFrame = await videoFrameAt( path, 0, FRAME_MAX_DIMENSION );
      logger.info(
        `imported ${probed.width}x${probed.height} ${probed.fps}fps`
        + ` ${probed.duration.toFixed( 1 )}s`,
      );
      // The stabilizing choices carry over to the next video.
      const kept = useVideoStabilizer.getState( );
      useVideoStabilizer.getState( ).reset( );
      set( {
        videoPath: path,
        info: probed,
        frame: firstFrame,
        rollingShutter: kept.rollingShutter,
        busy: { phase: "importing", progress: 0 },
      } );
    } catch ( error ) {
      showError( error, "import" );
    } finally {
      releaseKeepAwake( KEEP_AWAKE_HOLDER );
      set( { busy: null } );
    }
  };

  // A rectangle dragged over the stabilized preview becomes the new crop: its
  // center, mapped back onto the start frame through the window the preview
  // shows, and the zoom that makes it fill the output.
  const zoomToWindow = ( window: ZoomWindow ) => {
    if ( !previewCrop || previewCrop.corners.length !== 4 ) return;
    const [topLeft, topRight, , bottomLeft] = previewCrop.corners;
    const { x: u, y: v } = window.center;
    set( {
      cropCenter: {
        x: topLeft.x + u * ( topRight.x - topLeft.x ) + v * ( bottomLeft.x - topLeft.x ),
        y: topLeft.y + u * ( topRight.y - topLeft.y ) + v * ( bottomLeft.y - topLeft.y ),
      },
      zoom: Math.min( MAX_ZOOM, Math.max( 1, previewCrop.zoom / window.size ) ),
    } );
  };

  const commitStart = async ( seconds: number ) => {
    setStartDraft( null );
    if ( !videoPath ) return;
    setStart( seconds );
    try {
      set( { frame: await videoFrameAt( videoPath, seconds, FRAME_MAX_DIMENSION ) } );
    } catch ( error ) {
      showError( error, "frame" );
    }
  };

  const saveToPhotos = async ( ) => {
    if ( !currentExport || !videoPath ) return;
    try {
      await enqueuePhotoLibraryWrite( holdChainUntil => {
        const save = saveStabilizedVideo( currentExport, videoPath, start );
        holdChainUntil( save );
        return save;
      } );
      Alert.alert( t( "Saved-to-Photos" ) );
    } catch ( error ) {
      showError( error, "save" );
    }
  };

  const shareExport = ( ) => {
    if ( currentExport ) Share.share( { url: currentExport } ).catch( ( ) => undefined );
  };

  if ( !isVideoStabilizerSupported( ) ) {
    return (
      <View className="p-5">
        <Body2>{t( "Video-stabilizer-is-only-available-on-iOS" )}</Body2>
      </View>
    );
  }

  const busyLabel = ( ) => {
    if ( !busy ) return "";
    switch ( busy.phase ) {
      case "importing": return t( "Importing-video" );
      case "analyzing":
        return t( "Analyzing-motion-x-percent", { percent: percent( busy.progress ) } );
      case "previewing":
        return t( "Updating-preview-x-percent", { percent: percent( busy.progress ) } );
      default:
        return t( "Rendering-video-x-percent", { percent: percent( busy.progress ) } );
    }
  };

  const busyBar = busy && (
    <View className="mt-4">
      <Body2>{busyLabel( )}</Body2>
      <View className="h-2 mt-2 rounded-full bg-lightGray overflow-hidden">
        <View
          className="h-2 bg-inatGreen"
          style={{ width: `${percent( busy.progress )}%` }}
        />
      </View>
      {exporting && (
        <Button
          className="mt-3"
          text={t( "CANCEL" )}
          onPress={cancelVideoStabilizer}
        />
      )}
    </View>
  );

  if ( !videoPath || !info || !frame ) {
    return (
      <View className="p-5">
        <Body2>{t( "Video-stabilizer-intro" )}</Body2>
        <Button
          className="mt-5"
          level="primary"
          text={t( "IMPORT-FROM-PHOTOS" )}
          disabled={!!busy}
          onPress={importVideo}
        />
        {busyBar}
      </View>
    );
  }

  const maxPreviewWidth = windowWidth - 32;
  const maxPreviewHeight = windowHeight * 0.45;
  const aspect = frame.width / frame.height;
  const previewWidth = Math.min( maxPreviewWidth, maxPreviewHeight * aspect );
  const previewHeight = previewWidth / aspect;

  const roughCenter: Point = cropCenter ?? { x: 0.5, y: 0.5 };
  const half = 0.5 / zoom;
  const cropOutline: Point[] = plan && currentAnalysis
    ? plan.firstFrameCrop.map( p => ( {
      x: p.x / currentAnalysis.width,
      y: p.y / currentAnalysis.height,
    } ) )
    : [
      { x: roughCenter.x - half, y: roughCenter.y - half },
      { x: roughCenter.x + half, y: roughCenter.y - half },
      { x: roughCenter.x + half, y: roughCenter.y + half },
      { x: roughCenter.x - half, y: roughCenter.y + half },
    ];

  let readoutLabel: string | null = null;
  if ( rollingShutter && currentAnalysis ) {
    readoutLabel = readout
      ? t( "Sensor-readout-x-ms-x-percent-of-a-frame", {
        ms: ( ( readout.readout * 1000 ) / currentAnalysis.fps ).toFixed( 1 ),
        percent: percent( readout.readout ),
      } )
      : t( "Readout-could-not-be-measured" );
  }

  const disabled = exporting;
  const source = currentAnalysis && {
    width: Math.round( currentAnalysis.width / ( plan?.zoom ?? zoom ) ),
    height: Math.round( currentAnalysis.height / ( plan?.zoom ?? zoom ) ),
  };
  const exportSize = outputSize( info.width, info.height, EXPORT_MAX_DIMENSION );
  const previewIsCurrent = !!previewUri && previewKey === wantedPreviewKey;

  // The original above the stabilized preview, each the full screen width,
  // below the settings.
  const videoHeight = windowWidth / aspect;
  const videoLabel = ( text: string, top: number ) => (
    <View
      className="absolute left-2 px-2 py-0.5 rounded bg-black/50"
      style={{ top: top + 8 }}
      pointerEvents="none"
    >
      <Body3 className="text-white">{text}</Body3>
    </View>
  );
  const comparison = (
    <View
      // Out to the screen edges, past the settings' padding.
      className="mt-6 -mx-4 pt-2 bg-white"
    >
      <Heading4 className="px-4 mb-2">{t( "PREVIEW--video-stabilizer" )}</Heading4>
      {previewUri && VideoStabilizerComparison
        ? (
          <View className={previewIsCurrent
            ? ""
            : "opacity-50"}
          >
            <VideoStabilizerComparison
              accessibilityLabel={t( "Original-and-stabilized-videos" )}
              original={videoPath}
              stabilized={previewUri}
              start={previewStart}
              style={{ width: windowWidth, height: videoHeight * 2 }}
            />
            {videoLabel( t( "Original--video-stabilizer" ), 0 )}
            {videoLabel( t( "Stabilized--video-stabilizer" ), videoHeight )}
            <View
              className="absolute left-0"
              style={{ top: videoHeight, width: windowWidth, height: videoHeight }}
            >
              <PinchCrop
                width={windowWidth}
                height={videoHeight}
                disabled={disabled || !previewIsCurrent || !previewCrop}
                // The crop's zoom stays between 1× and MAX_ZOOM.
                minSize={( previewCrop?.zoom ?? 1 ) / MAX_ZOOM}
                maxSize={previewCrop?.zoom ?? 1}
                onPinchingChange={setPinchingCrop}
                onWindowPicked={zoomToWindow}
              />
            </View>
          </View>
        )
        : (
          <View
            className="items-center justify-center bg-lightGray p-4"
            style={{ width: windowWidth, height: videoHeight * 2 }}
          >
            <Body3 className="text-center">
              {t( "The-preview-appears-here-once-the-motion-is-analyzed" )}
            </Body3>
          </View>
        )}
    </View>
  );

  return (
    <View className="flex-1">
      <ScrollView
        className="flex-1"
        contentContainerClassName="p-4 pb-6"
        scrollEnabled={!pinchingCrop}
      >
        <FramePreview
          uri={frame.uri}
          width={previewWidth}
          height={previewHeight}
          crop={cropOutline}
          cropCenter={cropCenter ?? { x: 0.5, y: 0.5 }}
          onPointPicked={point => set( { cropCenter: point } )}
        />
        <Body3 className="mt-2 text-center">
          {t( "Tap-the-frame-to-choose-where-to-crop" )}
        </Body3>

        <View className="flex-row items-center mt-4">
          <Body2 className="w-[110px]">
            {t( "Starts-at-x", { time: formatTime( startDraft ?? start ) } )}
          </Body2>
          <FineSlider
            accessibilityLabel={t( "Start-time" )}
            disabled={disabled}
            minimumValue={0}
            maximumValue={Math.max( 0.1, info.duration - 0.5 )}
            value={startDraft ?? start}
            onChange={setStartDraft}
            onComplete={commitStart}
          />
        </View>

        <Heading4 className="mt-6 mb-2">{t( "ROLLING-SHUTTER" )}</Heading4>
        <SwitchRow
          label={t( "Correct-rolling-shutter" )}
          value={rollingShutter}
          disabled={disabled}
          onValueChange={value => set( { rollingShutter: value } )}
        />
        {readoutLabel && <Body2 className="mt-2">{readoutLabel}</Body2>}
        <Body3 className="mt-2">
          {t( "Straightens-lines-that-lean-in-fast-moves-measured-from-the-video" )}
        </Body3>

        <Heading4 className="mt-6 mb-2">{t( "CROP" )}</Heading4>
        <View className="flex-row items-center">
          <Body2 className="flex-1">
            {t( "Crop-zoom-x", { zoom: zoom.toFixed( 1 ) } )}
          </Body2>
          <Button
            text={t( "RESET-ZOOM" )}
            disabled={disabled || ( zoom === 1 && !cropCenter )}
            onPress={( ) => set( { zoom: 1, cropCenter: null } )}
          />
        </View>
        <Body3 className="mt-2">
          {t( "Pinch-the-stabilized-preview-to-zoom-drag-with-two-fingers-to-move" )}
        </Body3>
        <SwitchRow
          classNames="mt-3"
          label={t( "Zoom-in-to-hide-empty-edges" )}
          value={avoidEdges}
          disabled={disabled}
          onValueChange={value => set( { avoidEdges: value } )}
        />
        {plan && avoidEdges && plan.zoom > zoom + 0.01 && (
          <Body3 className="mt-2">
            {t( "Zoomed-to-x-to-hide-empty-edges", { zoom: plan.zoom.toFixed( 2 ) } )}
          </Body3>
        )}
        {plan?.edgesVisible && avoidEdges && (
          <Body3 className="mt-2">{t( "Some-frames-still-show-empty-edges" )}</Body3>
        )}
        {source && (
          <Body3 className="mt-2">
            {t( "Output-x-by-y-from-source-x-by-y", {
              width: exportSize.width,
              height: exportSize.height,
              sourceWidth: source.width,
              sourceHeight: source.height,
            } )}
          </Body3>
        )}

        {!exporting && busyBar}
        {currentAnalysis && !busy && (
          <Body3 className="mt-2">
            {t( "Motion-analyzed-across-x-frames", { count: currentAnalysis.frames.length } )}
          </Body3>
        )}
        <Button
          className="mt-6"
          level="primary"
          text={t( "EXPORT" )}
          disabled={disabled || !currentAnalysis}
          onPress={( ) => wantedPreviewKey && render( wantedPreviewKey, false )}
        />
        {exporting && busyBar}
        {currentExport && !busy && (
          <View className="mt-4">
            <Button text={t( "PLAY" )} onPress={( ) => playVideo( currentExport )} />
            <Button className="mt-3" text={t( "SAVE-TO-PHOTOS" )} onPress={saveToPhotos} />
            <Button className="mt-3" text={t( "SHARE" )} onPress={shareExport} />
          </View>
        )}

        <Button
          className="mt-8"
          text={t( "CHOOSE-ANOTHER-VIDEO" )}
          disabled={disabled}
          onPress={importVideo}
        />
        {comparison}
      </ScrollView>
    </View>
  );
};

export default VideoStabilizer;
