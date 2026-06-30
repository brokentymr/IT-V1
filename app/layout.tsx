import type { ReactNode } from "react";
import "./globals.css";

export const metadata = {
  title: "Investing Together — Console",
  description: "Operator console for the research-and-content platform.",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>
        <header className="nav">
          <span className="brand">Investing&nbsp;Together</span>
          <a href="/universe">Universe</a>
          <a href="/jobs">Pipeline</a>
          <span style={{ flex: 1 }} />
          <a href="/api/health" className="faint">health</a>
        </header>
        {children}
      </body>
    </html>
  );
}
