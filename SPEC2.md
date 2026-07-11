# SPEC2 — Phase 2: social card, Trench Chat (Nostr), collection PFPs

Extends SPEC.md (same hard constraints: zero-build, no runtime npm deps, no
CDN — the ONE exception is the committed vendored crypto bundle
`js/vendor/nostr-crypto.js`). Research results: `docs/research/pfp-assets.json`
and `docs/research/nostr.json` (READ the one for your module).

## File ownership (three parallel builders — do NOT touch files you don't own)

```
CARD builder:    og/card.html, og.png (repo root), og/meta-snippet.html,
                 og/generate.md (how to regenerate)
CHAT builder:    js/nostr.js, js/chat.js, index.html, css/style.css (append),
                 js/config.js (add CONFIG.chat), js/main.js (init line)
SPRITES builder: js/sprites.js, js/battle.js, js/hud.js
                 (assets/pfps/** already exists — read manifest.json, never edit)
INTEGRATOR:      splices og/meta-snippet.html into index.html <head>, adds the
                 PFP attribution + Nostr chat lines to the "How this works"
                 modal, runs tests + serve check.
```

## 1. Social card (CARD builder)

- `og/card.html`: self-contained 1200×630 page in the site's aesthetic
  (near-black #0b0e14, CRT scanlines, magenta/orange/gold). Content: big
  glowing title THE BATTLE FOR BLOCKSPACE; tagline "Watch the Filter Knights
  lose in real time — every unit is a real Bitcoin transaction"; a
  battlefield strip: castle + 3 knight sprites (CSS pixel-art or emoji) on
  the left, a charging horde on the right built from ACTUAL PFP images
  (relative paths ../assets/pfps/... work when screenshotting from the repo);
  bottom strip: "MANDATORY BIP-110 SIGNALING: BLOCK 961,632 · bitcoin-spam-war.vercel.app".
- Generate `og.png` (exactly 1200×630, < 600KB) with headless chrome:
  `google-chrome --headless=new --no-sandbox --window-size=1200,630
  --screenshot=og.png file://.../og/card.html` (use --force-device-scale-factor=1;
  verify dimensions with ImageMagick `identify`).
- `og/meta-snippet.html`: the exact tags for index.html <head>:
  og:title, og:description, og:type website, og:url
  https://bitcoin-spam-war.vercel.app/, og:image
  https://bitcoin-spam-war.vercel.app/og.png, og:image:width/height,
  twitter:card summary_large_image, twitter:title/description/image, plus
  a meta description. Do NOT edit index.html yourself.

## 2. Trench Chat on Nostr (CHAT builder)

Transport facts (verified in docs/research/nostr.json — use ITS relay list,
channel id, wire frames, and id-serialization rules, not your memory):
NIP-28 public channel; kind 42 messages tagged `["e", CHANNEL_ID, relay,
"root"]`; sign with schnorr via `js/vendor/nostr-crypto.js` (see bundle_api).

- `js/nostr.js` — pure vanilla, no DOM: `export class RelayPool`
  (connect to CONFIG.chat.relays; per-relay reconnect w/ exponential backoff
  + jitter; `subscribe(id, filters, onEvent, onEose)`; `publish(event)` →
  resolves {accepted: n, reasons[]} from OK frames; dedupe events by id
  across relays; drop events with created_at > now+10min or kind ≠ 42) and
  `export function buildSignedEvent({kind, tags, content, privkey})` using
  the EXACT NIP-01 serialization the research verified. Also
  `export function burnerIdentity(storage)` → {priv, pub, nick} persisted in
  localStorage (`tbfb-nostr-key`, `tbfb-nick`); default nick deterministic
  from pubkey: pick from war-themed names + 4 hex chars (e.g. "Wizard-3fa9",
  "Spammer-c0de", "Degen-8811").
- `js/chat.js` — `export function initChat({config})`: renders into
  `#trench-chat` (you add the markup): header "TRENCH CHAT ▸ on Nostr"
  with live "N in the trench" (unique pubkeys seen in last 10 min);
  message list (last 60, since 6h ago via REQ limit; newest at bottom,
  autoscroll unless user scrolled up); each row: nick (colored by pubkey
  hash), message text — SECURITY: textContent ONLY, never innerHTML, no
  linkification; input maxlength 240 + send button + Enter; client rate
  limit 1 msg / 3s with a cheeky cooldown message; nick editable (small ✎,
  persisted); footer microcopy: "Ephemeral-ish. Public. On Nostr, because
  BIP-110 told us to move our data there." plus the channel id truncated
  (title attr = full id) so Nostr users can join from their own client.
- index.html: add the chat panel in the right rail BELOW the kill feed
  (desktop), sharing the rail height (kill feed flex-shrinks; chat ~40%);
  under 900px the chat becomes a bottom sheet toggled by a floating "💬"
  button. Style to match (style.css append; reuse tile/rail patterns).
- js/config.js: `CONFIG.chat = { enabled: true, relays: [...verified...],
  channelId: '...', maxLen: 240, cooldownMs: 3000, historyHours: 6 }`.
- js/main.js: `initChat({config: CONFIG})` guarded in try/catch so chat
  failure never touches the battle.
- Graceful degradation: 0 relays connected → panel shows "trench comms
  jammed — reconnecting…" and keeps retrying; battle unaffected.

## 3. Collection PFPs (SPRITES builder)

Read `assets/pfps/manifest.json` (shape:
`{"collections":{"<slug>":{"name","files":["slug/01.png"...],"source","protocols":[...]}}}`).

- js/sprites.js: `drawViolator` gains `opts.image` (HTMLImageElement) +
  `opts.pixel` (bool): when image present & complete, draw it INSIDE the
  existing JPEG frame (cover-fit, clipped to the frame's inner rect,
  `ctx.imageSmoothingEnabled = !pixel` around the drawImage, restore after);
  emoji remains the fallback while loading / on error.
- js/battle.js: at construction, load manifest via fetch
  (`assets/pfps/manifest.json`) + preload Images lazily (create Image objs,
  don't block; track loaded flags). Face assignment at spawn (deterministic
  from txid hash, same trick as classify.js pickFrom):
  protocol 'inscription' & 'brc20' → any file from nodemonkes/puppets/
  quantumcats/wizards/frogs/omb pools; 'runes' violator → runestone;
  'stamps'/'src20' → stamps; 'counterparty' → rarepepe; everything else
  keeps emoji. Store {image, pixel, collectionName, fileRel} on the unit;
  breach/storm/scorch behavior unchanged. If manifest fetch fails → emoji
  everywhere (zero errors).
- Unit dossier + kill feed get the art too: expose the unit's collection
  info in the onUnitClick payload (`verdict._pfp = {collection, file}` or a
  parallel field — pick one, document it), and js/hud.js renders a 40px
  thumbnail (img element, local asset path) in the dossier header + a 20px
  thumbnail in kill-feed rows for violators that have one, with a
  "(cosmetic — sample piece from <collection>)" note in the dossier.
- Keep 60fps: images are 64×64, drawImage per unit is cheap; no per-frame
  allocations; cap unchanged.

## Copy (INTEGRATOR splices into modal)

- Attribution: use attribution_lines from docs/research/pfp-assets.json,
  prefixed "Unit faces are sample pieces from iconic collections (cosmetic
  only, not the actual inscription in the transaction):".
- Chat: "Trench Chat runs on Nostr (NIP-28) over public relays — no server,
  no accounts, burner keys minted in your browser. BIP-110 literally advises
  storing data on Nostr instead. We complied."

## Verification

- `node --test test/` stays 45/45 (nothing here touches classifier/feed core).
- node --check every touched js file.
- Browser QA (coordinator does this): chat sends/receives against real
  relays from two parallel headless sessions; PFPs visible on violators;
  og.png correct size; meta tags present; killfeed thumbnails; mobile sheet.
