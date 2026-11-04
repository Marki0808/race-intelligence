import type { Metadata } from "next";
import AnalyticsConsentManager from "./AnalyticsConsentManager";
import "./globals.css";

export const metadata: Metadata = {
  applicationName: "Endurset",
  title: "Endurset — GPX Route Analysis for Trail Running",
  description: "Understand your trail route before race day. Upload a GPX file to explore the elevation profile, key climbs and descents, meaningful route sections, and practical course insights.",
  openGraph: {
    title: "Endurset — GPX Route Analysis for Trail Running",
    description: "Understand your trail route before race day. Upload a GPX file to explore the elevation profile, key climbs and descents, meaningful route sections, and practical course insights.",
    siteName: "Endurset",
    type: "website",
    locale: "en_US",
  },
  twitter: {
    card: "summary",
    title: "Endurset — GPX Route Analysis for Trail Running",
    description: "Understand your trail route before race day. Upload a GPX file to explore the elevation profile, key climbs and descents, meaningful route sections, and practical course insights.",
  },
  icons: {
    icon: [
      { url: "/brand/icons/endurset-icon-light-16.png", sizes: "16x16", type: "image/png" },
      { url: "/brand/icons/endurset-icon-light-32.png", sizes: "32x32", type: "image/png" },
      { url: "/brand/icons/endurset-icon-light-64.png", sizes: "64x64", type: "image/png" },
      { url: "/brand/icons/endurset-icon-light-512.png", sizes: "512x512", type: "image/png" },
      { url: "/brand/icons/endurset-icon-dark-16.png", sizes: "16x16", type: "image/png", media: "(prefers-color-scheme: dark)" },
      { url: "/brand/icons/endurset-icon-dark-32.png", sizes: "32x32", type: "image/png", media: "(prefers-color-scheme: dark)" },
      { url: "/brand/icons/endurset-icon-dark-64.png", sizes: "64x64", type: "image/png", media: "(prefers-color-scheme: dark)" },
      { url: "/brand/icons/endurset-icon-dark-512.png", sizes: "512x512", type: "image/png", media: "(prefers-color-scheme: dark)" },
    ],
  },
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en" className="h-full antialiased">
      <body className="min-h-full flex flex-col">{children}<AnalyticsConsentManager /></body>
    </html>
  );
}
