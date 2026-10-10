import type { ReactNode } from "react";

export const metadata = { title: "ASO Dashboard" };

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body style={{ fontFamily: "system-ui, sans-serif", margin: "2rem" }}>{children}</body>
    </html>
  );
}
