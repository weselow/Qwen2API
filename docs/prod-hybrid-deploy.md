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

Полный цикл проверяется из контейнера приложения (его egress и есть прод):

```sh
docker exec <qwen2api-контейнер> sh -c 'command -v curl || command -v curl-impersonate-chrome'
# health sidecar изнутри приложения
docker exec <qwen2api-контейнер> curl -s http://signin-worker:3100/health
# 1) signin: аккаунт без токена → browser-вход через воркер
curl -s -X POST http://127.0.0.1:<порт>/api/setAccount -H 'Authorization: Bearer <API_KEY>' \
  -H 'Content-Type: application/json' -d '{"email":"…","password":"…"}'
# 2) chats/new + completions + ответ модели одним вызовом
curl -sN -X POST http://127.0.0.1:<порт>/v1/chat/completions -H 'Authorization: Bearer <API_KEY>' \
  -H 'Content-Type: application/json' \
  -d '{"model":"qwen3.7-plus","messages":[{"role":"user","content":"Reply with the single word: pong"}],"stream":true}'
# логи конвейера
docker logs --since 15m <qwen2api-контейнер> 2>&1 | grep -E "\[(ERROR|AUTH|CHAT|ACCOUNT)\]" -A1
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

(заполняется по факту деплоя jik.5)
