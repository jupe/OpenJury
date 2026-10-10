import { ImageResponse } from "next/og";
import { createElement } from "react";

export function GET() {
  return new ImageResponse(
    createElement("div", { style: { display: "flex", width: "100%", height: "100%", alignItems: "center", justifyContent: "center", background: "#FFF8F0", color: "#2D3142", fontSize: 75, fontWeight: 700 } }, "OJ"),
    { width: 192, height: 192 },
  );
}
