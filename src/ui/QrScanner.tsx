import { useEffect, useRef, useState } from 'react'
import { useT } from './i18n'

/**
 * Whether an in-app QR scanner can run here. Camera access needs a secure
 * context — true for the hosted HTTPS PWA and localhost, but false for the
 * single-file build opened from file://, where callers hide the scan entry
 * point and fall back to pasting.
 */
export function qrScanSupported(): boolean {
  return (
    typeof navigator !== 'undefined' &&
    !!navigator.mediaDevices?.getUserMedia &&
    typeof window !== 'undefined' &&
    window.isSecureContext
  )
}

/**
 * Full-screen camera modal that decodes a QR code and reports its text once.
 * jsQR is loaded lazily so it never weighs on the initial bundle. The stream
 * is always torn down on unmount so the camera indicator does not linger.
 */
export function QrScanner({
  onResult,
  onClose,
}: {
  onResult: (text: string) => void
  onClose: () => void
}) {
  const t = useT()
  const videoRef = useRef<HTMLVideoElement>(null)
  const [error, setError] = useState(false)

  useEffect(() => {
    let stream: MediaStream | null = null
    let raf = 0
    let stopped = false
    let decode: typeof import('jsqr').default | null = null
    const canvas = document.createElement('canvas')
    const ctx = canvas.getContext('2d', { willReadFrequently: true })

    const stop = () => {
      stopped = true
      cancelAnimationFrame(raf)
      stream?.getTracks().forEach((tr) => tr.stop())
    }

    const tick = () => {
      if (stopped) return
      const video = videoRef.current
      if (video && decode && ctx && video.readyState >= video.HAVE_ENOUGH_DATA) {
        const w = video.videoWidth
        const h = video.videoHeight
        if (w && h) {
          canvas.width = w
          canvas.height = h
          ctx.drawImage(video, 0, 0, w, h)
          const found = decode(ctx.getImageData(0, 0, w, h).data, w, h, {
            inversionAttempts: 'dontInvert',
          })
          const text = found?.data.trim()
          if (text) {
            stop()
            onResult(text)
            return
          }
        }
      }
      raf = requestAnimationFrame(tick)
    }

    void (async () => {
      try {
        decode = (await import('jsqr')).default
        stream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: 'environment' },
        })
        if (stopped) {
          stream.getTracks().forEach((tr) => tr.stop())
          return
        }
        const video = videoRef.current!
        video.srcObject = stream
        await video.play()
        raf = requestAnimationFrame(tick)
      } catch {
        if (!stopped) setError(true)
      }
    })()

    return stop
    // Mounted fresh each open; the initial callbacks are the right ones.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  return (
    <div className="qr-scanner-overlay" role="dialog" aria-modal="true" onClick={onClose}>
      <div className="qr-scanner" onClick={(e) => e.stopPropagation()}>
        {error ? (
          <p className="error">{t('qrScanError')}</p>
        ) : (
          <>
            <video ref={videoRef} playsInline muted />
            <p className="hint">{t('qrScanHint')}</p>
          </>
        )}
        <button onClick={onClose}>{t('qrClose')}</button>
      </div>
    </div>
  )
}
