import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Race Intelligence | GPX Route Analysis",
  description: "Understand a trail route from its GPX with an elevation profile, route sections, key moments and section descriptions.",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en" className="h-full antialiased">
      <body className="min-h-full flex flex-col">{children}</body>
    </html>
  );
}
