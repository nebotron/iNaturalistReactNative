import { CameraRoll } from "@react-native-camera-roll/camera-roll";
import FineSlider from "components/MediaViewer/FineSlider";
import {
  Body2,
  Body3,
  Button,
  Heading4,
  SwitchRow,
  Tabs,
} from "components/SharedComponents";
import { Pressable, ScrollView, View } from "components/styledComponents";
import React, { useEffect, useMemo, useState } from "react";
import { Alert, Share, useWindowDimensions } from "react-native";
import { holdKeepAwake, releaseKeepAwake } from "sharedHelpers/keepAwake";
import { log } from "sharedHelpers/logger";
import { enqueuePhotoLibraryWrite } from "sharedHelpers/promptDeleteOriginalDevicePhotos";
import type {
  Point,
  StabilizationSettings,
  StabilizeMethod,
  VideoAnalysis,
} from "sharedHelpers/videoStabilization";
import {
  flattenTransforms,
  isSubjectMethod,
  outputSize,
  planStabilization,
  strengthToSigmaSeconds,
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
  videoFrameAt,
} from "sharedHelpers/videoStabilizerNative";
import { useTranslation } from "sharedHooks";
import type { BusyPhase } from "stores/videoStabilizer";
import useVideoStabilizer from "stores/videoStabilizer";

import FramePreview from "./FramePreview";

const logger = log.extend( "VideoStabilizer" );

const KEEP_AWAKE_HOLDER = "videoStabilizer";
const FRAME_MAX_DIMENSION = 1080;
const PREVIEW_MAX_DIMENSION = 640;
const EXPORT_MAX_DIMENSION = 1920;
const MAX_ZOOM = 6;

const BACKGROUND_METHODS: StabilizeMethod[] = ["similarity", "translation"];
const SUBJECT_METHODS: StabilizeMethod[] = ["tracker", "saliency"];

const formatTime = ( seconds: number ) => {
  const minutes = Math.floor( seconds / 60 );
  return `${minutes}:${( seconds - minutes * 60 ).toFixed( 1 ).padStart( 4, "0" )}`;
};

const percent = ( progress: number ) => Math.round( progress * 100 );

interface Choices {
  strength: number;
  lockSize: boolean;
  zoom: number;
  avoidEdges: boolean;
  cropCenter: Point | null;
}

const settingsFor = (
  analysis: VideoAnalysis,
  maxDimension: number,
  choices: Choices,
): StabilizationSettings => {
  const size = outputSize( analysis.width, analysis.height, maxDimension );
  return {
    strength: choices.strength,
    lockSize: choices.lockSize,
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
    videoPath, info, frame, start, method, box, cropCenter, strength, lockSize,
    zoom, avoidEdges, includeAudio, analysis, busy, previewUri, exportUri,
    set, setMethod, setBox, setStart,
  } = useVideoStabilizer( );
  // Slider positions while dragging; the plan is only recomputed on release.
  const [startDraft, setStartDraft] = useState<number | null>( null );
  const [strengthDraft, setStrengthDraft] = useState<number | null>( null );
  const [zoomDraft, setZoomDraft] = useState<number | null>( null );
  const [drawing, setDrawing] = useState( false );
  const subjectMode = isSubjectMethod( method );

  useEffect( ( ) => onVideoStabilizerProgress( ( { progress } ) => {
    const current = useVideoStabilizer.getState( ).busy;
    if ( current && current.phase !== "importing" ) {
      set( { busy: { ...current, progress } } );
    }
  } ), [set] );

  // Opened with no session: anything on disk is left over from an earlier run.
  useEffect( ( ) => {
    const { videoPath: current, busy: working } = useVideoStabilizer.getState( );
    if ( !current && !working ) clearVideoStabilizerFiles( ).catch( ( ) => undefined );
  }, [] );

  const startOver = ( ) => {
    useVideoStabilizer.getState( ).reset( );
    clearVideoStabilizerFiles( ).catch( ( ) => undefined );
  };

  const startBusy = ( phase: BusyPhase ) => {
    holdKeepAwake( KEEP_AWAKE_HOLDER );
    set( { busy: { phase, progress: 0 } } );
  };

  const endBusy = ( ) => {
    releaseKeepAwake( KEEP_AWAKE_HOLDER );
    set( { busy: null } );
  };

  const showError = ( error: unknown, context: string ) => {
    if ( isCancellation( error ) ) return;
    logger.error( `${context} failed`, error );
    Alert.alert(
      t( "Video-stabilizer-failed" ),
      ( error as Error )?.message || t( "Something-went-wrong" ),
    );
  };

  const choices: Choices = {
    strength, lockSize, zoom, avoidEdges, cropCenter,
  };
  // Recomputed only when a setting is committed, never per drag event.
  const plan = useMemo( ( ) => (
    analysis
      ? planStabilization( analysis, settingsFor( analysis, EXPORT_MAX_DIMENSION, {
        strength, lockSize, zoom, avoidEdges, cropCenter,
      } ) )
      : null
  ), [analysis, strength, lockSize, zoom, avoidEdges, cropCenter] );

  const importVideo = async ( source: "library" | "files" ) => {
    startBusy( "importing" );
    try {
      const path = await pickVideo( source );
      if ( !path ) return;
      const probed = await probeVideo( path );
      const firstFrame = await videoFrameAt( path, 0, FRAME_MAX_DIMENSION );
      logger.info(
        `imported ${probed.width}x${probed.height} ${probed.fps}fps`
        + ` ${probed.duration.toFixed( 1 )}s`,
      );
      useVideoStabilizer.getState( ).reset( );
      set( {
        videoPath: path, info: probed, frame: firstFrame, method,
      } );
    } catch ( error ) {
      showError( error, "import" );
    } finally {
      endBusy( );
    }
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

  const runAnalysis = async ( ) => {
    if ( !videoPath ) return;
    if ( method === "tracker" && !box ) {
      Alert.alert( t( "Draw-a-box-around-the-subject-first" ) );
      return;
    }
    startBusy( "analyzing" );
    try {
      const result = await analyzeVideo( videoPath, {
        method,
        start,
        box: box ?? undefined,
      } );
      const lost = result.frames.filter( f => !f.ok ).length;
      logger.info(
        `analyzed ${result.frames.length} frames with ${method}, ${lost} unusable`
        + `${result.registrationReading
          ? `, registration read ${result.registrationReading} (${result.registrationVotes} votes)`
          : ""}`,
      );
      set( { analysis: result, previewUri: null, exportUri: null } );
    } catch ( error ) {
      showError( error, "analysis" );
    } finally {
      endBusy( );
    }
  };

  const runRender = async ( preview: boolean ) => {
    if ( !videoPath || !analysis ) return;
    const maxDimension = preview
      ? PREVIEW_MAX_DIMENSION
      : EXPORT_MAX_DIMENSION;
    const settings = settingsFor( analysis, maxDimension, choices );
    const rendered = planStabilization( analysis, settings );
    startBusy( preview
      ? "previewing"
      : "exporting" );
    try {
      const result = await renderStabilizedVideo( videoPath, {
        start,
        transforms: flattenTransforms( rendered.transforms ),
        outputWidth: settings.outputWidth,
        outputHeight: settings.outputHeight,
        includeAudio,
        preview,
      } );
      if ( preview ) {
        set( { previewUri: result.uri } );
        playVideo( result.uri );
      } else {
        logger.info(
          `exported ${result.frames} frames at ${settings.outputWidth}x${settings.outputHeight}, `
          + `zoom ${rendered.zoom.toFixed( 2 )}`,
        );
        set( { exportUri: result.uri } );
      }
    } catch ( error ) {
      showError( error, preview
        ? "preview"
        : "export" );
    } finally {
      endBusy( );
    }
  };

  const saveToPhotos = async ( ) => {
    if ( !exportUri ) return;
    try {
      // No album: adding to one needs full library access, and saving alone
      // needs only add-only access.
      await enqueuePhotoLibraryWrite( holdChainUntil => {
        const save = CameraRoll.saveAsset( exportUri, { type: "video" } );
        holdChainUntil( save );
        return save;
      } );
      Alert.alert( t( "Saved-to-Photos" ) );
    } catch ( error ) {
      showError( error, "save" );
    }
  };

  const shareExport = ( ) => {
    if ( exportUri ) Share.share( { url: exportUri } ).catch( ( ) => undefined );
  };

  // A settings change keeps the analysis but makes the rendered files stale.
  const updateSettings = ( partial: Parameters<typeof set>[0] ) => set( {
    ...partial, previewUri: null, exportUri: null,
  } );

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
      {busy.phase !== "importing" && (
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
          onPress={( ) => importVideo( "library" )}
        />
        <Button
          className="mt-3"
          text={t( "IMPORT-FROM-FILES" )}
          disabled={!!busy}
          onPress={( ) => importVideo( "files" )}
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

  const shownZoom = zoomDraft ?? zoom;
  const roughCenter: Point = subjectMode
    ? ( box && { x: box[0] + box[2] / 2, y: box[1] + box[3] / 2 } ) || { x: 0.5, y: 0.5 }
    : cropCenter ?? { x: 0.5, y: 0.5 };
  const half = 0.5 / shownZoom;
  const cropOutline: Point[] = plan && analysis && zoomDraft === null
    ? plan.firstFrameCrop.map( p => ( { x: p.x / analysis.width, y: p.y / analysis.height } ) )
    : [
      { x: roughCenter.x - half, y: roughCenter.y - half },
      { x: roughCenter.x + half, y: roughCenter.y - half },
      { x: roughCenter.x + half, y: roughCenter.y + half },
      { x: roughCenter.x - half, y: roughCenter.y + half },
    ];

  const sigma = strengthToSigmaSeconds( strengthDraft ?? strength );
  const strengthLabel = Number.isFinite( sigma )
    ? t( "Stabilization-smooths-over-x-seconds", { seconds: sigma.toFixed( 1 ) } )
    : t( "Stabilization-locked" );

  const methodLabels: Record<StabilizeMethod, { label: string; hint: string }> = {
    similarity: {
      label: t( "Shift-rotation-and-zoom--stabilize-method" ),
      hint: t( "Also-removes-tilt-and-zoom-wobble" ),
    },
    translation: {
      label: t( "Shift-only--stabilize-method" ),
      hint: t( "Fastest-removes-up-down-and-sideways-shake" ),
    },
    tracker: {
      label: t( "Track-the-box-I-draw--stabilize-method" ),
      hint: t( "Follows-what-you-draw-a-box-around" ),
    },
    saliency: {
      label: t( "Find-the-subject-automatically--stabilize-method" ),
      hint: t( "Follows-the-most-prominent-object" ),
    },
  };
  const methods = subjectMode
    ? SUBJECT_METHODS
    : BACKGROUND_METHODS;
  const disabled = !!busy;
  const source = analysis && {
    width: Math.round( analysis.width / ( plan?.zoom ?? zoom ) ),
    height: Math.round( analysis.height / ( plan?.zoom ?? zoom ) ),
  };
  const exportSize = outputSize( info.width, info.height, EXPORT_MAX_DIMENSION );

  return (
    <ScrollView
      scrollEnabled={!drawing}
      contentContainerClassName="p-4 pb-[96px]"
    >
      <FramePreview
        uri={frame.uri}
        width={previewWidth}
        height={previewHeight}
        interaction={subjectMode
          ? "box"
          : "point"}
        box={subjectMode
          ? box
          : null}
        crop={cropOutline}
        cropCenter={cropCenter ?? { x: 0.5, y: 0.5 }}
        onBoxDrawn={setBox}
        onPointPicked={point => updateSettings( { cropCenter: point } )}
        onDrawingChange={setDrawing}
      />
      <Body3 className="mt-2 text-center">
        {subjectMode
          ? t( "Drag-on-the-frame-to-draw-a-box-around-the-subject" )
          : t( "Tap-the-frame-to-choose-where-to-crop" )}
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

      <Heading4 className="mt-6 mb-2">{t( "STABILIZE-ON" )}</Heading4>
      <Tabs
        activeId={subjectMode
          ? "subject"
          : "background"}
        tabs={[
          {
            id: "background",
            text: t( "BACKGROUND--stabilize-on" ),
            onPress: ( ) => !disabled && setMethod( BACKGROUND_METHODS[0] ),
          },
          {
            id: "subject",
            text: t( "SUBJECT--stabilize-on" ),
            onPress: ( ) => !disabled && setMethod( SUBJECT_METHODS[0] ),
          },
        ]}
      />
      <View className="mt-3" accessibilityRole="radiogroup">
        {methods.map( option => (
          <Pressable
            key={option}
            accessibilityRole="radio"
            accessibilityState={{ checked: method === option, disabled }}
            disabled={disabled}
            onPress={( ) => setMethod( option )}
            className={`p-3 mb-2 rounded-lg border-2 ${method === option
              ? "border-inatGreen"
              : "border-lightGray"}`}
          >
            <Body2>{methodLabels[option].label}</Body2>
            <Body3 className="mt-1">{methodLabels[option].hint}</Body3>
          </Pressable>
        ) )}
      </View>

      <Button
        className="mt-3"
        level={analysis
          ? undefined
          : "primary"}
        text={analysis
          ? t( "ANALYZE-MOTION-AGAIN" )
          : t( "ANALYZE-MOTION" )}
        disabled={disabled}
        onPress={runAnalysis}
      />
      {analysis && !busy && (
        <Body3 className="mt-2">
          {t( "Motion-analyzed-across-x-frames", { count: analysis.frames.length } )}
        </Body3>
      )}
      {busyBar}

      <Heading4 className="mt-6 mb-2">{t( "SMOOTHING" )}</Heading4>
      <View className="flex-row items-center">
        <Body2 className="w-[110px]">{strengthLabel}</Body2>
        <FineSlider
          accessibilityLabel={t( "Stabilization-strength" )}
          disabled={disabled}
          minimumValue={0}
          maximumValue={1}
          value={strengthDraft ?? strength}
          onChange={setStrengthDraft}
          onComplete={value => {
            setStrengthDraft( null );
            updateSettings( { strength: value } );
          }}
        />
      </View>
      {subjectMode && (
        <SwitchRow
          classNames="mt-3"
          label={t( "Keep-the-subject-the-same-size" )}
          value={lockSize}
          disabled={disabled}
          onValueChange={value => updateSettings( { lockSize: value } )}
        />
      )}

      <Heading4 className="mt-6 mb-2">{t( "CROP" )}</Heading4>
      <View className="flex-row items-center">
        <Body2 className="w-[110px]">
          {t( "Crop-zoom-x", { zoom: shownZoom.toFixed( 1 ) } )}
        </Body2>
        <FineSlider
          accessibilityLabel={t( "Crop-zoom" )}
          disabled={disabled}
          minimumValue={1}
          maximumValue={MAX_ZOOM}
          value={shownZoom}
          snapValue={1}
          snapThreshold={0.1}
          onChange={setZoomDraft}
          onComplete={value => {
            setZoomDraft( null );
            updateSettings( { zoom: value } );
          }}
        />
      </View>
      <SwitchRow
        classNames="mt-3"
        label={t( "Zoom-in-to-hide-empty-edges" )}
        value={avoidEdges}
        disabled={disabled}
        onValueChange={value => updateSettings( { avoidEdges: value } )}
      />
      {info.hasAudio && (
        <SwitchRow
          classNames="mt-3"
          label={t( "Keep-audio" )}
          value={includeAudio}
          disabled={disabled}
          onValueChange={value => updateSettings( { includeAudio: value } )}
        />
      )}
      {plan && avoidEdges && plan.zoom > zoom + 0.01 && (
        <Body3 className="mt-2">
          {t( "Zoomed-to-x-to-hide-empty-edges", { zoom: plan.zoom.toFixed( 2 ) } )}
        </Body3>
      )}
      {plan?.edgesVisible && (
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

      <View className="flex-row mt-6">
        <Button
          className="flex-1 mr-2"
          text={t( "PREVIEW" )}
          disabled={disabled || !analysis}
          onPress={( ) => ( previewUri
            ? playVideo( previewUri )
            : runRender( true ) )}
        />
        <Button
          className="flex-1 ml-2"
          level="primary"
          text={t( "EXPORT" )}
          disabled={disabled || !analysis}
          onPress={( ) => runRender( false )}
        />
      </View>
      {exportUri && !busy && (
        <View className="mt-4">
          <Button text={t( "PLAY" )} onPress={( ) => playVideo( exportUri )} />
          <Button className="mt-3" text={t( "SAVE-TO-PHOTOS" )} onPress={saveToPhotos} />
          <Button className="mt-3" text={t( "SHARE" )} onPress={shareExport} />
        </View>
      )}

      <Button
        className="mt-8"
        text={t( "CHOOSE-ANOTHER-VIDEO" )}
        disabled={disabled}
        onPress={startOver}
      />
    </ScrollView>
  );
};

export default VideoStabilizer;
