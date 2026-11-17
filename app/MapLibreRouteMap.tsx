"use client";

import "maplibre-gl/dist/maplibre-gl.css";
import { setWorkerUrl } from "maplibre-gl";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { GeoJSONSource, Map as MapLibreMap } from "maplibre-gl";
import type { GpxRoutePointData } from "./gpxAnalysis";
import type { KeyMomentMapMarker } from "./routeKeyMomentMapMarkers";
import { layoutKeyMomentMarkerOffsets } from "./routeKeyMomentMarkerLayout";
import { useRouteUnits } from "./RouteUnitPreference";
import RouteFlyover from "./RouteFlyover";
import MapFullscreenRegion, { MAP_CONTROL_BUTTON_CLASS } from "./MapFullscreenRegion";
import { buildRouteMapFeatures, buildSelectedSectionEndpointFeatures, getRouteMapBounds, getRouteMapLineStyles } from "./routeMapPresentation";
import { attachMapLibreWheelZoom } from "./mapLibreWheelZoom";
import { expireTerrainLoadingHint, resolveTerrainReadiness, TERRAIN_LOADING_HINT_DELAY_MS, type TerrainReadiness } from "./mapLibreTerrainStatus";

const BASEMAP_STYLE = "https://tiles.openfreemap.org/styles/liberty";
const MAPTERHORN_TILEJSON = "https://tiles.mapterhorn.com/tilejson.json";
const MAPLIBRE_WORKER_URL = new URL("maplibre-gl/dist/maplibre-gl-worker.mjs", import.meta.url).toString();
setWorkerUrl(MAPLIBRE_WORKER_URL);

type Availability = "loading" | "ready" | "degraded" | "unavailable";

function toTerrainPoints(points: readonly GpxRoutePointData[]) {
  return points.map(({ latitude, longitude, segmentIndex, distanceM }) => ({ latitude, longitude, segmentIndex: segmentIndex ?? 0, distanceM }));
}

function routeBounds(points: readonly GpxRoutePointData[]) {
  return getRouteMapBounds(toTerrainPoints(points));
}

function endpointFeatureCollection(points: readonly GpxRoutePointData[]) {
  const components = new Map<number, Array<{ latitude: number; longitude: number }>>();
  for (const point of toTerrainPoints(points)) {
    const component = components.get(point.segmentIndex) ?? [];
    component.push(point);
    components.set(point.segmentIndex, component);
  }
  const drawable = [...components.values()].filter((component) => component.length > 1);
  return {
    type: "FeatureCollection" as const,
    features: [drawable[0]?.[0], drawable.at(-1)?.at(-1)].filter((point): point is { latitude: number; longitude: number } => Boolean(point)).map((point, index) => ({
      type: "Feature" as const,
      properties: { label: index === 0 ? "Start" : "Finish" },
      geometry: { type: "Point" as const, coordinates: [point.longitude, point.latitude] },
    })),
  };
}

export default function MapLibreRouteMap({
  points,
  selectedPoints = [],
  showSelectedSectionMarkers = false,
  focusPoints = [],
  focusKey = null,
  focusOnKeyChange = true,
  keyMomentMarkers = [],
  selectedKeyMomentId = null,
  onSelectKeyMoment,
  enableFlyover = true,
  allow2dFallback = true,
  onFallbackTo2d,
  label,
  mapBadgeText,
  frameClassName = "relative h-56 sm:h-[17.5rem]",
}: {
  points: readonly GpxRoutePointData[];
  selectedPoints?: readonly GpxRoutePointData[];
  showSelectedSectionMarkers?: boolean;
  focusPoints?: readonly GpxRoutePointData[];
  focusKey?: string | null;
  focusOnKeyChange?: boolean;
  keyMomentMarkers?: readonly KeyMomentMapMarker[];
  selectedKeyMomentId?: string | null;
  onSelectKeyMoment?: (momentId: string) => void;
  enableFlyover?: boolean;
  allow2dFallback?: boolean;
  onFallbackTo2d: () => void;
  label: string;
  mapBadgeText?: string;
  frameClassName?: string;
}) {
  const { units } = useRouteUnits();
  const containerRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<MapLibreMap | null>(null);
  const styleReadyRef = useRef(false);
  const terrainFailedRef = useRef(false);
  const terrainStatusRef = useRef<TerrainReadiness>("loading");
  const terrainHintTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const previousFocusKeyRef = useRef<string | null>(null);
  const wheelZoomRef = useRef<ReturnType<typeof attachMapLibreWheelZoom> | null>(null);
  const keyMomentLayoutFrameRef = useRef(0);
  const scheduleKeyMomentLayoutRef = useRef<(() => void) | null>(null);
  const [styleReady, setStyleReady] = useState(false);
  const [mapInstance, setMapInstance] = useState<MapLibreMap | null>(null);
  const [basemapStatus, setBasemapStatus] = useState<Availability>("loading");
  const [terrainStatus, setTerrainStatus] = useState<TerrainReadiness>("loading");
  const [routeStatus, setRouteStatus] = useState<Availability>("loading");
  const [wheelZoomActive, setWheelZoomActive] = useState(false);
  const [initializationError, setInitializationError] = useState("");
  const routeFeatures = useMemo(() => buildRouteMapFeatures(toTerrainPoints(points), toTerrainPoints(selectedPoints)), [points, selectedPoints]);
  const routeFeature = routeFeatures.route;
  const selectedFeature = routeFeatures.selected;
  const selectedEndpointFeature = useMemo(
    () => showSelectedSectionMarkers ? buildSelectedSectionEndpointFeatures(toTerrainPoints(selectedPoints)) : { type: "FeatureCollection" as const, features: [] },
    [selectedPoints, showSelectedSectionMarkers],
  );
  const bounds = useMemo(() => routeBounds(points), [points]);
  const selectedBounds = useMemo(() => routeBounds(focusPoints), [focusPoints]);
  const latestDataRef = useRef({ points, routeFeature, selectedFeature, selectedEndpointFeature, bounds, keyMomentMarkers, selectedKeyMomentId });
  const selectKeyMomentRef = useRef(onSelectKeyMoment);
  const previousPointsRef = useRef(points);

  useEffect(() => {
    latestDataRef.current = { points, routeFeature, selectedFeature, selectedEndpointFeature, bounds, keyMomentMarkers, selectedKeyMomentId };
    selectKeyMomentRef.current = onSelectKeyMoment;
  }, [points, routeFeature, selectedFeature, selectedEndpointFeature, bounds, keyMomentMarkers, selectedKeyMomentId, onSelectKeyMoment]);

  const fitRoute = useCallback((angled: boolean) => {
    const map = mapRef.current;
    if (!map || !bounds) return;
    const pitch = angled ? 53 : 0;
    const bearing = angled ? -22 : 0;
    const camera = map.cameraForBounds(bounds, { padding: 58, maxZoom: 12.5, pitch, bearing });
    if (camera) map.easeTo({ ...camera, pitch, bearing, duration: 450 });
  }, [bounds]);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    let cancelled = false;
    let map: MapLibreMap | null = null;
    let resizeObserver: ResizeObserver | null = null;
    let resizeFrame = 0;
    const updateTerrainStatus = (status: TerrainReadiness) => {
      terrainStatusRef.current = status;
      setTerrainStatus(status);
      if (status !== "loading" && terrainHintTimeoutRef.current) {
        clearTimeout(terrainHintTimeoutRef.current);
        terrainHintTimeoutRef.current = null;
      }
    };

    async function initialize() {
      try {
        const maplibre = await import("maplibre-gl");
        if (cancelled || !containerRef.current) return;
        map = new maplibre.Map({
          container: containerRef.current,
          style: BASEMAP_STYLE,
          center: latestDataRef.current.bounds ? [(latestDataRef.current.bounds[0][0] + latestDataRef.current.bounds[1][0]) / 2, (latestDataRef.current.bounds[0][1] + latestDataRef.current.bounds[1][1]) / 2] : [14, 45],
          zoom: 9,
          pitch: 53,
          bearing: -22,
          maxPitch: 65,
          scrollZoom: false,
          dragRotate: true,
          touchZoomRotate: true,
          touchPitch: true,
          pitchWithRotate: true,
          attributionControl: { compact: true },
        });
        mapRef.current = map;
        const scheduleKeyMomentLayout = () => {
          if (keyMomentLayoutFrameRef.current) return;
          keyMomentLayoutFrameRef.current = requestAnimationFrame(() => {
            keyMomentLayoutFrameRef.current = 0;
            if (!map || map.isMoving() && !map.isStyleLoaded()) return;
            const current = latestDataRef.current;
            if (!current.keyMomentMarkers.length || !map.getSource("key-moments")) return;
            const projected = current.keyMomentMarkers.map((marker) => {
              const position = map!.project([marker.longitude, marker.latitude]);
              return { id: marker.id, x: position.x, y: position.y };
            });
            const canvas = map!.getCanvas();
            const offsets = layoutKeyMomentMarkerOffsets(projected, canvas.clientWidth, canvas.clientHeight);
            const displayCoordinates = new Map<string, [number, number]>();
            for (const marker of current.keyMomentMarkers) {
              const position = map!.project([marker.longitude, marker.latitude]);
              const offset = offsets.get(marker.id) ?? { x: 0, y: 0 };
              const display = map!.unproject([position.x + offset.x, position.y + offset.y]);
              displayCoordinates.set(marker.id, [display.lng, display.lat]);
            }
            const markerSource = map!.getSource("key-moments") as GeoJSONSource | undefined;
            markerSource?.setData(keyMomentFeatureCollection(current.keyMomentMarkers, current.selectedKeyMomentId, displayCoordinates));
            const leaderSource = map!.getSource("key-moment-leaders") as GeoJSONSource | undefined;
            leaderSource?.setData(keyMomentLeaderFeatureCollection(current.keyMomentMarkers, displayCoordinates));
          });
        };
        scheduleKeyMomentLayoutRef.current = scheduleKeyMomentLayout;
        map.on("move", scheduleKeyMomentLayout);
        map.on("resize", scheduleKeyMomentLayout);
        setMapInstance(map);
        wheelZoomRef.current = attachMapLibreWheelZoom(map, map.getContainer(), setWheelZoomActive);
        resizeObserver = new ResizeObserver((entries) => {
          const size = entries[0]?.contentRect;
          if (!cancelled && size && size.width > 0 && size.height > 0) map?.resize();
        });
        resizeObserver.observe(map.getContainer());
        resizeFrame = requestAnimationFrame(() => { if (!cancelled) map?.resize(); });
        map.addControl(new maplibre.NavigationControl({ visualizePitch: true, showZoom: true, showCompass: true }), "top-right");

        map.on("error", (event) => {
          const record = event as { error?: { message?: string; url?: string; status?: number }; sourceId?: string };
          const host = (() => { try { return new URL(record.error?.url ?? "").hostname; } catch { return ""; } })();
          if (record.sourceId === "mapterhorn-dem" || host === "tiles.mapterhorn.com") {
            if (terrainFailedRef.current) return;
            terrainFailedRef.current = true;
            try {
              map?.setTerrain(null);
              if (map?.getLayer("mapterhorn-hillshade")) map.removeLayer("mapterhorn-hillshade");
            } catch { /* retain basemap and GPX line */ }
            updateTerrainStatus("unavailable");
            return;
          }
          const message = record.error?.message ?? "Map resources could not be loaded.";
          if (/webgl|context lost|shader/i.test(message)) {
            setInitializationError("The 3D map encountered a graphics error. Switch to the 2D map to continue.");
            setBasemapStatus("unavailable");
            return;
          }
          if (!styleReadyRef.current || host === "tiles.openfreemap.org") {
            setBasemapStatus(styleReadyRef.current ? "degraded" : "unavailable");
            if (!styleReadyRef.current) setInitializationError("The 3D map could not load its basemap. Switch to the 2D map to continue.");
          }
        });

        map.on("style.load", () => {
          if (cancelled || !map) return;
          styleReadyRef.current = true;
          setStyleReady(true);
          setBasemapStatus("ready");
          try {
            const currentData = latestDataRef.current;
            if (currentData.routeFeature) {
              const lineStyles = getRouteMapLineStyles(Boolean(currentData.selectedFeature));
              if (!map.getSource("gpx-route")) map.addSource("gpx-route", { type: "geojson", data: currentData.routeFeature });
              if (!map.getLayer("gpx-route-halo")) map.addLayer({
                id: "gpx-route-halo", type: "line", source: "gpx-route",
                layout: { "line-cap": "round", "line-join": "round" },
                paint: { "line-color": lineStyles.contextHalo.color, "line-width": lineStyles.contextHalo.width, "line-opacity": lineStyles.contextHalo.opacity },
              });
              if (!map.getLayer("gpx-route-line")) map.addLayer({
                id: "gpx-route-line", type: "line", source: "gpx-route",
                layout: { "line-cap": "round", "line-join": "round" },
                paint: { "line-color": lineStyles.contextLine.color, "line-width": lineStyles.contextLine.width, "line-opacity": lineStyles.contextLine.opacity },
              });
              if (!map.getSource("gpx-endpoints")) map.addSource("gpx-endpoints", { type: "geojson", data: endpointFeatureCollection(currentData.points) });
              if (!map.getLayer("gpx-endpoints-circles")) map.addLayer({ id: "gpx-endpoints-circles", type: "circle", source: "gpx-endpoints", paint: { "circle-radius": 6, "circle-color": ["match", ["get", "label"], "Start", "#a7c957", "#ffffff"], "circle-stroke-color": "#17211c", "circle-stroke-width": 2 } });
              if (!map.getLayer("gpx-endpoints-labels")) map.addLayer({ id: "gpx-endpoints-labels", type: "symbol", source: "gpx-endpoints", layout: { "text-field": ["get", "label"], "text-size": 11, "text-offset": [0, -1.4], "text-allow-overlap": true }, paint: { "text-color": "#17211c", "text-halo-color": "#ffffff", "text-halo-width": 1.5 } });
              if (!map.getSource("gpx-selected")) map.addSource("gpx-selected", { type: "geojson", data: currentData.selectedFeature ?? { type: "FeatureCollection", features: [] } });
              if (!map.getLayer("gpx-selected-halo")) map.addLayer({
                id: "gpx-selected-halo", type: "line", source: "gpx-selected",
                layout: { "line-cap": "round", "line-join": "round" },
                paint: { "line-color": lineStyles.selectedHalo.color, "line-width": lineStyles.selectedHalo.width, "line-opacity": lineStyles.selectedHalo.opacity },
              });
              if (!map.getLayer("gpx-selected-line")) map.addLayer({
                id: "gpx-selected-line", type: "line", source: "gpx-selected",
                layout: { "line-cap": "round", "line-join": "round" },
                paint: { "line-color": lineStyles.selectedLine.color, "line-width": lineStyles.selectedLine.width, "line-opacity": lineStyles.selectedLine.opacity },
              });
              if (!map.getSource("gpx-selected-endpoints")) map.addSource("gpx-selected-endpoints", { type: "geojson", data: currentData.selectedEndpointFeature });
              if (!map.getLayer("gpx-selected-endpoint-circles")) map.addLayer({
                id: "gpx-selected-endpoint-circles", type: "circle", source: "gpx-selected-endpoints",
                paint: { "circle-radius": 5, "circle-color": "#f2a23a", "circle-stroke-color": "#17211c", "circle-stroke-width": 2 },
              });
              if (!map.getLayer("gpx-selected-endpoint-labels")) map.addLayer({
                id: "gpx-selected-endpoint-labels", type: "symbol", source: "gpx-selected-endpoints",
                layout: { "text-field": ["get", "label"], "text-size": 9, "text-offset": [0, 1.35], "text-anchor": "top", "text-allow-overlap": true },
                paint: { "text-color": "#17211c", "text-halo-color": "#ffffff", "text-halo-width": 1.5 },
              });
              if (currentData.keyMomentMarkers.length) {
                const momentFeatures = keyMomentFeatureCollection(currentData.keyMomentMarkers, currentData.selectedKeyMomentId);
                if (!map.getSource("key-moments")) map.addSource("key-moments", { type: "geojson", data: momentFeatures });
                if (!map.getSource("key-moment-leaders")) map.addSource("key-moment-leaders", { type: "geojson", data: keyMomentLeaderFeatureCollection(currentData.keyMomentMarkers) });
                if (!map.getLayer("key-moment-leaders-casing")) map.addLayer({
                  id: "key-moment-leaders-casing", type: "line", source: "key-moment-leaders",
                  layout: { "line-cap": "round" },
                  paint: { "line-color": "#17211c", "line-width": 2.5, "line-opacity": 0.82 },
                });
                if (!map.getLayer("key-moment-leaders-line")) map.addLayer({
                  id: "key-moment-leaders-line", type: "line", source: "key-moment-leaders",
                  layout: { "line-cap": "round" },
                  paint: { "line-color": "#f2a23a", "line-width": 1.2, "line-opacity": 0.95 },
                });
                if (!map.getLayer("key-moment-circles")) map.addLayer({
                  id: "key-moment-circles", type: "circle", source: "key-moments",
                  paint: {
                    "circle-radius": ["case", ["boolean", ["get", "selected"], false], 13, 11],
                    "circle-color": ["case", ["boolean", ["get", "selected"], false], "#a7c957", "#f2a23a"],
                    "circle-stroke-color": "#17211c", "circle-stroke-width": 2.5,
                  },
                });
                if (!map.getLayer("key-moment-numbers")) map.addLayer({
                  id: "key-moment-numbers", type: "symbol", source: "key-moments",
                  layout: { "text-field": ["get", "number"], "text-size": 10, "text-font": ["Open Sans Bold"], "text-allow-overlap": true, "text-ignore-placement": true, "symbol-placement": "point", "symbol-height-anchor": "ground" },
                  paint: { "text-color": "#17211c", "text-halo-color": "#fffdf7", "text-halo-width": 0.5 },
                });
                map.on("click", "key-moment-circles", (event) => {
                  const feature = event.features?.[0];
                  const id = feature?.properties?.id;
                  if (typeof id === "string") selectKeyMomentRef.current?.(id);
                });
                map.on("mouseenter", "key-moment-circles", () => { map!.getCanvas().style.cursor = "pointer"; });
                map.on("mouseleave", "key-moment-circles", () => { map!.getCanvas().style.cursor = ""; });
                scheduleKeyMomentLayoutRef.current?.();
              }
              setRouteStatus("loading");
            } else {
              setRouteStatus("unavailable");
            }
            if (!map.getSource("mapterhorn-dem")) map.addSource("mapterhorn-dem", {
              type: "raster-dem", url: MAPTERHORN_TILEJSON, tileSize: 512, encoding: "terrarium",
              attribution: '<a href="https://mapterhorn.com/attribution" target="_blank" rel="noreferrer">© Mapterhorn</a>',
            });
            const firstSymbolLayer = map.getStyle().layers.find((layer) => layer.type === "symbol")?.id;
            if (!map.getLayer("mapterhorn-hillshade")) map.addLayer({
              id: "mapterhorn-hillshade", type: "hillshade", source: "mapterhorn-dem",
              paint: { "hillshade-exaggeration": 0.2 },
            }, firstSymbolLayer);
            map.setTerrain({ source: "mapterhorn-dem", exaggeration: 1.05 });
            updateTerrainStatus("loading");
            terrainHintTimeoutRef.current = setTimeout(() => {
              updateTerrainStatus(expireTerrainLoadingHint(terrainStatusRef.current));
              terrainHintTimeoutRef.current = null;
            }, TERRAIN_LOADING_HINT_DELAY_MS);
            if (currentData.bounds) {
              const camera = map.cameraForBounds(currentData.bounds, { padding: 58, maxZoom: 12.5, pitch: 53, bearing: -22 });
              if (camera) map.jumpTo({ ...camera, pitch: 53, bearing: -22 });
            }
          } catch {
            setInitializationError("The 3D map could not be initialized. Switch to the 2D map to continue.");
            setBasemapStatus("unavailable");
            updateTerrainStatus("unavailable");
          }
        });
        map.on("sourcedata", (event) => {
          if (event.isSourceLoaded && event.sourceDataType === "content" && event.sourceId === "gpx-route") setRouteStatus("ready");
          if (event.sourceId === "mapterhorn-dem" && !terrainFailedRef.current) {
            updateTerrainStatus(resolveTerrainReadiness(terrainStatusRef.current, event));
          }
        });
      } catch {
        if (!cancelled) {
          setInitializationError("The 3D map could not be initialized. Switch to the 2D map to continue.");
          setBasemapStatus("unavailable");
          setRouteStatus("unavailable");
          updateTerrainStatus("unavailable");
        }
      }
    }

    void initialize();
    return () => {
      cancelled = true;
      scheduleKeyMomentLayoutRef.current = null;
      if (keyMomentLayoutFrameRef.current) cancelAnimationFrame(keyMomentLayoutFrameRef.current);
      keyMomentLayoutFrameRef.current = 0;
      if (terrainHintTimeoutRef.current) clearTimeout(terrainHintTimeoutRef.current);
      terrainHintTimeoutRef.current = null;
      resizeObserver?.disconnect();
      if (resizeFrame) cancelAnimationFrame(resizeFrame);
      wheelZoomRef.current?.dispose();
      wheelZoomRef.current = null;
      styleReadyRef.current = false;
      map?.remove();
      mapRef.current = null;
    };
  }, []);

  useEffect(() => {
    const map = mapRef.current;
    if (!styleReady || !map || previousPointsRef.current === points) return;
    previousPointsRef.current = points;
    const latest = latestDataRef.current;
    const source = map.getSource("gpx-route") as GeoJSONSource | undefined;
    if (latest.routeFeature) {
      source?.setData(latest.routeFeature);
      const endpoints = map.getSource("gpx-endpoints") as GeoJSONSource | undefined;
      endpoints?.setData(endpointFeatureCollection(latest.points));
      setRouteStatus("loading");
      if (!focusKey && latest.bounds) {
        const camera = map.cameraForBounds(latest.bounds, { padding: 58, maxZoom: 12.5, pitch: 53, bearing: -22 });
        if (camera) map.easeTo({ ...camera, pitch: 53, bearing: -22, duration: 450 });
      }
    } else setRouteStatus("unavailable");
  }, [focusKey, points, routeFeature, styleReady]);

  useEffect(() => {
    const map = mapRef.current;
    if (!styleReady || !map) return;
    const source = map.getSource("gpx-selected") as GeoJSONSource | undefined;
    source?.setData(selectedFeature ?? { type: "FeatureCollection", features: [] });
    const endpointSource = map.getSource("gpx-selected-endpoints") as GeoJSONSource | undefined;
    endpointSource?.setData(selectedEndpointFeature);
    const lineStyles = getRouteMapLineStyles(Boolean(selectedFeature));
    if (map.getLayer("gpx-route-halo")) {
      map.setPaintProperty("gpx-route-halo", "line-width", lineStyles.contextHalo.width);
      map.setPaintProperty("gpx-route-halo", "line-opacity", lineStyles.contextHalo.opacity);
    }
    if (map.getLayer("gpx-route-line")) {
      map.setPaintProperty("gpx-route-line", "line-width", lineStyles.contextLine.width);
      map.setPaintProperty("gpx-route-line", "line-opacity", lineStyles.contextLine.opacity);
    }
  }, [selectedFeature, selectedEndpointFeature, styleReady]);

  useEffect(() => {
    const map = mapRef.current;
    if (!styleReady || !map || focusKey === previousFocusKeyRef.current) return;
    if (!focusOnKeyChange && previousFocusKeyRef.current !== null) {
      previousFocusKeyRef.current = focusKey;
      return;
    }
    previousFocusKeyRef.current = focusKey;
    if (focusKey && selectedBounds) {
      const camera = map.cameraForBounds(selectedBounds, { padding: 54, maxZoom: 14, pitch: 53, bearing: map.getBearing() });
      if (camera) map.easeTo({ ...camera, pitch: 53, duration: 450 });
    } else if (!focusKey && bounds) {
      const camera = map.cameraForBounds(bounds, { padding: 58, maxZoom: 12.5, pitch: 53, bearing: -22 });
      if (camera) map.easeTo({ ...camera, pitch: 53, bearing: -22, duration: 450 });
    }
  }, [focusKey, selectedBounds, styleReady, bounds, focusOnKeyChange]);

  useEffect(() => {
    if (styleReady) scheduleKeyMomentLayoutRef.current?.();
  }, [keyMomentMarkers, selectedKeyMomentId, styleReady]);

  // Keep the fixed-height map viewport and its controls in normal document
  // flow so the Flyover panel below never covers the rendered terrain.
  return <MapFullscreenRegion label={label} onResize={() => mapRef.current?.resize()}>
    {(fullscreen, fullscreenButton) => <>
    <div className={`relative min-h-0 min-w-0 overflow-hidden ${fullscreen ? "map-fullscreen-map-viewport w-full bg-[#dfe3d8]" : frameClassName}`}>
    <div ref={containerRef} className="absolute inset-0" style={{ position: "absolute", inset: 0, width: "100%", height: "100%", minWidth: 0, minHeight: 0 }} role="region" aria-label={`${label}. Use map controls, mouse drag, wheel or touch gestures to navigate.`} />
    {basemapStatus === "loading" && <div className="absolute inset-0 z-10 flex items-center justify-center bg-[#f5f5ef]/80 text-sm text-[#46514d]" role="status">Loading 3D terrain map…</div>}
    {(basemapStatus === "unavailable" || routeStatus === "unavailable") && <div className="absolute inset-x-3 bottom-3 z-20 flex flex-wrap items-center justify-between gap-2 rounded-xl border border-red-900/15 bg-white/95 p-3 text-sm text-[#17211c] shadow" role="alert">
      <span>{initializationError || "3D map could not be displayed. Your route analysis is unchanged."}</span>
      {allow2dFallback && <button type="button" onClick={onFallbackTo2d} className="min-h-10 shrink-0 rounded-full bg-[#17211c] px-4 text-xs font-semibold text-white focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#71805d]">Switch to 2D Map</button>}
    </div>}
    {styleReady && terrainStatus === "unavailable" && basemapStatus !== "unavailable" && <div className="absolute bottom-3 left-3 z-20 flex max-w-[calc(100%-1.5rem)] flex-wrap items-center gap-2 rounded-lg bg-white/95 px-3 py-2 text-xs text-[#46514d] shadow" role="status"><span>3D terrain is unavailable; the map and route remain visible.</span>{allow2dFallback && <button type="button" onClick={onFallbackTo2d} className="min-h-8 rounded-full bg-[#17211c] px-3 font-semibold text-white focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#71805d]">Switch to 2D</button>}</div>}
    {styleReady && terrainStatus === "loading" && <span className="absolute right-2 top-28 z-10 rounded bg-white/85 px-2 py-1 text-[10px] font-medium text-[#46514d] shadow-sm" role="status">Loading terrain…</span>}
    {styleReady && terrainStatus === "ready" && <span className="absolute right-2 top-28 z-10 rounded bg-white/85 px-2 py-1 text-[10px] font-medium text-[#46514d] shadow-sm" aria-label="3D terrain loaded">3D terrain</span>}
    {styleReady && basemapStatus === "degraded" && <div className="absolute inset-x-3 bottom-3 z-20 flex flex-wrap items-center justify-between gap-2 rounded-lg bg-white/95 px-3 py-2 text-xs text-[#46514d] shadow" role="status"><span>Some basemap tiles are unavailable; the GPX route may remain visible.</span>{allow2dFallback && <button type="button" onClick={onFallbackTo2d} className="min-h-8 rounded-full bg-[#17211c] px-3 font-semibold text-white focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#71805d]">Switch to 2D</button>}</div>}
    <div className="sr-only" aria-live="polite">{basemapStatus === "degraded" ? "The basemap has limited tile availability." : ""}{routeStatus === "ready" ? "GPX route displayed." : routeStatus === "unavailable" ? "GPX route could not be displayed." : ""}</div>
    <div className="absolute bottom-1 right-1 z-10 rounded bg-white/75 px-2 py-1 text-[10px] text-[#17211c]">© OpenFreeMap · © OpenStreetMap · © Mapterhorn</div>
    <div className="absolute left-2 top-2 z-10 flex max-w-[calc(100%-3rem)] flex-wrap gap-2">
      <button type="button" onClick={() => fitRoute(false)} disabled={!styleReady || !bounds} className={MAP_CONTROL_BUTTON_CLASS}>Fit route</button>
      <button type="button" onClick={() => fitRoute(true)} disabled={!styleReady || !bounds} className={MAP_CONTROL_BUTTON_CLASS}>Reset 3D view</button>
      <button type="button" aria-pressed={wheelZoomActive} aria-label={wheelZoomActive ? "Disable map scroll-wheel zoom" : "Enable map scroll-wheel zoom"} onClick={() => wheelZoomActive ? wheelZoomRef.current?.deactivate() : wheelZoomRef.current?.activate()} disabled={!styleReady} className={MAP_CONTROL_BUTTON_CLASS}>{wheelZoomActive ? "Scroll to zoom · Esc to exit" : "Enable wheel zoom"}</button>
      {fullscreenButton}
    </div>
    {mapBadgeText && <div className="pointer-events-none absolute bottom-4 left-4 z-10 max-w-[calc(100%-2rem)] truncate rounded-full bg-white/90 px-4 py-2 text-xs font-semibold text-black shadow-sm backdrop-blur sm:bottom-5 sm:left-5">{mapBadgeText}</div>}
    </div>
    {enableFlyover && styleReady && mapInstance && <RouteFlyover
      map={mapInstance}
      points={showSelectedSectionMarkers ? selectedPoints : points}
      units={units}
      terrainStatus={terrainStatus}
      fullscreenLayout={fullscreen}
    />}
    </>}
  </MapFullscreenRegion>;
}

function keyMomentFeatureCollection(markers: readonly KeyMomentMapMarker[], selectedId: string | null, displayCoordinates?: ReadonlyMap<string, [number, number]>) {
  return {
    type: "FeatureCollection" as const,
    features: markers.map((marker) => ({
      type: "Feature" as const,
      properties: { id: marker.id, number: marker.number, selected: marker.id === selectedId },
      geometry: { type: "Point" as const, coordinates: displayCoordinates?.get(marker.id) ?? [marker.longitude, marker.latitude] },
    })),
  };
}

function keyMomentLeaderFeatureCollection(markers: readonly KeyMomentMapMarker[], displayCoordinates?: ReadonlyMap<string, [number, number]>) {
  return {
    type: "FeatureCollection" as const,
    features: markers.flatMap((marker) => {
      const display = displayCoordinates?.get(marker.id) ?? [marker.longitude, marker.latitude];
      if (Math.abs(display[0] - marker.longitude) < 1e-10 && Math.abs(display[1] - marker.latitude) < 1e-10) return [];
      return [{
        type: "Feature" as const,
        properties: { id: marker.id },
        geometry: { type: "LineString" as const, coordinates: [[marker.longitude, marker.latitude], display] },
      }];
    }),
  };
}
