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

// Runs BEFORE the first paint, which is the whole point.
//
// If the theme were applied from a React effect the browser would paint the
// light palette first and then repaint dark — a full-screen white flash on
// every navigation. That is genuinely unpleasant at 3am, which is when a
// dispatcher is most likely to be looking at this. Blocking for one tiny
// synchronous script is the right trade.
//
// It mirrors applyTheme() in ThemeToggle.js: stored preference wins, otherwise
// follow the operating system.
const THEME_INIT = `
(function(){
  try {
    var p = localStorage.getItem('truckon-theme');
    var dark = p === 'dark' || (p !== 'light' &&
      window.matchMedia('(prefers-color-scheme: dark)').matches);
    document.documentElement.setAttribute('data-theme', dark ? 'dark' : 'light');
  } catch (e) {
    document.documentElement.setAttribute('data-theme', 'light');
  }
})();
`;

export default function RootLayout({ children }) {
  return (
    // suppressHydrationWarning because the script above mutates <html> before
    // React hydrates, so the server markup and the DOM legitimately differ.
    <html lang="en" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: THEME_INIT }} />
      </head>
      <body>{children}</body>
    </html>
  );
}
