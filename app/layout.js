import "./globals.css";

// Next.js App Router picks up app/icon.png and app/apple-icon.png by filename
// and emits the <link rel="icon"> tags itself — there is deliberately no manual
// <head> block here. metadataBase makes the OG image URL absolute, which every
// link-preview scraper requires.
const site = process.env.NEXT_PUBLIC_APP_URL || "https://truckon.site";

export const metadata = {
  metadataBase: new URL(site),
  title: {
    default: "TruckOn.site — load tracking and late alerts",
    template: "%s · TruckOn.site",
  },
  description:
    "Track truck ETAs against delivery appointments and get alerted the moment a load is projected to run late.",
  applicationName: "TruckOn.site",
  openGraph: {
    title: "TruckOn.site — load tracking and late alerts",
    description:
      "Track truck ETAs against delivery appointments and get alerted the moment a load is projected to run late.",
    url: site,
    siteName: "TruckOn.site",
    images: [{ url: "/og.png", width: 1200, height: 630 }],
    type: "website",
  },
  // A dispatcher's load table is behind a login and has no business in anyone's
  // search index.
  robots: { index: false, follow: false },
};

export default function RootLayout({ children }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
