import qrcode from 'qrcode-generator'

/**
 * Encode `value` as a QR matrix (true = dark module). Pure and framework-free
 * so it can be unit-tested (encode → rasterize → decode round-trip). Error
 * correction level 'M' with automatic version sizing; our payloads (a 43-char
 * public key or a ~58-char key backup) are short, so this never overflows.
 */
export function qrModules(value: string): boolean[][] {
  const qr = qrcode(0, 'M')
  qr.addData(value)
  qr.make()
  const n = qr.getModuleCount()
  const rows: boolean[][] = []
  for (let r = 0; r < n; r++) {
    const row: boolean[] = []
    for (let c = 0; c < n; c++) row.push(qr.isDark(r, c))
    rows.push(row)
  }
  return rows
}
