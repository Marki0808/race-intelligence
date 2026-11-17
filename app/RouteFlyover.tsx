"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { GeoJSONSource, Map as MapLibreMap } from "maplibre-gl";
import type { GpxRoutePointData } from "./gpxAnalysis";
import {
  advanceFlyoverDistance,
  buildFlyoverPath,
  createFlyoverMarkerFeature,
  createFlyoverPlaybackState,
  FLYOVER_MARKER_FEATURE_ID,
  formatFlyoverReadout,
  getFlyoverCameraPlan,
  reduceFlyoverPlayback,
  sampleFlyoverPath,
  type FlyoverPlaybackAction,
  type FlyoverPlaybackState,
  type FlyoverPath,
  type FlyoverSample,
  type FlyoverSpeedMultiplier,
} from "./routeFlyoverModel";
import type { RouteUnitSystem } from "./routeUnits";
import type { TerrainReadiness } from "./mapLibreTerrainStatus";
import { isFlyoverManualMapInput, runWhenMapStyleReady } from "./routeFlyoverMapInteractions";
import { waitForFlyoverPreparation, type FlyoverPreparationMap } from "./routeFlyoverPreparation";
import {
  FLYOVER_READOUT_MARKER_SIZE_CSS,
  FlyoverPerformanceSampler,
} from "./routeFlyoverPerformance";

type CameraSnapshot = { center: [number, number]; zoom: number; pitch: number; bearing: number };
const FLYOVER_ICON_ID = "endurset-flyover-readout";
const FLYOVER_SOURCE_ID = "endurset-flyover-position";
const FLYOVER_LAYER_ID = "endurset-flyover-marker";

function createFlyoverReadoutImage(distance: string, elevation: string) {
  const canvas = document.createElement("canvas");
  canvas.width = FLYOVER_READOUT_MARKER_SIZE_CSS * 2;
  canvas.height = FLYOVER_READOUT_MARKER_SIZE_CSS * 2;
  const context = canvas.getContext("2d");
  if (!context) throw new Error("Could not create flyover readout marker.");
  const center = canvas.width / 2;
  context.fillStyle = "#17211c";
  context.strokeStyle = "#a7c957";
  context.lineWidth = 2;
  context.beginPath();
  context.arc(center, center, center - 3, 0, Math.PI * 2);
  context.fill();
  context.stroke();
  context.fillStyle = "#f6f4e9";
  context.textAlign = "center";
  context.textBaseline = "middle";
  const maxTextWidth = canvas.width - 20;
  const drawValue = (text: string, y: number, size: number, weight: number) => {
    context.font = `${weight} ${size}px ui-monospace, SFMono-Regular, Menlo, monospace`;
    const measuredWidth = context.measureText(text).width;
    if (measuredWidth > maxTextWidth) {
      const fittedSize = Math.max(13, size * maxTextWidth / measuredWidth);
      context.font = `${weight} ${fittedSize}px ui-monospace, SFMono-Regular, Menlo, monospace`;
    }
    context.fillText(text, center, y, maxTextWidth);
  };
  drawValue(distance, 43, 21, 600);
  drawValue(elevation === "Unavailable" ? "N/A" : elevation, 69, 18, 500);
  return context.getImageData(0, 0, canvas.width, canvas.height);
}

export default function RouteFlyover({
  map,
  points,
  units,
  terrainStatus,
  fullscreenLayout = false,
}: {
  map: MapLibreMap;
  points: readonly GpxRoutePointData[];
  units: RouteUnitSystem;
  terrainStatus: TerrainReadiness;
  fullscreenLayout?: boolean;
}) {
  const pathResult = useMemo(() => buildFlyoverPath(points), [points]);
  const path = pathResult.available ? pathResult.path : null;
  const [playback, setPlayback] = useState<FlyoverPlaybackState>(() => path ? createFlyoverPlaybackState(path) : { phase: "idle", distanceM: 0, speedMultiplier: 1 });
  const playbackRef = useRef(playback);
  const markerSourceRef = useRef<GeoJSONSource | null>(null);
  const markerFeaturePresentRef = useRef(false);
  const animationFrameRef = useRef(0);
  const [displayedSample, setDisplayedSample] = useState<FlyoverSample | null>(null);
  const [preparingPath, setPreparingPath] = useState<FlyoverPath | null>(null);
  const preparing = preparingPath === path;
  const preparingRef = useRef(false);
  const preparationCancelRef = useRef<(() => void) | null>(null);
  const terrainStatusRef = useRef(terrainStatus);
  const performanceSamplerRef = useRef<FlyoverPerformanceSampler | null>(null);
  const savedCameraRef = useRef<CameraSnapshot | null>(null);
  const reducedMotionRef = useRef(false);
  const [reducedMotion, setReducedMotion] = useState(false);
  const cameraBearingRef = useRef<number | null>(null);
  const cameraZoomRef = useRef<number | null>(null);
  const pathRef = useRef(path);
  const unitsRef = useRef(units);
  const readoutTextRef = useRef<string | null>(null);
  const diagnosticsEnabled = process.env.NODE_ENV === "development" && process.env.NEXT_PUBLIC_FLYOVER_DIAGNOSTICS === "true";
  const controlsClassName = fullscreenLayout
    ? `${flyoverPanelClass} map-fullscreen-controls mb-[max(.5rem,env(safe-area-inset-bottom))]`
    : flyoverPanelClass;
  useEffect(() => {
    terrainStatusRef.current = terrainStatus;
  }, [terrainStatus]);
  useEffect(() => {
    pathRef.current = path;
  }, [path]);
  useEffect(() => {
    unitsRef.current = units;
  }, [units]);

  const markerShouldBeVisible = playback.phase !== "idle";
  const flyoverSamplingActive = playback.phase === "playing" || playback.phase === "paused";

  useEffect(() => {
    if (!flyoverSamplingActive || !diagnosticsEnabled) {
      performanceSamplerRef.current = null;
      return;
    }
    const sampler = new FlyoverPerformanceSampler();
    performanceSamplerRef.current = sampler;
    const onMapRender = () => sampler.recordMapRender(performance.now());
    let longTaskObserver: PerformanceObserver | null = null;
    if (typeof PerformanceObserver !== "undefined" && PerformanceObserver.supportedEntryTypes?.includes("longtask")) {
      try {
        longTaskObserver = new PerformanceObserver((list) => {
          for (const entry of list.getEntries()) sampler.recordMainThreadLongTask(entry.startTime, entry.duration);
        });
        longTaskObserver.observe({ type: "longtask", buffered: false });
      } catch { longTaskObserver = null; }
    }
    const refreshSnapshot = () => {
      let demTilesLoading: boolean | null = null;
      let mapTilesLoading: boolean | null = null;
      try {
        demTilesLoading = map.getSource("mapterhorn-dem") ? !map.isSourceLoaded("mapterhorn-dem") : null;
        mapTilesLoading = !map.areTilesLoaded();
      } catch { /* A map being disposed has no reliable tile status. */ }
      console.debug("[Endurset Flyover performance]", { ...sampler.snapshot(performance.now()), demTilesLoading, mapTilesLoading });
    };
    map.on("render", onMapRender);
    const timer = window.setInterval(refreshSnapshot, 1_000);
    refreshSnapshot();
    return () => {
      window.clearInterval(timer);
      map.off("render", onMapRender);
      longTaskObserver?.disconnect();
      if (performanceSamplerRef.current === sampler) performanceSamplerRef.current = null;
    };
  }, [diagnosticsEnabled, flyoverSamplingActive, map]);

  const publishSample = useCallback((sample: FlyoverSample) => {
    performanceSamplerRef.current?.recordReadoutUpdate(performance.now());
    setDisplayedSample(sample);
  }, []);

  const updateReadout = useCallback((sample: FlyoverSample) => {
    if (!map.hasImage(FLYOVER_ICON_ID)) return;
    try {
      const values = formatFlyoverReadout(sample, units);
      const readoutText = `${values.distance}|${values.elevation}`;
      if (readoutTextRef.current !== readoutText) {
        map.updateImage(FLYOVER_ICON_ID, createFlyoverReadoutImage(values.distance, values.elevation));
        readoutTextRef.current = readoutText;
      }
    } catch { /* Keep playback controls usable if the optional readout cannot update. */ }
  }, [map, units]);

  useEffect(() => {
    if (displayedSample && playback.phase !== "idle") updateReadout(displayedSample);
  }, [displayedSample, playback.phase, updateReadout]);

  const setMarkerVisibility = useCallback((visible: boolean) => {
    try {
      if (map.getLayer(FLYOVER_LAYER_ID)) map.setLayoutProperty(FLYOVER_LAYER_ID, "visibility", visible ? "visible" : "none");
    } catch { /* A disposed map cannot show the optional marker. */ }
  }, [map]);

  const updateMarker = useCallback((sample: FlyoverSample) => {
    const source = markerSourceRef.current;
    const currentPath = pathRef.current;
    if (!source || !currentPath) return;
    const feature = createFlyoverMarkerFeature(sample).features[0];
    performanceSamplerRef.current?.recordMarkerUpdate(performance.now());
    const diff = markerFeaturePresentRef.current
      ? { update: [{ id: FLYOVER_MARKER_FEATURE_ID, newGeometry: feature.geometry, removeAllProperties: true, addOrUpdateProperties: [{ key: "segmentIndex", value: feature.properties.segmentIndex }] }] }
      : { add: [feature] };
    markerFeaturePresentRef.current = true;
    void source.updateData(diff).catch(() => {
      try { void source.setData(createFlyoverMarkerFeature(sample)).catch(() => {}); }
      catch { /* A disposed map cannot retain the optional marker. */ }
    });
  }, []);

  const clearMarker = useCallback(() => {
    try {
      const source = markerSourceRef.current;
      if (source && markerFeaturePresentRef.current) void source.updateData({ remove: [FLYOVER_MARKER_FEATURE_ID] }).catch(() => {});
      markerFeaturePresentRef.current = false;
    }
    catch { /* A disposed map cannot retain the optional marker. */ }
    setMarkerVisibility(false);
  }, [setMarkerVisibility]);

  useEffect(() => {
    let disposed = false;
    let installing = false;
    const installWhenStyleReady = () => {
      if (disposed || installing) return false;
      installing = true;
      try {
        if (!map.hasImage(FLYOVER_ICON_ID)) map.addImage(FLYOVER_ICON_ID, createFlyoverReadoutImage("—", "—"), { pixelRatio: 2 });
        if (!map.getSource(FLYOVER_SOURCE_ID)) map.addSource(FLYOVER_SOURCE_ID, { type: "geojson", data: { type: "FeatureCollection", features: [] } });
        markerSourceRef.current = map.getSource(FLYOVER_SOURCE_ID) as GeoJSONSource;
        markerFeaturePresentRef.current = false;
        readoutTextRef.current = null;
        if (!map.getLayer(FLYOVER_LAYER_ID)) map.addLayer({
          id: FLYOVER_LAYER_ID,
          type: "symbol",
          source: FLYOVER_SOURCE_ID,
          layout: {
            "symbol-placement": "point",
            "icon-image": FLYOVER_ICON_ID,
            "icon-size": 1,
            "icon-anchor": "bottom",
            "icon-allow-overlap": true,
            "icon-ignore-placement": true,
            "icon-rotation-alignment": "viewport",
            "icon-pitch-alignment": "viewport",
            "symbol-height-offset": 2,
            "symbol-height-anchor": "ground",
            visibility: "none",
          },
        });
        const activePath = pathRef.current;
        if (activePath && playbackRef.current.phase !== "idle") {
          const sample = sampleFlyoverPath(activePath, playbackRef.current.distanceM);
          updateMarker(sample);
          const values = formatFlyoverReadout(sample, unitsRef.current);
          map.updateImage(FLYOVER_ICON_ID, createFlyoverReadoutImage(values.distance, values.elevation));
          readoutTextRef.current = `${values.distance}|${values.elevation}`;
          map.setLayoutProperty(FLYOVER_LAYER_ID, "visibility", "visible");
        }
        return true;
      } catch {
        markerSourceRef.current = null;
      markerFeaturePresentRef.current = false;
        return false;
      } finally {
        installing = false;
      }
    };
    const removeStyleReadyListeners = runWhenMapStyleReady(map, installWhenStyleReady);
    return () => {
      disposed = true;
      markerSourceRef.current = null;
      readoutTextRef.current = null;
      removeStyleReadyListeners();
      try {
        if (map.getLayer(FLYOVER_LAYER_ID)) map.removeLayer(FLYOVER_LAYER_ID);
        if (map.getSource(FLYOVER_SOURCE_ID)) map.removeSource(FLYOVER_SOURCE_ID);
        if (map.hasImage(FLYOVER_ICON_ID)) map.removeImage(FLYOVER_ICON_ID);
      } catch { /* The parent may already be disposing the WebGL map. */ }
    };
  }, [map, updateMarker]);

  useEffect(() => () => {
    cancelAnimationFrame(animationFrameRef.current);
    clearMarker();
  }, [clearMarker]);

  useEffect(() => {
    if (reducedMotion) map.stop();
  }, [map, reducedMotion]);

  const moveCameraTo = useCallback((sample: FlyoverSample, speedMultiplier: number, elapsedMs: number) => {
    if (!path || reducedMotionRef.current) return;
    const plan = getFlyoverCameraPlan(path, sample, speedMultiplier, cameraBearingRef.current, elapsedMs, map.getCanvas().clientHeight, cameraZoomRef.current);
    cameraBearingRef.current = plan.bearing;
    cameraZoomRef.current = plan.zoom;
    performanceSamplerRef.current?.recordCameraUpdate(performance.now());
    map.jumpTo({ center: plan.center, zoom: plan.zoom, bearing: plan.bearing, pitch: plan.pitch });
  }, [map, path]);

  const dispatch = useCallback((action: FlyoverPlaybackAction, shouldFollow = false) => {
    if (!path) return;
    const current = playbackRef.current;
    const next = reduceFlyoverPlayback(path, current, action);
    playbackRef.current = next;
    setPlayback(next);
    if (action.type === "exit") {
      clearMarker();
    }
    else {
      const sample = sampleFlyoverPath(path, next.distanceM);
      updateMarker(sample);
      publishSample(sample);
      if (shouldFollow) moveCameraTo(sample, next.speedMultiplier, 380);
    }
  }, [clearMarker, moveCameraTo, path, publishSample, updateMarker]);

  useEffect(() => {
    if (!preparing || !path) return;
    const cancel = waitForFlyoverPreparation(
      map as unknown as FlyoverPreparationMap,
      () => terrainStatusRef.current,
      () => {
        preparationCancelRef.current = null;
        preparingRef.current = false;
        setPreparingPath(null);
        dispatch({ type: "start" });
      },
    );
    preparationCancelRef.current = cancel;
    return () => {
      cancel();
      if (preparationCancelRef.current === cancel) preparationCancelRef.current = null;
    };
  }, [dispatch, map, path, preparing]);

  useEffect(() => {
    const query = window.matchMedia("(prefers-reduced-motion: reduce)");
    const update = () => {
      reducedMotionRef.current = query.matches;
      setReducedMotion(query.matches);
    };
    update();
    query.addEventListener("change", update);
    return () => query.removeEventListener("change", update);
  }, []);

  useEffect(() => {
    savedCameraRef.current = null;
    cameraBearingRef.current = null;
    clearMarker();
    preparationCancelRef.current?.();
    preparationCancelRef.current = null;
    preparingRef.current = false;
    if (!path) {
      playbackRef.current = { phase: "idle", distanceM: 0, speedMultiplier: 1 };
      setPlayback(playbackRef.current);
      setDisplayedSample(null);
      return;
    }
    const initial = createFlyoverPlaybackState(path);
    playbackRef.current = initial;
    setPlayback(initial);
    setDisplayedSample(null);
  }, [clearMarker, path]);

  useEffect(() => {
    setMarkerVisibility(Boolean(path && markerShouldBeVisible));
    if (path && markerShouldBeVisible) updateMarker(sampleFlyoverPath(path, playbackRef.current.distanceM));
  }, [markerShouldBeVisible, path, setMarkerVisibility, updateMarker]);

  useEffect(() => {
    if (playback.phase !== "playing" || !path) return;
    let previousTimestamp: number | null = null;
    let lastUiUpdate = 0;
    const frame = (timestamp: number) => {
      const state = playbackRef.current;
      if (state.phase !== "playing") return;
      performanceSamplerRef.current?.recordFrame(timestamp);
      const elapsed = previousTimestamp === null ? 0 : timestamp - previousTimestamp;
      previousTimestamp = timestamp;
      const advancedDistance = advanceFlyoverDistance(path, state.distanceM, elapsed, state.speedMultiplier);
      const next = reduceFlyoverPlayback(path, state, { type: "advance", distanceM: advancedDistance });
      playbackRef.current = next;
      const sample = sampleFlyoverPath(path, next.distanceM);
      updateMarker(sample);
      if (timestamp - lastUiUpdate >= 100 || next.phase === "complete") {
        lastUiUpdate = timestamp;
        publishSample(sample);
      }
      if (!reducedMotionRef.current) moveCameraTo(sample, next.speedMultiplier, elapsed);
      if (next.phase === "complete") {
        setPlayback(next);
        return;
      }
      animationFrameRef.current = requestAnimationFrame(frame);
    };
    animationFrameRef.current = requestAnimationFrame(frame);
    return () => cancelAnimationFrame(animationFrameRef.current);
  }, [moveCameraTo, path, playback.phase, publishSample, updateMarker]);

  useEffect(() => {
    if (playback.phase !== "playing") return;
    const container = map.getContainer();
    const pauseForManualMapControl = () => dispatch({ type: "pause" });
    const pauseForNativeMapInput = (event: Event) => {
      if (isFlyoverManualMapInput(event as unknown as Parameters<typeof isFlyoverManualMapInput>[0], {
        scrollZoomEnabled: map.scrollZoom.isEnabled(),
        doubleClickZoomEnabled: map.doubleClickZoom.isEnabled(),
        keyboardEnabled: map.keyboard.isEnabled(),
      })) pauseForManualMapControl();
    };
    const nativeEventTypes = ["wheel", "dblclick", "touchstart", "pointerdown", "click", "keydown"] as const;
    for (const eventType of nativeEventTypes) container.addEventListener(eventType, pauseForNativeMapInput, true);
    map.on("dragstart", pauseForManualMapControl);
    return () => {
      for (const eventType of nativeEventTypes) container.removeEventListener(eventType, pauseForNativeMapInput, true);
      map.off("dragstart", pauseForManualMapControl);
    };
  }, [dispatch, map, playback.phase]);

  useEffect(() => {
    const pauseOnHidden = () => {
      if (document.visibilityState === "hidden" && playbackRef.current.phase === "playing") dispatch({ type: "pause" });
    };
    document.addEventListener("visibilitychange", pauseOnHidden);
    return () => document.removeEventListener("visibilitychange", pauseOnHidden);
  }, [dispatch]);

  const start = useCallback((restart = false) => {
    if (!path || preparingRef.current) return;
    if (playbackRef.current.phase === "idle" && !restart) {
      if (!savedCameraRef.current) savedCameraRef.current = {
        center: [map.getCenter().lng, map.getCenter().lat], zoom: map.getZoom(), pitch: map.getPitch(), bearing: map.getBearing(),
      };
      cameraBearingRef.current = null;
      cameraZoomRef.current = null;
      preparingRef.current = true;
      setPreparingPath(path);
      const initialSample = sampleFlyoverPath(path, path.startDistanceM);
      setMarkerVisibility(true);
      updateMarker(initialSample);
      updateReadout(initialSample);
      publishSample(initialSample);
      moveCameraTo(initialSample, playbackRef.current.speedMultiplier, 380);
      return;
    }
    if (playbackRef.current.phase === "idle" || playbackRef.current.phase === "complete") {
      if (!savedCameraRef.current) savedCameraRef.current = {
        center: [map.getCenter().lng, map.getCenter().lat], zoom: map.getZoom(), pitch: map.getPitch(), bearing: map.getBearing(),
      };
      cameraBearingRef.current = null;
      cameraZoomRef.current = null;
      dispatch({ type: "restart" }, true);
      return;
    }
    cameraBearingRef.current = map.getBearing();
    cameraZoomRef.current = map.getZoom();
    dispatch({ type: "resume" }, true);
  }, [dispatch, map, moveCameraTo, path, publishSample, setMarkerVisibility, updateMarker, updateReadout]);

  const cancelPreparation = useCallback(() => {
    preparationCancelRef.current?.();
    preparationCancelRef.current = null;
    preparingRef.current = false;
    setPreparingPath(null);
    clearMarker();
    const saved = savedCameraRef.current;
    if (saved) {
      if (reducedMotionRef.current) map.jumpTo(saved);
      else map.easeTo({ ...saved, duration: 350 });
    }
    savedCameraRef.current = null;
    cameraBearingRef.current = null;
    cameraZoomRef.current = null;
  }, [clearMarker, map]);

  const pause = useCallback(() => {
    dispatch({ type: "pause" });
  }, [dispatch]);

  const restart = useCallback(() => {
    if (!path) return;
    if (!savedCameraRef.current) savedCameraRef.current = {
      center: [map.getCenter().lng, map.getCenter().lat], zoom: map.getZoom(), pitch: map.getPitch(), bearing: map.getBearing(),
    };
    cameraBearingRef.current = null;
    cameraZoomRef.current = null;
    dispatch({ type: "restart" }, true);
  }, [dispatch, map, path]);

  const exit = useCallback(() => {
    dispatch({ type: "exit" });
    const saved = savedCameraRef.current;
    if (saved) {
      if (reducedMotionRef.current) map.jumpTo(saved);
      else map.easeTo({ ...saved, duration: 350 });
    }
    savedCameraRef.current = null;
    cameraBearingRef.current = null;
    cameraZoomRef.current = null;
  }, [dispatch, map]);

  const seek = useCallback((fraction: number) => {
    if (!path) return;
    const distanceM = path.startDistanceM + (path.endDistanceM - path.startDistanceM) * fraction;
    dispatch({ type: "seek", distanceM }, true);
  }, [dispatch, path]);

  const changeSpeed = useCallback((speedMultiplier: FlyoverSpeedMultiplier) => {
    dispatch({ type: "set-speed", speedMultiplier });
    if (!path || playbackRef.current.phase !== "paused") return;
    // A paused Flyover has no RAF loop to finish smoothing, so ease to the new framing once.
    cameraBearingRef.current = map.getBearing();
    cameraZoomRef.current = map.getZoom();
    const sample = sampleFlyoverPath(path, playbackRef.current.distanceM);
    const plan = getFlyoverCameraPlan(path, sample, speedMultiplier, cameraBearingRef.current, 10_000, map.getCanvas().clientHeight, cameraZoomRef.current);
    cameraBearingRef.current = plan.bearing;
    cameraZoomRef.current = plan.zoom;
    if (reducedMotionRef.current) map.jumpTo({ center: plan.center, zoom: plan.zoom, bearing: plan.bearing, pitch: plan.pitch });
    else map.easeTo({ center: plan.center, zoom: plan.zoom, bearing: plan.bearing, pitch: plan.pitch, duration: 500 });
  }, [dispatch, map, path]);

  if (!path) {
    const reason = pathResult.available ? "invalid-geometry" : pathResult.reason;
    const message = reason === "disconnected-components"
      ? "Flyover is unavailable for a route with disconnected track components."
      : reason === "invalid-geometry"
        ? "Flyover is unavailable because this route geometry is incomplete."
        : "Flyover is unavailable because this route is too short to animate.";
    return <p className="mt-2 rounded-lg border border-black/10 bg-white px-3 py-2 text-xs text-[#46514d]" role="status">{message}</p>;
  }

  if (preparing) return <div className={`${controlsClassName} flex items-center justify-between gap-3`} role="status" aria-live="polite">
    <span>Preparing flyover…</span>
    <button type="button" onClick={cancelPreparation} className={controlClass}>Cancel</button>
  </div>;

  const rangeM = path.endDistanceM - path.startDistanceM;
  const currentDistanceM = displayedSample?.distanceM ?? playback.distanceM;
  const progress = rangeM > 0 ? ((currentDistanceM - path.startDistanceM) / rangeM) * 1000 : 0;
  const accessibleValues = displayedSample ? formatFlyoverReadout(displayedSample, units) : null;
  return playback.phase === "idle" ? <div className={controlsClassName} role="group" aria-label="Route flyover controls">
      <button
      type="button"
      onClick={() => start()}
      className="min-h-11 rounded-full border border-white/25 bg-[#a7c957] px-4 text-xs font-semibold text-[#17211c] shadow-sm hover:bg-[#b8d76c] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white"
      aria-label="Start 3D route flyover"
    >Start Flyover</button>
  </div> : <>
    <div className={controlsClassName} role="group" aria-label="Route flyover controls">
      <div className="flex min-w-0 items-center gap-3">
        <input
          type="range"
          min={0}
          max={1000}
          value={Math.round(progress)}
          onChange={(event) => seek(Number(event.currentTarget.value) / 1000)}
          aria-label="Flyover route progress"
          className="h-2 min-w-24 flex-1 cursor-pointer accent-[#a7c957]"
        />
        <span className="shrink-0 rounded-full border border-white/15 bg-white/5 px-2 py-1 text-[9px] font-medium text-white/70">{playback.phase === "complete" ? "Complete" : `${playback.speedMultiplier}×`}</span>
      </div>
      <div className="mt-2 grid grid-cols-2 items-center gap-2 sm:flex sm:flex-wrap sm:justify-between">
        {playback.phase === "playing" ? <button type="button" onClick={pause} className={controlClass}>Pause</button> : playback.phase === "complete" ? <button type="button" onClick={() => start(true)} className={controlClass}>Play again</button> : <button type="button" onClick={() => start()} className={controlClass}>Resume</button>}
        {playback.phase !== "complete" && <button type="button" onClick={restart} className={controlClass}>Restart</button>}
        <fieldset aria-label="Flyover visualization speed, not running speed" className="col-span-2 grid min-w-0 grid-cols-3 items-center justify-items-center gap-1 rounded-xl border border-white/20 px-1.5 py-1 sm:col-auto sm:flex sm:justify-center">
          <legend className="sr-only">Flyover visualization speed, not running speed</legend>
          <span className="w-full text-center text-[10px] font-medium text-white/70 sm:hidden">Visualization speed</span>
          {([1, 2, 4, 8, 16, 32] as const).map((speed) => <button
            key={speed}
            type="button"
            aria-pressed={playback.speedMultiplier === speed}
            onClick={() => changeSpeed(speed)}
            className={`min-h-11 min-w-11 rounded-full px-2 text-xs font-semibold focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-[#a7c957] ${playback.speedMultiplier === speed ? "bg-[#a7c957] text-[#17211c]" : "text-white hover:bg-white/15"}`}
          >{speed}×</button>)}
        </fieldset>
        <button type="button" onClick={exit} className={`${controlClass} col-span-2 justify-self-center sm:col-auto sm:justify-self-auto`}>Return to map</button>
      </div>
      {reducedMotion && <p className="mt-1 text-center text-[9px] text-white/65">Camera motion is reduced.</p>}
      <span className="sr-only" role="status" aria-live="polite">{playback.phase === "complete" ? "Flyover complete." : playback.phase === "paused" ? "Flyover paused." : playback.phase === "playing" ? "Flyover playing." : ""}</span>
      <span className="sr-only" aria-live="polite">{accessibleValues ? `Distance from route start ${accessibleValues.distance}. GPX elevation ${accessibleValues.elevation}.` : "Distance and GPX elevation unavailable."}</span>
    </div>
  </>;
}

const flyoverPanelClass = "mt-2 w-full min-w-0 rounded-xl border border-[#17211c]/20 bg-[#17211c] p-2.5 text-white shadow-sm sm:p-3";
const controlClass = "min-h-11 rounded-full border border-white/25 bg-white/10 px-3 text-xs font-semibold text-white hover:bg-white/20 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#a7c957]";

