import type { Metadata } from "next";
import type { ReactNode } from "react";

export const metadata: Metadata = {
  title: "Onboarding Sequence",
  description: "Send a warm onboarding email sequence the moment a customer pays.",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body
        style={{
          margin: 0,
          fontFamily: "system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif",
          background: "#0d1017",
          color: "#e7eaf0",
        }}
      >
        {children}
      </body>
    </html>
  );
}
