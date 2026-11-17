"use client";

import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";

type FullscreenMode = "closed" | "native" | "fallback";

export const MAP_CONTROL_BUTTON_CLASS = "min-h-9 rounded-full border border-black/10 bg-white/90 px-3 text-xs font-semibold text-[#17211c] shadow-sm backdrop-blur hover:bg-white focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#315b43] disabled:opacity-50";

/** A shared, non-remounting fullscreen shell for the live Leaflet and MapLibre views. */
export default function MapFullscreenRegion({
  children,
  className = "relative min-w-0",
  label = "map",
  onResize,
}: {
  children: (fullscreen: boolean, fullscreenButton: ReactNode) => ReactNode;
  className?: string;
  label?: string;
  onResize?: () => void;
}) {
  const regionRef = useRef<HTMLDivElement | null>(null);
  const onResizeRef = useRef(onResize);
  const [mode, setMode] = useState<FullscreenMode>("closed");
  useEffect(() => {
    onResizeRef.current = onResize;
  }, [onResize]);

  const exit = useCallback(async () => {
    if (mode === "native" && document.fullscreenElement === regionRef.current) {
      try {
        await document.exitFullscreen();
      } catch {
        setMode("closed");
      }
      return;
    }
    setMode("closed");
  }, [mode]);

  const toggle = useCallback(async () => {
    if (mode !== "closed") {
      await exit();
      return;
    }
    const region = regionRef.current;
    if (region?.requestFullscreen) {
      try {
        await region.requestFullscreen();
        setMode("native");
        return;
      } catch {
        // Some mobile browsers expose the API but reject fullscreen for elements.
      }
    }
    setMode("fallback");
  }, [exit, mode]);

  useEffect(() => {
    const handleFullscreenChange = () => {
      if (document.fullscreenElement === regionRef.current) setMode("native");
      else setMode((current) => current === "native" ? "closed" : current);
    };
    document.addEventListener("fullscreenchange", handleFullscreenChange);
    return () => document.removeEventListener("fullscreenchange", handleFullscreenChange);
  }, []);

  useEffect(() => {
    if (mode !== "fallback") return;
    const body = document.body;
    const root = document.documentElement;
    const scrollY = window.scrollY;
    const savedBody = {
      overflow: body.style.overflow,
      position: body.style.position,
      top: body.style.top,
      width: body.style.width,
    };
    const savedRootOverflow = root.style.overflow;
    body.style.position = "fixed";
    body.style.top = `-${scrollY}px`;
    body.style.width = "100%";
    body.style.overflow = "hidden";
    root.style.overflow = "hidden";
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setMode("closed");
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("keydown", handleKeyDown);
      body.style.overflow = savedBody.overflow;
      body.style.position = savedBody.position;
      body.style.top = savedBody.top;
      body.style.width = savedBody.width;
      root.style.overflow = savedRootOverflow;
      window.scrollTo(0, scrollY);
    };
  }, [mode]);

  useEffect(() => {
    if (mode === "closed") return;
    const frame = requestAnimationFrame(() => onResizeRef.current?.());
    return () => cancelAnimationFrame(frame);
  }, [mode]);

  useEffect(() => () => {
    if (document.fullscreenElement === regionRef.current) void document.exitFullscreen().catch(() => undefined);
  }, []);

  const fullscreen = mode !== "closed";
  const fullscreenButton = <button
    type="button"
    onClick={() => void toggle()}
    aria-label={`${fullscreen ? "Exit" : "Enter"} fullscreen ${label}`}
    aria-pressed={fullscreen}
    className={MAP_CONTROL_BUTTON_CLASS}
  >{fullscreen ? "Exit full screen" : "Full screen"}</button>;
  return <div
    ref={regionRef}
    className={`map-fullscreen-region ${fullscreen ? "map-fullscreen-region--active" : className}`}
    data-map-fullscreen={fullscreen ? mode : "closed"}
  >
    {children(fullscreen, fullscreenButton)}
  </div>;
}
