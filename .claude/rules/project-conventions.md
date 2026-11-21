# Project Conventions

## Tech Stack

### Backend
- Node.js 18+ (CommonJS — `require`/`module.exports`)
- Express 4.21
- PM2 6.x (cluster mode)
- Data: `data/data.json` (file mode) or Redis (ioredis 5.6)
- Libs: axios, body-parser, cors, dotenv, multer, tiktoken, ali-oss, jwt-decode

### Frontend (our work area)
- Vue 3.4 (Composition API, `<script setup>`)
- Vite 5.2 (dev port 6868, proxy to backend :4000)
- Tailwind CSS 3.4
- vue-router 4.5 (history mode, lazy imports)
- axios 1.8

### Deploy
- Docker: `node:lts-alpine`, PM2 start, port 3000
- Build: `cd public && npm install && npm run build` → `public/dist/`
- Docker Compose: `docker/docker-compose.yml`

## Architecture

- Style: monolith — Express backend serves Vue SPA from `public/dist/`
- Request flow: Express routes (`src/routes/`) → controllers (`src/controllers/`) → utils
- Frontend: SPA with 3 views, route guard checks auth via `/verify` endpoint
- Auth: API key in `localStorage`, sent as `Authorization` header
- Error handling: global Express error middleware, frontend uses `alert()` / toast
- No state management (Vuex/Pinia) — local `ref()` state per component
- No i18n — all UI strings are hardcoded Chinese

## Structure

```
src/                          # Backend (Express)
  config/index.js             # Env config parsing
  controllers/                # Route handlers (chat, models, CLI)
  middlewares/                 # Auth, chat middleware
  models/                     # Model name mappings
  routes/                     # Express route definitions
  utils/                      # Helpers (account, redis, logger, etc.)
  server.js                   # App entry, routes, static serving
  start.js                    # PM2 launcher
public/                       # Frontend (Vue 3 SPA) — OUR WORK AREA
  src/
    App.vue                   # Root: video background + router-view
    main.js                   # Vue app bootstrap
    style.css                 # Tailwind directives only
    routes/index.js           # 3 routes + auth guard
    views/
      auth.vue                # Login (~65 lines)
      dashboard.vue           # Account management (~800 lines, largest file)
      settings.vue            # System settings (~320 lines)
  vite.config.js              # Dev proxy config
  tailwind.config.js          # Default Tailwind config
docker/                       # Dockerfile + compose files
ecosystem.config.js           # PM2 cluster config
data/                         # Runtime data (gitignored)
```

## Naming

- Files: `kebab-case.js`, `kebab-case.vue`
- Vue components: single-word filenames (`auth.vue`, `dashboard.vue`, `settings.vue`)
- JS variables/functions: `camelCase`
- CSS classes: Tailwind utility-first, custom classes in `<style scoped>`
- API endpoints: `/api/camelCase` (e.g., `/api/setApiKey`, `/api/setOutThink`)
- No TypeScript anywhere

## Frontend Patterns

- All components use `<script setup>` with `ref()`, `onMounted()`, `computed()`
- API calls via `axios` directly in components (no service layer)
- Auth header pattern: `{ headers: { 'Authorization': localStorage.getItem('apiKey') || '' } }`
- User feedback: `alert()` in settings.vue, toast notifications in dashboard.vue
- Styling: Tailwind utilities inline + glassmorphism (backdrop-blur, bg-white/30, rounded-2xl)
- Transitions: Vue `<transition>` with CSS classes
- No component library — all UI hand-crafted with Tailwind

## Testing

- No tests exist in the project
- No test framework configured

## Do NOT Use

- TypeScript — project is pure JS
- Pinia/Vuex — state is local per component
- Component libraries (Element Plus, Vuetify, etc.) — UI is hand-crafted Tailwind
- i18n libraries — strings are hardcoded (our goal is to translate them to Russian)
- Large or cosmetic rewrites of `src/` — keep backend edits minimal and close to upstream to limit merge conflicts
- Semicolons inconsistently used — follow existing file's style
