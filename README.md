# AEGIS DRIFT — JEV Tactical Arena

A compact 3D browser combat game built as a **RootAgent Genesis Slice**.

## Play

- **WASD** move
- **Space / left click** primary fire
- **Shift** dash
- **R** redeploy after defeat

Enemy drones use a bounded tactical decision set: `CHASE / STRAFE / RETREAT / ATTACK / GUARD`.
When JEV is available, decisions are requested from TypeSafe `jev-latest` and the selected tactic directly changes enemy movement / attacks. If JEV cannot be reached, the simulation falls back immediately to a local tactical policy so the render loop never blocks.

## JEV credentials

No real API key is committed.

- Local: `TYPESAFE_API_KEY=... npm start` uses `server.mjs` as a server-side proxy.
- GitHub Pages: click **CONNECT JEV** and paste a key for the current page session. It remains only in JavaScript memory and is cleared on refresh/close. If the provider blocks browser CORS, the game continues in local fallback mode.

## RootAgent

The repository vendors the exact RootAgent engine revision used by CI under `.rootagent-engine/`. The GitHub Actions workflow runs the real RootAgent lifecycle on the committed Genesis Slice:

`init → add → start → validate → checker attest → pass → audit seal`

The resulting task state, rounds, Receipt and Audit Seal are committed under `.rootagent/` after successful verification.
