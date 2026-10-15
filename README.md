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
- **Categories** in the sidebar: drag a board onto one, fold them away,
  drag their headers into the order you like. A company's categories are
  shared with every coworker (only workspace admins change them); folding
  and ordering are your own, on each device. Personal boards are grouped per
  device.
- Columns you add, rename, reorder, archive, with work-in-progress limits.
- Cards with descriptions, labels, assignees, due dates and comments.
- **Attachments**: files up to 25 MB on a card (pick, drop or paste), with
  previews for pictures and videos. They are end-to-end encrypted and
  travel between members directly; no server ever holds them.
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
passphrase (scrypt + XChaCha20-Poly1305). Key & security (and the unlock
screen, for a forgotten passphrase) can delete everything Lawha keeps in
this browser; your other devices and the people you share boards with keep
their copies.

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

**Attachments.** A file is cut into 256 KiB pieces, each sealed under a
random key of its own (XChaCha20-Poly1305). That key and the hash of every
sealed piece go in the card's change, which is encrypted under the board key
like any other, so only members can open the file, and the hashes pin its
exact bytes. The pieces themselves never enter the log: each device keeps the
ones it has in its own store and serves them to the board's other members
over the same authenticated connections, checking every piece against its
hash. Files up to a size you choose per board (10 MB unless you change it)
are fetched as soon as they appear, so a file stays available while anyone
who has it is online, not only whoever added it; bigger ones are fetched
when opened. Only pictures and videos are shown in the app, typed by their
actual bytes; every other file (SVG and HTML included) is only downloaded.

Rooms are joined lazily: the open board, every company you are on, boards
you wrote to recently, and one personal board you share with others, picked
by rendezvous hashing so people who share boards land in the same room at
the same time. Once two installs are connected in any room, that connection
also carries every other board the two share (each with its own handshake
and membership gate), so coworkers stay in sync on boards neither has open.
Your own devices also meet in a private room that only holders of your key
can find, so a phone that has just restored the key finds your laptop with
no board in common. The laptop asks you first, showing the phone's code
(the phone shows it too, on its home screen and under Key & security), and
once you allow it, the phone takes up every board you are on. Their files
are fetched only when opened there, until you choose otherwise per board.
The peer count in the sidebar counts people's devices, not connections; open
it to see which discovery relays are reachable and whether direct connections
are failing. Networks that block device-to-device connections (some office
Wi-Fi, VPNs) need a TURN server, which you can set under Key & security.

**Companies.** A company workspace is a roster with the same roles and
encryption as a board. Its current key derives the company's network secret,
which hides every company board's room: people who are not on the roster
cannot find or join those rooms, and peers also check the roster during the
handshake. Removing a coworker rotates the secret and removes them from the
company's boards you administer. Board categories are ops in the workspace
log too, so every coworker folds the same grouping.

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
  to, and to the TURN server if you set one (it relays only encrypted
  traffic). Use a VPN you trust if that matters.
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
- **Attachment availability.** A file nobody else has fetched yet cannot be
  had while whoever added it is offline. Fetching small files right away
  narrows that to "until one other member is online"; a device left running
  helps. Files are only exchanged with members you are connected to, so they
  reach about as far as the board's changes do.
- **What a file says about you.** A photo's EXIF data (camera, sometimes GPS
  position) stays in it. Removed members keep the files they had fetched.
- **A leaked key.** Whoever has your key is you on every board you are on.
  Your devices ask before sharing your boards with a device they have not
  seen, so the key alone does not list them, but someone who also knows a
  board's id, or one of your devices' ids, gets that board's contents.
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
  blobcrypto.ts attachments: per-file keys, sealed pieces, piece hashes
  blobs.ts      attachment pieces: the local store and the fetcher
  sniff.ts      what a file really is (only pictures and videos are shown)
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
