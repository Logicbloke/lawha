import { Aedes } from 'aedes'
import { Duplex } from 'node:stream'

// Playwright runs under Bun here; Bun's `ws` shim lacks stream support, so
// bridge Bun's native WebSocket server to aedes with a manual Duplex.
declare const Bun: {
  serve(opts: unknown): { stop(force?: boolean): void }
}

interface WsLike {
  send(data: Uint8Array | Buffer): void
  close(): void
}

/** Local MQTT-over-WebSocket broker so e2e runs offline and deterministic. */
export default async function globalSetup(): Promise<() => Promise<void>> {
  const broker = await Aedes.createBroker()
  const streams = new Map<unknown, Duplex>()

  const server = Bun.serve({
    port: 9001,
    fetch(req: Request, srv: { upgrade(req: Request, opts?: unknown): boolean }) {
      const proto = req.headers.get('sec-websocket-protocol')?.split(',')[0]?.trim()
      const ok = srv.upgrade(
        req,
        proto ? { headers: { 'Sec-WebSocket-Protocol': proto } } : undefined,
      )
      if (ok) return undefined
      return new Response('lawha test broker')
    },
    websocket: {
      open(ws: WsLike) {
        const stream = new Duplex({
          read() {},
          write(chunk: Buffer, _enc: string, cb: () => void) {
            ws.send(chunk)
            cb()
          },
        })
        stream.on('close', () => ws.close())
        streams.set(ws, stream)
        broker.handle(stream as never)
      },
      message(ws: WsLike, msg: Buffer | string) {
        streams.get(ws)?.push(typeof msg === 'string' ? Buffer.from(msg) : msg)
      },
      close(ws: WsLike) {
        const stream = streams.get(ws)
        streams.delete(ws)
        stream?.push(null)
        stream?.destroy()
      },
    },
  })

  return async () => {
    server.stop(true)
    await new Promise<void>((resolve) => broker.close(resolve))
  }
}
