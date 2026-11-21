# Прод-деплой гибридного конвейера v2 (jik.5)

`docker/docker-compose.prod.yml` — рабочий прод-стек: Qwen2API (debian-образ с
`curl-impersonate-chrome` из jik.2) + sidecar `signin-worker` (jik.3) + sidecar
`dnsproxy`. Это объединение `docker-compose.dns.yml` и `docker-compose.signin.yml`;
те остаются самостоятельными dev-вариантами. Обоснование архитектуры —
`docs/hybrid-v2-pipeline-design.md`, живые доказательства —
`docs/et0-live-integration-2026-11-21.md`.

## Отличия от DNS-стека

- Образ приложения пересобирается из debian-базы (glibc): в `/usr/local/bin`
  лежит `curl-impersonate-chrome` v0.6.1; `COMPLETIONS_TRANSPORT=auto` находит
  его по PATH и гоняет completions через Chrome ClientHello + HTTP/2.
- `signin-worker` (node:20-slim + Playwright + Chromium) получает и тихо
  продлевает сессии chat.qwen.ai; профили Chromium — в volume `signin_profiles`
  (внутри живые сессии: защищать как данные аккаунтов). Портов наружу нет.
- `signin-worker` тоже резолвит qwen.ai через DoH-sidecar (`dns:` + сеть
  `dns_sidecar`), как и приложение.
- Приложение стартует только после healthy у `dnsproxy` и `signin-worker`.

## Переменные

Полный пример — `docker/prod.env.example`. Сверх DNS-стека:

| Переменная | Назначение |
| --- | --- |
| `V2_SESSION_MODE` | `browser` (дефолт этого Compose) — сессии из sidecar; `off` — v1-путь |
| `COMPLETIONS_TRANSPORT` | `auto` (дефолт): impersonate, если бинаррь есть, иначе axios; `axios` — принудительно v1-транспорт |
| `SIGNIN_WORKER_TOKEN` | Общий bearer приложение → воркер; пусто = без авторизации (только внутренняя сеть) |
| `SIGNIN_PROFILES_DIR` | Каталог профилей Chromium; по умолчанию named volume `signin_profiles` |

Вторая копия стека на том же хосте (превью/тест) обязана взять **другую**
`DNS_SUBNET` + `DNS_SIDECAR_IP`: dnsproxy пинит статический IP в своей сети.

## Coolify: перевод существующего ресурса

Меняется существующий ресурс (хранилища и домен сохраняются), по аналогии с
`docs/dns-sidecar.md`:

1. Base Directory `/`, Compose Location `/docker/docker-compose.prod.yml`,
   ветка прежняя (`production`). Не принимать «Use /docker as base directory».
2. В Environment Variables добавить `SIGNIN_WORKER_TOKEN` (случайный секрет);
   при необходимости `V2_SESSION_MODE`/`COMPLETIONS_TRANSPORT` (дефолты уже
   browser/auto). Остальные переменные без изменений.
3. Persistent Storage прежние (`./data`, `./logs`, `./caches` того же ресурса).
4. Домен/маршрутизация — на сервис `qwen2api`, порт 3000, как раньше; для
   `signin-worker` и `dnsproxy` домены и port mapping не создавать.
5. Deploy через **Stop → Deploy** (статический IP dnsproxy не допускает двух
   экземпляров в одной подсети при rolling deploy).

## Живой смоук из контейнера (jik.5)

Полный цикл проверяется из контейнера приложения (его egress и есть прод).
В runtime-образе нет утилитного curl — HTTP из контейнера удобнее гонять
через bun; impersonate-бинаррь проверяется напрямую:

```sh
docker exec <qwen2api-контейнер> /usr/local/bin/curl-impersonate-chrome --version
# health sidecar изнутри приложения
docker exec <qwen2api-контейнер> bun -e 'fetch("http://signin-worker:3100/health").then(async r=>console.log(r.status,await r.text()))'
# 1) signin: аккаунт без токена → browser-вход через воркер (creds через env, не argv)
docker exec -e SMK=<API_KEY> -e EM=<email> -e PW=<password> <qwen2api-контейнер> \
  bun -e 'fetch("http://127.0.0.1:3000/api/setAccount",{method:"POST",headers:{Authorization:"Bearer "+process.env.SMK,"Content-Type":"application/json"},body:JSON.stringify({email:process.env.EM,password:process.env.PW})}).then(async r=>console.log(r.status,await r.text()))'
# 2) chats/new + completions + ответ модели одним вызовом
docker exec -e SMK=<API_KEY> <qwen2api-контейнер> \
  bun -e 'fetch("http://127.0.0.1:3000/v1/chat/completions",{method:"POST",headers:{Authorization:"Bearer "+process.env.SMK,"Content-Type":"application/json"},body:JSON.stringify({model:"qwen3.7-plus",stream:true,messages:[{role:"user",content:"Say pong"}]})}).then(async r=>console.log(r.status,(await r.text()).slice(-300)))'
# логи конвейера
docker logs --since 15m <qwen2api-контейнер> 2>&1 | grep -E "\[(ERROR|AUTH|CHAT|ACCOUNT|V2SESSION)\]" -A1
```

Ожидание: `setAccount` отдаёт 200 (воркер прошёл форму + капча Aliyun прошла
сама), completions стримит ответ модели. Если на impersonated-TLS ловится
`FAIL_SYS_USER_VALIDATE`/`RGV587_ERROR` (Baxia punish) — это ожидаемый риск
датацентрового egress-IP (см. Risks в дизайн-доке): поведение Baxia с
датацентрового IP отличается от домашнего; митигируется пер-аккаунтными
прокси (`account.proxy` передаётся и в воркер, и в curl).

## Откат

Одним конфигом, без перекодирования: `V2_SESSION_MODE=off` +
`COMPLETIONS_TRANSPORT=axios` в env ресурса → Stop → Deploy. Приложение
возвращается к v1-поведению (axios, логин по v1-пути), sidecar'ы остаются и
останавливаются независимо. `V2_SESSION_MODE=off` без `COMPLETIONS_TRANSPORT`
тоже валиден: auto продолжит ездить через impersonate — это не v1-транспорт,
поэтому для полного отката нужны обе переменные.

## Результат смоука 2026-11-21

Стек `docker/docker-compose.prod.yml` поднят на прод-хосте Coolify
(10.20.0.210) как изолированный превью-проект `qwen-hybrid-smoke`: отдельная
подсеть `172.30.54.0/24`, порт только `127.0.0.1:23216`, свои data/logs/caches.
Тот же docker-демон и тот же egress-IP, что у прода; creds тестовой учётки
передавались через env в `docker exec`, в логи не попали.

**Найдено и починено по дороге (именно то, ради чего нужен живой смоук):**

1. Образ воркера ставил Chromium от root в `/root/.cache/ms-playwright`, а
   рантайм идёт от `USER app` (uid 10001) и браузера не находил → фиксированный
   `PLAYWRIGHT_BROWSERS_PATH=/opt/pw-browsers` + `a+rX`.
2. В runtime-образе не было CA-бандла для curl (`curl: (77) error setting
   certificate verify locations`) — bun несёт свой стор, а curl-impersonate
   нужен `/etc/ssl/certs/ca-certificates.crt` → `ca-certificates` в стейдже.
3. `readStableToken` умирал на пост-логинной навигации FE
   (`page.evaluate: Execution context was destroyed`) → destroyed-context
   читается как «токен ещё не устоялся», ретрай на следующем документе.

**Полный цикл из контейнера — работает (датацентровый egress):**

- `GET /v1/models` → 200, живой каталог qwen.ai (22 КБ, `qwen3.7-plus`).
- Signin (browser): `POST /session` у воркера → 200, JWT + 19 cookies включая
  HttpOnly `refresh_token`; капча Aliyun прошла сама из контейнера. Первый
  прогон (форма+капча) занял ~20 с, повторный по живому профилю — 3.4 с.
- `POST /api/setAccount` → 200 «аккаунт создан», воркер отдал сессию в jar
  адаптера.
- `POST /v1/chat/completions` (stream) → **200 `text/event-stream`**, ответ
  модели «pong», usage от upstream (1205/110). Подтверждено трижды.
- Персистентность jik.4 вживую: после пересоздания контейнера приложение
  поднялось с «v2 сессий восстановлено: 1 действительна» без нового входа.

**Baxia и датацентровый IP.** На impersonated-TLS ни одного punish за весь
смоук. Отдельно зафиксировано: в откат-режиме (`COMPLETIONS_TRANSPORT=axios`,
plain Node TLS) completions с этого egress тоже прошли (200, единичная
проба) — с домашнего IP axios карался стабильно. Вывод: риск-скор этого
датацентрового egress сейчас не хуже домашнего, но однопробное наблюдение —
не гарантия: impersonate остаётся дефолтом, пер-аккаунтные прокси — рычаг
при деградации скоринга.

**Откат конфигом проверен:** `V2_SESSION_MODE=off` + `COMPLETIONS_TRANSPORT=axios`
(только env, без перекодирования) → приложение стартует без v2-restore в
логе, воркер не получает ни одного запроса, completions идут через axios и
обслуживаются 200; возврат `browser`/`auto` восстанавливает гибрид (200
«pong» на следующем же запросе).

## Первый боевой деплой 2026-11-21 (Coolify, ветка production, efd204d)

Переключение выполнено через Coolify API (compose location →
`/docker/docker-compose.prod.yml`, env `SIGNIN_WORKER_TOKEN`), Stop → Deploy,
все три контейнера healthy. Миграция аккаунтов на v2-сессии:

1. **Бутстрап-окно.** Аккаунты с непротухшими v1-токенами не логинятся сами
   (токен «валиден», v2-сессии нет) — completions падали 409
   `v2_session_required` до первого тика авто-refresh (≤15 мин). Лечение:
   последовательный `POST /api/refreshAccount` по каждому аккаунту
   (браузерный вход ~17–20 с на аккаунт, капча проходила сама).
2. **Ротация при сходе.** Вход даёт короткий токен (~15–30 мин); тёплый
   таймер воркера перезагружает профиль и ротирует токен на ~30-дневный.
   Пока приложение держит короткий токен, первый 401 → инвалидация →
   продление из кэша воркера — одноразовый само-лечащийся хикап на аккаунт.
   Ускорение сходимости: второй проход `refreshAccount` (отдаётся из кэша
   воркера мгновенно, без браузера).
3. **Baxia риск-скор egress-IP — ГЛАВНЫЙ УРОК.** До серии входов тот же IP
   весь смоук отработал чисто (включая однопробный axios на chats/new).
   После 9 браузерных входов за 3 минуты + диагностических проб скор
   эскалировал: completions punish («被挤爆啦»), затем chats/new стал отдавать
   слайдер-страницу вместо JSON на plain-Node TLS, затем жёсткий 405-блок
   даже на curl-impersonate. Т.е. блокируется IP целиком, не TLS-отпечаток:
   длина ноги impersonate не спасает, когда скор IP уже поднят. Рычаг из
   дизайн-дока — **пер-аккаунтные прокси** (`account.proxy` проходит и в
   браузерный контекст, и в curl); альтернатива — остывание скора (типично
   минуты-часы) и мягкое перезакрепление аккаунтов (без пачковых входов).
   Диагностические пробы с самого egress кормят скор — минимизируйте их.
