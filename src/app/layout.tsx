import type { Metadata, Viewport } from "next";
import { Geist_Mono, Instrument_Sans } from "next/font/google";
import "./globals.css";
import "./handoff.css";
import "./people.css";
import { CommandPalette } from "@/components/CommandPalette";
import { Keys } from "@/components/Keys";
import "./closewrap.css";
import "./wow2.css";
import "./wow3.css";
import "./ask.css";
import "./calendar.css";
import "./capture.css";
import "./hosted.css";
import "./names.css";
import "./workspace.css";
import "./integrations.css";
import "./channels.css";
import "./sources.css";
import "./review.css";
import "./editor.css";
import "./vault.css";
import { QuickCapture } from "@/components/QuickCapture";
import { ItemKeys } from "@/components/ItemKeys";
import "./platforms.css";
import "./graph.css";
import "./structure.css";
import { PwaRegister } from "@/components/PwaRegister";

const sans = Instrument_Sans({ subsets: ["latin"], weight: ["400", "500", "600"], variable: "--font-instrument-sans", display: "swap" });
const mono = Geist_Mono({ subsets: ["latin"], weight: ["400", "500"], variable: "--font-geist-mono", display: "swap" });

export const metadata: Metadata = {
  title: { default: "Daily brief", template: "%s · Daily brief" },
  description: "Your meetings, turned into your day: what you owe, what you're waiting on, and what was decided.",
  appleWebApp: { capable: true, title: "Daily brief", statusBarStyle: "default" },
  icons: { apple: "/apple-touch-icon.png" },
};

export const viewport: Viewport = {
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#ffffff" },
    { media: "(prefers-color-scheme: dark)", color: "#0b0b0c" },
  ],
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en" className={`${sans.variable} ${mono.variable}`}>
      <body>
        {/* Settings › Appearance: the theme is read per request, so it can change without a rebuild. */}
        {/* eslint-disable-next-line @next/next/no-css-tags */}
        <link rel="stylesheet" href="/api/theme-css" precedence="theme" />
        {children}
        <CommandPalette />
        <Keys />
        <QuickCapture />
        <ItemKeys />
        <PwaRegister />
      </body>
    </html>
  );
}
