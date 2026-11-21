# Qwen2API с signin-worker sidecar (v2 session pipeline)

`docker/docker-compose.signin.yml` — самостоятельная альтернатива
`docker/docker-compose.dev.yml` (как и DNS-вариант): Qwen2API плюс sidecar
`signin-worker`, который получает и тихо продлевает сессии chat.qwen.ai в
настоящем Chromium (Playwright). Обоснование и живые доказательства —
`docs/et0-live-integration-2026-11-21.md` и `docs/hybrid-v2-pipeline-design.md`
(epic Qwen2API-jik, задача jik.3).

## Зачем

Вход по паролю в v2 из чистого Node заблокирован WAF (интерактивный слайдер
Aliyun/Baxia, HTML вместо JSON). В реальном браузерном контексте капча
проходит сама. Поэтому вход выделен в sidecar-сервис, а сам чат-конвейер
остаётся на HTTP: сессия (JWT ~30 мин + cookies) передаётся в cookie-jar
адаптера (`src/utils/v2-session-store.js`).

## API sidecar (только внутренняя сеть)

- `POST /session {email, password, proxy?}` → `{token, expiresAt, cookies[], …}` —
  полный вход через форму `chat.qwen.ai/auth` (пароль в открытом виде: форму
  хеширует сам FE).
- `POST /renew {email, proxy?}` → та же форма ответа — тихое продление:
  перезагрузка chat.qwen.ai в персистентном профиле (пароль не нужен).
  Пока токен из кэша свеж, ответ отдаётся из кэша без запуска браузера.
- `GET /health` → `{ok, sessions}`.

Один Chromium-профиль (`userDataDir`) на аккаунт — каталог `account-<sha256(email)>`
в `/app/profiles` (volume): cookies auth.qwen.ai переживают рестарты, продление —
молчаливый reload. Воркер сам держит сессии тёплыми: таймер продлевает токен на
отметке ~60% остаточного TTL. Пароли нигде не хранятся и не логируются; email
не попадает ни в логи, ни в имена файлов; логи содержат только коды исходов.

Проверено живьём 2026-11-21 (headless, капча Aliyun проходит сама): вход даёт
короткий токен (~15–30 мин), но первый же reload в залогиненном профиле
ротирует его на ~30-дневный (HttpOnly `refresh_token`) — воркер выходит на
длинные токены автоматически первым же тихим продлением.

## Конфигурация приложения

| Переменная | Назначение |
| --- | --- |
| `V2_SESSION_MODE` | `off` (по умолчанию, нынешний v1-путь) \| `lab` (.test-стенд, см. `tests/v2-lab-sessions.test.js`) \| `browser` (сессии из sidecar). Заданный `QWEN_LAB_V2_AUTH_ORIGIN` без явного режима по-прежнему включает `lab` |
| `SIGNIN_WORKER_URL` | URL воркера, по умолчанию `http://signin-worker:3100` |
| `SIGNIN_WORKER_TOKEN` | Общий bearer-секрет приложение → воркер; пусто = без авторизации (только внутренняя сеть) |
| `AUTO_REFRESH_INTERVAL_SECONDS` | Каденс авто-refresh токенов; в `browser`-режиме по умолчанию 15 мин вместо 6 ч (токен живёт ~30 мин) |

В `browser`-режиме `TokenManager.login` делает `POST /session`, а refresh —
`POST /renew` c откатом на полный вход, когда профиль умер (`no_profile` /
`session_expired`). Cookies сессии едут в запросах `chats/new` и completions
через тот же jar-механизм, что доказан в lab (`v2-session-store.prepareChat`);
аккаунтный прокси при этом сохраняется.

Откат: `V2_SESSION_MODE=off` возвращает v1-путь одной переменной; sidecar
останавливается независимо.

## Сборка и запуск

Воркер собирается из `signin-worker/` (node:20-slim + Playwright 1.65.1 +
Chromium; сам пакет playwright требует Node ≥ 20). Порты наружу не
публикуются: API переносит пароли и bearer-токены. healthcheck — `GET /health`.

```sh
docker compose --project-directory . --env-file /secure/signin.env -p qwen-signin-test \
  -f docker/docker-compose.signin.yml config --quiet
docker compose --project-directory . --env-file /secure/signin.env -p qwen-signin-test \
  -f docker/docker-compose.signin.yml up -d --build --wait
```

Пример env — `docker/signin.env.example` (копировать в приватный файл вне Git).
Volume `signin_profiles` хранит браузерные профили: в них лежат живые сессии
(эквивалент bearer-токенов) — защищайте его как данные аккаунтов. Для bind-mount
каталог на хосте должен быть доступен на запись UID 10001 (пользователь `app`
в образе). Coolify: существующий ресурс, Base Directory `/`, Compose Location
`/docker/docker-compose.signin.yml` (как в DNS-варианте, см. `docs/dns-sidecar.md`);
профили можно оставить named volume. Для прода вместе с DNS-sidecar используйте
`/docker/docker-compose.prod.yml` (см. `docs/prod-hybrid-deploy.md`).

Пер-аккаунтные прокси: приложение передаёт `account.proxy` (или глобальный
`PROXY_URL`) в каждом запросе к воркеру; браузерный контекст запускается через
него (http/https/socks5).

## Локальный harvest без Docker

Инструмент `tools/v2-session-harvest.js` проводит тот же вход и кладёт сессию
в `.tmp/session-<email>.json` (gitignored) — это разблокирует ручные пробы
jik.2 с живым токеном. Профиль переиспользуется: повторный запуск (`renew`)
проверяет тихое продление.

```sh
bun install && bunx playwright install chromium   # один раз
QWEN_TEST_EMAIL=… QWEN_TEST_PASSWORD=… node tools/v2-session-harvest.js
QWEN_TEST_EMAIL=… QWEN_TEST_PASSWORD=… node tools/v2-session-harvest.js renew
```

Креденшелы передаются только через env; stdout содержит имена cookies и срок
токена, но не значения. `HARVEST_HEADFUL=1` — запуск с видимым окном (если
headless начнёт помечаться WAF; в контейнере это потребует xvfb).

## Тесты

- `tests/v2-session-store.test.js` — режимы `off/lab/browser`, скоупинг cookies
  по домену/пути, merge поверх app-cookies.
- `tests/signin-worker-client.test.js` — HTTP-контракт клиента с моком воркера
  (shape запросов, bearer, маппинг кодов ошибок).
- `tests/signin-worker-service.test.js` — сам воркер с фейковым браузерным
  модулем: кэш, тихое продление, сериализация запусков на профиль, коды ошибок.

Chromium в CI не нужен: зависимость playwright в sidecar ленивая, тесты
инжектируют фейковый signer.
