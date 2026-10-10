import { ImageResponse } from "next/og";

export const size = { width: 512, height: 512 };
export const contentType = "image/png";

export default function Icon() {
  return new ImageResponse(
    <div style={{ display: "flex", width: "100%", height: "100%", alignItems: "center", justifyContent: "center", background: "#FFF8F0", color: "#2D3142", fontSize: 200, fontWeight: 700 }}>OJ</div>,
    size,
  );
}
