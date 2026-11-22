# Stop Motion

A plain stop-motion camera in one static page. It's built for Chrome on Android (Pixel), with an optional laptop remote.

- **Phone only:** live view, onion skin, a guide-image overlay and playback. The AE/AF button locks exposure, focus and white balance. Shots are full-resolution stills from the Image Capture API, kept in IndexedDB across reloads. Export them as a zip of `0001.jpg…`.
- **Phone + laptop:** open the page on the laptop and scan its QR with the phone (*Pair* in the menu, or the system camera app). The laptop gets the live preview with the onion skin, and can capture, undo and lock. With *Save to folder* it writes `0001.jpg…` straight to disk as frames arrive.

## How the link works
The QR holds a room id and a random AES key. The WebRTC offer and answer travel through a public MQTT broker (EMQX, with HiveMQ as fallback), encrypted with that key. After that, video, commands and frames go peer-to-peer over the LAN. No STUN or TURN servers are configured, so nothing is ever relayed. The handshake needs internet; the session itself doesn't.

## Run
Any static host works, but camera access needs HTTPS (or `localhost`). There's no build step. Libraries are vendored in `vendor/`: mqtt.js 5.10.4 and qrcode-generator 1.4.4.

Keys on the remote: Space capture, Backspace undo, P play, O onion, L lock. Press and hold the image to hide the overlay.
