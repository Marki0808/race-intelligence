"use client";

export default function PrivacySettingsLink({ lightSurface = false }: { lightSurface?: boolean }) {
  return <button type="button" onClick={() => window.dispatchEvent(new Event("endurset:open-privacy-settings"))} className={lightSurface
    ? "text-[#526253] underline underline-offset-2 transition hover:text-[#203329] focus-visible:rounded focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#71805d]"
    : "transition hover:text-white focus-visible:rounded focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#d8eea5]"}>Privacy settings</button>;
}
