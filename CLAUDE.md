# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

Lawha (لوحة) is a serverless, end-to-end encrypted Kanban PWA, a sibling of
[Shabaka](https://github.com/Logicbloke/shabaka). Identity is an Ed25519 key;
every change is a signed, hash-chained envelope in a per-(board, author,
device) log; board state is a deterministic fold over all logs; permissions
are an order-free multi-admin ACL; content is encrypted under board key
epochs; peers sync per board over Trystero/WebRTC. Hosted on GitHub Pages at
https://logicbloke.github.io/lawha/.

## Commands

Uses **Bun**:

```sh
bun install
bun run dev                     # Vite on :5173
bun run build                   # tsc --noEmit + vite build → dist/ (BASE_PATH=/lawha/ in CI)
bun run build:single            # dist-single/lawha.html (runs from file://)
bun run test                    # vitest
bun run test tests/acl.test.ts  # one file
bun run e2e                     # Playwright under Bun (local MQTT broker on :9001)
bun run e2e e2e/sync.spec.ts    # one spec
bun scripts/check-singlefile.ts # after build:single
bun scripts/walkthrough.ts <dir> # screenshots of the main screens (needs `bun run dev`)
bun scripts/gen-icons.ts        # regenerate public/icons/
```

`tsc --noEmit` (strict, noUnusedLocals/Parameters) is the type gate; there is no lint script.

## Architecture

Strict layering: `src/core/` has **no React imports**; `src/state/` bridges core and UI; `src/ui/` is React.

- `envelope.ts` / `validate.ts` — wire format and the receive pipeline (schema → dedupe → signature → chain position; pending buffer; fork proofs). Permissions are *not* checked at ingest.
- `acl.ts` — `resolve()`: Kahn order over (chain prev, dep, ACL refs), derived Lamport clocks, causal ACL pasts as bitsets, ACL validity, role events, `canWrite()` for content ops.
- `boardcrypto.ts` — epochs (wraps + carried prev keys + key commitment), grants, padded op sealing with AAD bound to (board, author, dev, seq, epoch).
- `board.ts` — `computeBoard()`: keys → epochs → decrypt → authorize → LWW fold. Op schema lives here.
- `actions.ts` — builders returning `AppendItem`s; `log.appendBatch` signs them in one IndexedDB transaction.
- `sync.ts` — per-board SyncManager: auth (nonces + DTLS fingerprints), serving gate, have/want/msgs, fork gossip, orphans, per-board batch queue. One authenticated connection per remote install is its *carrier*: it `offer`s every board whose ACL names that key, and each accepted board runs a full session (own handshake, own gate) inside `mux` messages.
- `net.ts` — Trystero rooms per board per strategy; `engine.ts` — folds boards, implements SyncHost, room derivation (company boards via the workspace network secret), key healing.
- `state/network.ts` — which rooms to join (open board, every workspace, recent writes, a rendezvous-hashed shared personal board per 90 s slot; capped), and the sidebar's network status.

## Invariants to respect

- `canonical.ts` and the envelope shape are the signing format; changing them breaks every signature. App id is `lawha-v1` (net.ts). Op kinds and fields are protocol too (`opSchemaError`).
- Derived state must be a pure function of the stored envelope set (plus identity for decryption). Never make validity depend on arrival order, wall-clock time or local state, nor on browser APIs whose behaviour differs between engines (`new URL()` does: hence the `isHttpUrl` pattern in board.ts).
- Card fields: `field.set` is admin-only and rewritten whole (state edits go through `editField`'s queue); its type is fixed by the first write. `entry.set` values are checked against the field type in the fold, never trusted from the op.
- ACL rules (acl.ts header comment) are security-critical: rank rule, `roleAt` frontier/tie-break, `upTo` cutoffs, owner events always valid. Any change needs attack-scenario tests in `tests/acl.test.ts`.
- One writer per install (Web Locks in `state/store.ts`); `dev` ids are never exported.
- Batches for a board are processed sequentially in sync (`handleMsgs` queue); receive must treat a concurrently stored identical envelope as a duplicate, never a fork.
- All user content is rendered as text (XSS steals keys). Strict CSP is injected into production builds.
- UI must work LTR and RTL; strings live in `src/ui/i18n.ts` and every language must cover every key (`tests/i18n.test.ts`). The board scroller stays `dir="ltr"` with `row-reverse` for Arabic (dnd-kit auto-scroll).
- New files in `public/` must be added to `PUBLIC_PRECACHE` in vite.config.ts (service worker precache).
- Never re-join a Trystero room id right after leaving it: `joinRoom` hands back the room that is still leaving and it dies ~100 ms later. `NetworkManager` waits on the leave (`leaving`); keep all joins going through it. Trystero's `onJoinError` reports per-peer trouble, not a failed join.
