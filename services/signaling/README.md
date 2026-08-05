# Cloudflare signaling service

The Worker serves the controller UI and uses one Durable Object per one-time code. It relays only SDP/ICE setup messages; controller input travels directly over an unordered, zero-retransmit WebRTC DataChannel.

```sh
npm ci --prefix ../..
npx wrangler login
npm run deploy --workspace @switch2-remote/signaling
```

Optional TURN fallback (recommended for public use): create a Cloudflare Realtime TURN key, then store both values as Worker secrets.

```sh
npx wrangler secret put TURN_KEY_ID --cwd services/signaling
npx wrangler secret put TURN_KEY_API_TOKEN --cwd services/signaling
npm run deploy --workspace @switch2-remote/signaling
```

Without these secrets, the app uses Cloudflare STUN and works only where a direct P2P route can be established. TURN credentials are generated for one hour and cached only inside an active room.

The host enters the deployed Worker URL in its local UI and presses **ワンタイムパス発行**. The first guest to use the resulting URL exclusively owns control. Revoking requires a new code before another guest can connect.
