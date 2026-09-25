"use client";

import { useEffect } from "react";
import type { MapillaryImageEvidence } from "./mapillaryTerrainProof";

export default function TerrainImageViewer({
  image,
  onClose,
}: {
  image: MapillaryImageEvidence | null;
  onClose: () => void;
}) {
  useEffect(() => {
    if (!image) return;
    function closeOnEscape(event: KeyboardEvent) {
      if (event.key === "Escape") onClose();
    }
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [image, onClose]);

  if (!image) return null;
  const capturedDate = image.capturedAt === null
    ? null
    : new Date(image.capturedAt).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });

  return (
    <div
      className="fixed inset-0 z-[2000] flex items-center justify-center bg-black/70 p-4"
      role="presentation"
      onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}
    >
      <section
        role="dialog"
        aria-modal="true"
        aria-labelledby="terrain-image-title"
        className="w-full max-w-3xl overflow-hidden rounded-3xl bg-white shadow-2xl"
      >
        <div className="flex items-center justify-between gap-4 border-b border-black/10 px-5 py-4">
          <div>
            <h2 id="terrain-image-title" className="font-semibold">Terrain photo</h2>
            <p className="mt-1 text-xs text-black/45">© Mapillary</p>
          </div>
          <button type="button" onClick={onClose} aria-label="Close terrain photo" className="rounded-full border border-black/10 px-3 py-1.5 text-sm hover:bg-black/5">Close</button>
        </div>
        {image.thumbnailUrl ? (
          // Mapillary supplies the thumbnail URL through its API.
          // eslint-disable-next-line @next/next/no-img-element
          <img src={image.thumbnailUrl} alt="Mapillary terrain view" className="max-h-[65vh] w-full bg-black object-contain" />
        ) : (
          <div className="flex min-h-56 items-center justify-center bg-[#f4f2ed] px-6 text-center text-sm text-black/50">
            Preview image is unavailable. The original Mapillary image can still be opened.
          </div>
        )}
        <div className="flex flex-wrap items-center justify-between gap-4 px-5 py-4">
          <div className="text-sm text-black/60">
            <p>~{image.distanceAlongRouteKm.toFixed(2)} km along route</p>
            {capturedDate && <p className="mt-1">Captured {capturedDate}</p>}
            <p className="mt-1">© Mapillary</p>
          </div>
          <a href={image.sourceUrl} target="_blank" rel="noreferrer" className="rounded-full bg-[#17211c] px-4 py-2.5 text-sm font-semibold text-white hover:bg-[#2b3a31]">
            Open on Mapillary
          </a>
        </div>
      </section>
    </div>
  );
}
