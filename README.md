# لوحة | Lawha

Kanban boards that live on your team's devices. No server, no accounts, no
company in the middle. Your identity is an Ed25519 key created in your
browser; every change is signed; boards are end-to-end encrypted so only the
people you add can read them; members sync directly with each other over
WebRTC and carry each other's changes while someone is offline.

Open it: **<https://logicbloke.github.io/lawha/>** (install it from the
browser menu to use it as an app; it works offline).

Lawha is a sibling of [Shabaka](https://github.com/Logicbloke/shabaka) and
reuses its foundations: signed hash-chained logs, Trystero discovery, the
IndexedDB store, the key backup/passphrase/session code, and the PWA build.
A Shabaka key backup works here too and keeps the same identity.

<div dir="rtl">

**لوحة** لوحات كانبان تعيش على أجهزة فريقك: لا خادم ولا حسابات. هويتك مفتاح يُولَّد في متصفحك، وكل تعديل موقَّع، واللوحات مشفّرة من طرف إلى طرف فلا يقرؤها إلا من تضيفهم، ويتزامن الأعضاء مباشرة فيما بينهم. الواجهة متاحة بالعربية والإنجليزية والسويدية والإسبانية والفرنسية.

</div>

## What you can do

- Multiple boards, each with its own members; personal boards and **company
  workspaces**.
- Columns you add, rename, reorder, archive, with work-in-progress limits.
- Cards with descriptions, labels, assignees, due dates and comments.
- **Card fields**: admins define fields per board (text, number, link, date,
  choice list, checkbox, person); on a card you add only the ones you need,
  the same field as many times as you like.
- Drag cards between columns with mouse, touch (long-press) or keyboard
  (space, arrows, space). Select several (checkbox, ctrl/cmd or shift-click)
  and drag them together, or **move them to another board**.
- Per-board roles keyed on public keys: **owner, admin, editor, viewer**.
- UI in English, Svenska, Español, Français and العربية (right to left).

## Ways to run it

1. **Hosted:** <https://logicbloke.github.io/lawha/>, installable as a PWA.
2. **Single file:** download `lawha.html` from the
   [latest release](https://github.com/Logicbloke/lawha/releases/latest) and
   double-click it. The whole app is one file.
3. **Static folder:** unzip `lawha-static.zip` from the release and serve it
   with any static server (`python3 -m http.server 8080`).
4. **From source** (needs [Bun](https://bun.sh)):

   ```sh
   git clone git@github.com:Logicbloke/lawha.git
   cd lawha && bun install
   bun run dev        # http://localhost:5173
   ```

## How it works

**Identity.** An Ed25519 keypair generated in your browser; the public key is
you. Back it up as one line of text; optionally encrypt it at rest with a
passphrase (scrypt + XChaCha20-Poly1305).

**Logs.** Every change is an envelope in an append-only log, signed and
hash-chained to the previous one. There is one chain per *(board, person,
device)*, so using the same key on a phone and a laptop never forks anything.
Envelopes name the newest change their author had seen (`dep`), and every
peer derives the same Lamport clock from that, so nobody can win an edit by
lying about time.

**Board state.** The board is a deterministic fold over all members' logs:
each field is last-writer-wins by the derived clock, a card's column and
position are one register (a card is never in two columns), and order within
a column uses fractional index keys. Card field values are entries of their
own, so two people adding values to one card never overwrite each other; a
value that does not fit its field's type (a `javascript:` link, a removed
choice) shows as empty. Every peer holding the same envelopes
computes the same board, whatever order they arrived in.

**Permissions.** Owner > admin > editor > viewer. An actor may change a
member only if they outrank them and the new role is below their own, so
only the owner manages admins and nobody can remove the owner. Each change
records which permission changes its author had seen; role conflicts resolve
by (actor rank, most restrictive role, id), so a removal beats a concurrent
grant. A removal carries a cutoff — the last change the remover had seen from
each of the member's devices — and everything that member writes past it is
ignored by every peer. Backdating doesn't help: new changes are always past
the cutoff.

**Encryption.** Each board key "epoch" is a random key sealed to every
member's key (X25519 from their Ed25519 key, ephemeral per epoch,
XChaCha20-Poly1305), with a commitment so an admin cannot hand different
members different keys. A new epoch also carries the previous keys, so
members added later can read history. Removing someone creates a new epoch
they never receive. Card content is padded to fixed sizes; only members can
tell what a change was.

**Sync.** Each board has its own Trystero room on Nostr relays, MQTT brokers
and BitTorrent trackers, named by values derived from the board id. Peers
prove their key with a signature bound to both sides' nonces *and to the
DTLS fingerprints of that very WebRTC connection*, so a handshake cannot be
relayed. Logs are served only to current members; every member stores and
serves every member's log, which is how changes reach someone whose author
is offline. Peers who sign conflicting histories are caught with a fork proof
that is gossiped to everyone.

**Companies.** A company workspace is a roster with the same roles and
encryption as a board. Its current key derives the company's network secret,
which hides every company board's room: people who are not on the roster
cannot find or join those rooms, and peers also check the roster during the
handshake. Removing a coworker rotates the secret and removes them from the
company's boards you administer.

## Threat model

Lawha defends against:

- **Forgery and tampering** — every change is signed and chained; relays
  cannot alter anything undetected, and equivocation is proven and punished.
- **Reading by non-members** — board content is encrypted; peers do not even
  serve logs to non-members; company rooms are invisible without the roster
  key.
- **Removed members** — get no new keys, and their later changes are ignored
  by everyone.
- **Takedown** — there is no server; the app is a static file anyone can
  mirror.

Lawha does **not** defend against:

- **IP exposure.** WebRTC reveals your IP address to the peers you connect
  to. Use a VPN you trust if that matters.
- **What removed members already had.** Someone removed keeps everything
  they could read before the removal, and changes written under the old key
  by members who had not yet seen the removal.
- **Membership metadata.** Who is on a board, and when they are active, is
  visible to its members. Relay operators can see that someone joined a
  (hashed) room, and can link the rooms one client joins.
- **Concurrent moves to two boards.** Two people moving the same card to two
  *different* boards at the same moment both succeed: the card is duplicated,
  never lost.
- **Unseen devices.** If a member is removed, changes from a device of theirs
  the remover had never seen are dropped, even if they predate the removal.
- **Storage spam by members.** Any member can store changes that fail the
  rules; they are ignored but kept. Pruning is future work.
- **Endpoint compromise.** The key lives in the browser. Malware, a hostile
  extension or an XSS hole can take it. Mitigations: strict CSP, all user
  content rendered as text, passphrase encryption at rest.

## Architecture

```
src/core/       framework-agnostic protocol (no React)
  canonical.ts  canonical JSON for signing
  envelope.ts   sign / verify / hash envelopes (board, author, device chains)
  validate.ts   receive pipeline: schema → dedupe → signature → chain → fork proofs
  log.ts        atomic multi-envelope append
  acl.ts        order-free roles: causal ACL pasts, cutoffs, derived clocks
  boardcrypto.ts key epochs, grants, key commitments, padded op encryption
  board.ts      the deterministic board fold + op schema + positions
  actions.ts    builders for every write (incl. group and cross-board moves)
  sync.ts       per-board gossip with channel-bound auth and a serving gate
  net.ts        Trystero adapter: one room per board per strategy
  engine.ts     keeps boards folded, answers sync's questions, heals keys
  db.ts         IndexedDB schema
state/          zustand store, network room policy, user actions
ui/             React + dnd-kit; i18n.ts holds all five languages
tests/          vitest (Node + fake-indexeddb), incl. attack scenarios
e2e/            Playwright, multiple browsers over a local MQTT broker
```

## Testing

```sh
bun run test        # protocol, permissions attacks, crypto, fold, sync, i18n
bun run e2e         # multi-browser sync, permissions, companies, RTL, PWA offline
bun run build:single && bun scripts/check-singlefile.ts
```

The e2e suite runs offline against a local MQTT broker started by
`e2e/global-setup.ts`.
