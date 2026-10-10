import type { Metadata, Viewport } from "next";
import Script from "next/script";
import Layout from "@/components/Layout";
import { LocaleProvider } from "@/lib/i18n";
import { ThemeProvider } from "@/lib/theme";
import "./globals.css";

export const metadata: Metadata = {
  title: "OpenJury",
  description: "A multi-tenant competition and blind-voting platform.",
  appleWebApp: { capable: true, title: "OpenJury", statusBarStyle: "default" },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
  themeColor: "#FFF8F0",
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body>
        <Script src="/runtime-config.js" strategy="beforeInteractive" />
        <LocaleProvider><ThemeProvider><Layout>{children}</Layout></ThemeProvider></LocaleProvider>
      </body>
    </html>
  );
}
