import { qrModules } from './qrMatrix'

/**
 * Render a value as an inline-SVG QR code. Always dark-on-white regardless of
 * theme — a QR must keep high contrast to scan, and a dark-on-dark code does
 * not. The white quiet zone (border) is required by the QR spec for decoding.
 */
export function QrCode({ value, size = 208 }: { value: string; size?: number }) {
  const modules = qrModules(value)
  const n = modules.length
  const quiet = 4
  const total = n + quiet * 2

  let path = ''
  for (let r = 0; r < n; r++) {
    for (let c = 0; c < n; c++) {
      if (modules[r][c]) path += `M${c + quiet},${r + quiet}h1v1h-1z`
    }
  }

  return (
    <svg
      className="qr"
      width={size}
      height={size}
      viewBox={`0 0 ${total} ${total}`}
      shapeRendering="crispEdges"
      role="img"
    >
      <rect width={total} height={total} fill="#ffffff" />
      <path d={path} fill="#000000" />
    </svg>
  )
}
