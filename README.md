# Stop Motion

A plain stop-motion camera in one static page. It's built for Chrome on Android (Pixel), with an optional laptop remote.

Live at **https://demborg.se/stopmotion/**

- **Phone only:** live view, onion skin, a guide-image overlay and playback. The *Camera* panel sets focus distance, shutter, ISO and white balance by hand (each group can be Auto). Settings are saved on the phone, so a reload or a later session uses exactly the same values, and the laptop can adjust them remotely. Shots are full-resolution stills from the Image Capture API, kept in IndexedDB across reloads. Export them as a zip of `0001.jpg…`.
- **Phone + laptop:** open the page on the laptop and scan its QR with the phone (*Pair* in the menu, or the system camera app). The laptop gets the live preview with the onion skin, and can capture, undo and adjust the camera controls. With *Save to folder* it writes `0001.jpg…` straight to disk as frames arrive, and removes leftover numbered files from earlier shoots.

Keys on the remote: Space capture, Backspace undo, P play, O onion, C camera controls, S square crop guide. Press and hold the image to hide the overlay.

## How pairing works
- **The QR:** it encodes `#pair=<broker>.<room>.<key>`, a random room id plus a 128-bit AES-GCM key.
- **The handshake:** phone and laptop exchange the WebRTC offer and answer through a public MQTT broker (EMQX, with HiveMQ as fallback). Each message is encrypted with that key, with the topic bound in as associated data. The broker sees only the room id and ciphertext.
- **Replay protection:** messages carry a send time, and anything older than 60 s is dropped. While a connection is up, the laptop ignores new offers.
- **After the handshake:** the preview video, commands and frames go peer-to-peer over the LAN. `iceServers` is empty (no STUN or TURN), so traffic is never relayed through a server. The handshake needs internet; the session doesn't.
- **What breaks it:** networks with client isolation (guest Wi-Fi), or a phone on mobile data, can't connect.

## Device notes
- **No auto-lock:** Chrome on the Pixel applies stale stored values when switching focus, exposure or white balance to manual, and never reports the live auto values, so "lock what auto chose" can't be done reliably. Manual controls are deterministic instead.
- **Photo orientation:** some devices return Image Capture stills in sensor orientation. Stills whose orientation doesn't match the preview are rotated before saving.
- **Full-res photos refocus:** on the Pixel, `takePhoto()` runs its own autofocus and ignores the preview's manual focus. In a real shoot it alternated between two focus distances on every capture. Capture therefore grabs preview frames (1440×1920) by default, which keep exactly the manual settings; full-res is still an option.
- **Full-res options rejected:** if `takePhoto` refuses the full-resolution options, the app retries without them and then falls back to a preview frame. *Capture → Preview frame* forces this; it's faster, and 1440×1920 is plenty for 1080p video.
- **Uncompressed zip:** frames are already JPEGs, so compressing them again gains nothing.

## Development
There's no build step: plain ES modules, served as-is by GitHub Pages. `vendor/` holds the browser builds of mqtt.js and qrcode-generator, pinned in `package.json`. To update them, run `npm install && npm run vendor`. To serve locally, run `npm run serve`; the camera needs HTTPS or `localhost`.
