import type { Metadata } from "next";
import Script from "next/script";
import Layout from "@/components/Layout";
import "./globals.css";

export const metadata: Metadata = {
  title: "OpenJury",
  description: "A multi-tenant competition and blind-voting platform.",
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body>
        <Script src="/runtime-config.js" strategy="beforeInteractive" />
        <Layout>{children}</Layout>
      </body>
    </html>
  );
}
