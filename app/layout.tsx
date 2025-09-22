import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: {
    default: "Boxing Progress Tracker",
    template: "%s | Boxing Progress Tracker",
  },
  description:
    "Plan, run, and analyze high-intensity boxing workouts with punch tracking, power insights, and guided timers.",
  keywords: [
    "boxing",
    "boxing app",
    "boxing workout tracker",
    "HIIT boxing",
    "punch tracking",
    "fitness analytics",
  ],
  authors: [{ name: "Boxing App Team" }],
  creator: "Boxing App Team",
  publisher: "Boxing App Team",
  category: "fitness",
  alternates: {
    canonical: "/",
  },
  openGraph: {
    title: "Boxing Progress Tracker",
    description:
      "Keep your boxing sessions on track with guided HIIT rounds, punch tracking, and performance comparisons.",
    url: "/",
    siteName: "Boxing Progress Tracker",
    locale: "en_US",
    type: "website",
  },
  twitter: {
    card: "summary_large_image",
    title: "Boxing Progress Tracker",
    description:
      "Your boxing training companion for guided workouts, punch metrics, and performance analytics.",
  },
  robots: {
    index: true,
    follow: true,
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body
        className={`${geistSans.variable} ${geistMono.variable} antialiased`}
      >
        {children}
      </body>
    </html>
  );
}
