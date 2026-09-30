# walkpad-web

Vite + TypeScript front end (CesiumJS to come). Deployed to `walk.connectedovals.com`.

Status: scaffold only, no features yet.

## Develop

```sh
cd web
npm install
npm run dev        # dev server
npm run typecheck  # tsc, no emit
npm run build      # type-check + production build into dist/
```

## Config

All config in `web/.env` (git-ignored); see `.env.example`. Default world mode is `flat` so dev
reloads never hit Google 3D Tiles.
