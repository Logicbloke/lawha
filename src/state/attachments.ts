import { useEffect, useState } from 'react'
import { create } from 'zustand'
import { fromB64url } from '../core/b64'
import { openPiece } from '../core/blobcrypto'
import type { BlobStatus } from '../core/blobs'
import { MAX_DIM, MAX_THUMB, type Attachment } from '../core/board'
import type { Engine } from '../core/engine'
import { isInlineImage, isInlineVideo, isThumbType, safeFileName, sniff, type Sniffed } from '../core/sniff'
import { saveEagerLimit } from './filePrefs'
import { getEngine } from './store'

/**
 * Attachments in the browser: previews made at upload, files put back
 * together and decrypted to open or save, how big a file this device fetches
 * by itself per board (kept here, never sent), and housekeeping of the store.
 */

const MB = 1024 * 1024
const TICK_MS = 5_000
const GC_MS = 30 * 60_000
/** a file no board names is kept this long after its last use */
const GC_GRACE_MS = 60 * 60_000
const MAX_BUDGET = 2 * 1024 * MB

// ---- what this device keeps by itself (see filePrefs.ts) ----

export function setEagerLimit(board: string, bytes: number): void {
  saveEagerLimit(board, bytes)
  // a higher limit: fetch what now fits
  getEngine().refetch(board)
}

// ---- fetch progress, for the UI ----

export const useBlobStatus = create<Record<string, BlobStatus>>(() => ({}))

/** Whether the file is on this device, and how fetching it goes. */
export function useAttachmentState(at: Attachment): { here: boolean; status: BlobStatus | null } {
  const status = useBlobStatus((s) => s[at.root]) ?? null
  const [here, setHere] = useState(false)
  useEffect(() => {
    let live = true
    void getEngine()
      .blobs.complete(at.root)
      .then((c) => live && setHere(c))
      .catch(() => undefined)
    return () => {
      live = false
    }
  }, [at.root, status?.done])
  return { here: here || !!status?.done, status }
}

/** Files being sealed and stored on this device right now, per card. */
export const useUploads = create<Record<string, Array<{ id: number; name: string }>>>(() => ({}))
let uploadSeq = 0

export async function trackUpload<T>(card: string, name: string, fn: () => Promise<T>): Promise<T> {
  const id = ++uploadSeq
  useUploads.setState((s) => ({ [card]: [...(s[card] ?? []), { id, name }] }))
  try {
    return await fn()
  } finally {
    useUploads.setState((s) => ({ [card]: (s[card] ?? []).filter((u) => u.id !== id) }))
  }
}

// ---- previews ----

const THUMB_SIDES = [160, 128, 96, 64]
const THUMB_QUALITIES = [0.7, 0.5, 0.35]

function waitFor(el: HTMLElement, event: string, ms: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('timeout')), ms)
    el.addEventListener(
      event,
      () => {
        clearTimeout(timer)
        resolve()
      },
      { once: true },
    )
    el.addEventListener('error', () => reject(new Error('unreadable')), { once: true })
  })
}

async function picture(file: File, kind: Sniffed | null): Promise<{ src: CanvasImageSource; w: number; h: number; close(): void } | null> {
  if (isInlineImage(kind)) {
    // turned the way the photo's EXIF says, as browsers show it
    const bmp = await createImageBitmap(file)
    return { src: bmp, w: bmp.width, h: bmp.height, close: () => bmp.close() }
  }
  if (isInlineVideo(kind)) {
    const url = URL.createObjectURL(file)
    const video = document.createElement('video')
    const close = () => {
      video.removeAttribute('src')
      video.load()
      URL.revokeObjectURL(url)
    }
    try {
      video.muted = true
      video.playsInline = true
      video.preload = 'auto'
      video.src = url
      await waitFor(video, 'loadeddata', 5000)
      // a little in: the very first frame is often black
      video.currentTime = Math.min(1, (video.duration || 0) / 3)
      await waitFor(video, 'seeked', 5000)
      return { src: video, w: video.videoWidth, h: video.videoHeight, close }
    } catch {
      close()
      return null
    }
  }
  return null
}

function encode(canvas: HTMLCanvasElement, type: string, quality: number): Promise<Uint8Array | null> {
  return new Promise((resolve) =>
    canvas.toBlob(
      (blob) => {
        if (!blob) resolve(null)
        else void blob.arrayBuffer().then((b) => resolve(new Uint8Array(b)), () => resolve(null))
      },
      type,
      quality,
    ),
  )
}

const dim = (n: number) => (Number.isSafeInteger(n) && n >= 1 && n <= MAX_DIM ? n : null)

/** A preview small enough for the op (MAX_THUMB), and the picture's size, for images and videos. */
export async function makePreview(
  file: File,
  kind: Sniffed | null,
): Promise<{ thumb: Uint8Array | null; w: number | null; h: number | null }> {
  let pic: Awaited<ReturnType<typeof picture>> = null
  try {
    pic = await picture(file, kind)
  } catch {
    pic = null
  }
  if (!pic || !pic.w || !pic.h) return { thumb: null, w: null, h: null }
  const w = dim(pic.w)
  const h = dim(pic.h)
  try {
    const canvas = document.createElement('canvas')
    const ctx = canvas.getContext('2d')
    if (!ctx) return { thumb: null, w, h }
    for (const side of THUMB_SIDES) {
      const scale = Math.min(1, side / Math.max(pic.w, pic.h))
      canvas.width = Math.max(1, Math.round(pic.w * scale))
      canvas.height = Math.max(1, Math.round(pic.h * scale))
      ctx.drawImage(pic.src, 0, 0, canvas.width, canvas.height)
      // WebP where the browser makes it (Safari hands back PNG instead), else JPEG
      for (const type of ['image/webp', 'image/jpeg']) {
        for (const q of THUMB_QUALITIES) {
          const out = await encode(canvas, type, q)
          if (out && out.length <= MAX_THUMB && isThumbType(sniff(out))) return { thumb: out, w, h }
        }
      }
    }
    return { thumb: null, w, h }
  } catch {
    return { thumb: null, w, h }
  } finally {
    pic.close()
  }
}

/** A data: URL for an attachment's preview, typed by its bytes; null if it is not a picture we show. */
export function thumbUrl(thumb: string | null): string | null {
  if (!thumb) return null
  let bytes: Uint8Array
  try {
    bytes = fromB64url(thumb)
  } catch {
    return null
  }
  const kind = sniff(bytes)
  if (!isThumbType(kind)) return null
  const b64 = thumb.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (thumb.length % 4)) % 4)
  return `data:${kind};base64,${b64}`
}

// ---- opening and saving ----

export class FileError extends Error {}

/**
 * The whole file, fetched if need be and decrypted. Its type is what its
 * bytes say when that is a picture or video we show; anything else is
 * typed as a download, so nothing in it can run in the app's origin.
 */
export async function loadFile(board: string, at: Attachment): Promise<{ blob: Blob; kind: Sniffed | null }> {
  const engine = getEngine()
  await engine.swarm.want(board, at)
  const pieces = await engine.blobs.read(at.root)
  if (!pieces) throw new FileError('unavailable')
  const key = fromB64url(at.key)
  const parts: Uint8Array<ArrayBuffer>[] = []
  for (let i = 0; i < pieces.length; i++) {
    const plain = openPiece(key, i, at.n, pieces[i]!)
    if (!plain) throw new FileError('damaged')
    parts.push(new Uint8Array(plain))
  }
  const kind = sniff(parts[0]?.subarray(0, 64) ?? new Uint8Array(0))
  const shown = isInlineImage(kind) || isInlineVideo(kind)
  return { blob: new Blob(parts, { type: shown ? kind! : 'application/octet-stream' }), kind }
}

/** Save to the device. Never by navigating to the blob: URL (see sniff.ts). */
export function saveFile(blob: Blob, name: string): void {
  const url = URL.createObjectURL(new Blob([blob], { type: 'application/octet-stream' }))
  const a = document.createElement('a')
  a.href = url
  a.download = safeFileName(name)
  a.rel = 'noopener'
  a.style.display = 'none'
  document.body.appendChild(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 60_000)
}

// ---- housekeeping ----

async function collect(engine: Engine): Promise<void> {
  let budget = MAX_BUDGET
  try {
    const est = await navigator.storage?.estimate?.()
    if (est?.quota) budget = Math.min(budget, est.quota * 0.5)
  } catch {
    // keep the default
  }
  const live = engine.liveRoots()
  await engine.blobs.gc((root) => live.has(root) || engine.swarm.isWanted(root), budget, GC_GRACE_MS)
}

let started = false

export function startAttachments(engine: Engine): void {
  if (started) return
  started = true
  engine.swarm.events.on('status', (st) => useBlobStatus.setState({ [st.root]: st }))
  setInterval(() => engine.swarm.tick(), TICK_MS)
  const gc = () => void collect(engine).catch((e: unknown) => console.warn('lawha:', e))
  setTimeout(gc, 60_000)
  setInterval(gc, GC_MS)
}
