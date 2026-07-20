import "./globals.css";

export const metadata = {
  title: "Load Tracker",
  description: "Track load ETAs from Samsara and get alerts when they run late.",
};

export default function RootLayout({ children }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
