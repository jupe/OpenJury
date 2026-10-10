import { ImageResponse } from "next/og";

export const size = { width: 180, height: 180 };
export const contentType = "image/png";

export default function AppleIcon() {
  return new ImageResponse(
    <div style={{ display: "flex", width: "100%", height: "100%", alignItems: "center", justifyContent: "center", background: "#FFF8F0", color: "#2D3142", fontSize: 70, fontWeight: 700 }}>OJ</div>,
    size,
  );
}
