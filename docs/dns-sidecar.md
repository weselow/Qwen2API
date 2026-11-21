# Qwen2API с DNS-over-HTTPS sidecar

`docker/docker-compose.dns.yml` — самостоятельная альтернатива
`docker/docker-compose.dev.yml`, а не override к нему. Он собирает Qwen2API
через прежние `build.context: .` и `docker/Dockerfile`, сохраняет штатный
`/usr/local/bin/qwen2api`, переменные приложения и bind mounts
`data`, `logs`, `caches`. Старый Compose не изменён.

## Как проходит DNS

Qwen2API → Docker DNS (`127.0.0.11`) → постоянный IP `dnsproxy` → upstream:

- `chat.qwen.ai` и его поддомены: **только**
  `https://cloudflare-dns.com/dns-query`;
- `aliyunga0019.com` и поддомены: тот же DoH, для отдельных запросов к
  наблюдаемой CNAME-цели Qwen;
- все остальные имена: обычный DNS из `DNS_UPSTREAM`.

Полный CNAME-ответ приходит от DoH upstream. Если Qwen сменит зону CNAME,
обычный запрос `chat.qwen.ai` продолжит идти через DoH; при отдельных запросах
к новой цели следует обновить список доменов в Compose после наблюдения DNS.
IP Qwen/CDN нигде не закрепляется; `extra_hosts` отсутствует. Адрес
`DNS_SIDECAR_IP` относится только к контейнеру resolver.

Официальный образ AdGuard dnsproxy закреплён по версии **v0.86.0** и digest
multi-platform manifest. Bootstrap `cloudflare-dns.com` выполняется через
отдельно заданный IP DNS-сервера `DNS_BOOTSTRAP`. Это должен быть доступный
обычный DNS, а не IP sidecar, `127.0.0.11` или имя, требующее bootstrap.
Не заменяйте URL DoH на `https://1.1.1.1/dns-query`: выбор endpoint по имени
имеет значение для маршрута и ответа CDN. Bootstrap определяет только адрес
DoH-сервера, не IP Qwen. Проверка сертификатов HTTPS включена.

Кэш включён, min/max TTL не переопределяются (`0`), optimistic cache выключен:
ответы старше TTL не выдаются. При отказе DoH для его доменов нет fallback на
обычный DNS. Кэш DNS и кэш каталога в самом приложении — разные уровни.
Порт 53 TCP/UDP доступен внутри bridge, наружу не публикуется. Сеть sidecar
не `internal: true`: ей нужен исходящий доступ к DNS/53 и HTTPS/443.

`restart: always` действует на оба сервиса. Healthcheck dnsproxy выполняет
настоящие A-запросы через локальный listener и требует непустые A-ответы от
`chat.qwen.ai` (DoH) и
`example.com` (обычный upstream); Qwen2API стартует после `service_healthy`.
Healthcheck может использовать ещё действующий TTL кэша. Docker помечает
работающий resolver как unhealthy при ошибках, но сам по этому статусу не
перезапускает его; restart policy восстанавливает завершившийся процесс.

DNS приложения управляет прямыми соединениями. Удалённый HTTP CONNECT proxy
разрешает назначение у себя. Эта конфигурация не устраняет отказ авторизации
Qwen и не подтверждает работоспособность генерации.

## Coolify: переход существующего проекта

Меняйте **существующий ресурс**, чтобы сохранить его хранилища и домен.
Не создавайте новый проект с пустыми bind mounts вместо действующего.

1. Сохраните текущие настройки и защищённую резервную копию data, включая
   `data.json` / `data.json.bak`. Не помещайте их или `.env` в Git.
2. Оставьте build pack **Docker Compose** и ветку **production**.
   Установите **Base Directory**: `/`, **Docker Compose Location**:
   `/docker/docker-compose.dns.yml`.
   Если Coolify предложит «Use /docker as base directory», не применяйте:
   `context: .` должен указывать на корень репозитория, где есть package.json,
   src, public и docker/Dockerfile. В Coolify Compose запускается с project
   directory, заданным Base Directory. При обычном CLI явно укажите
   `--project-directory .`, как в примере ниже.
3. Загрузите/обновите Compose из Git и задайте переменные ниже в Environment
   Variables. Они должны быть доступны для Compose interpolation при deploy,
   а не только внутри уже запущенного приложения. Новые DNS-переменные
   не являются секретами. Значение `API_KEY` сохраните прежним.
4. В **Persistent Storage** проверьте прежние **Source → Destination** для
   `/app/data`, `/app/logs`, `/app/caches`. По умолчанию остаются `./data`,
   `./logs`, `./caches` внутри каталога этого же ресурса Coolify. Они должны
   разрешиться в те же абсолютные host paths, что и у действующего контейнера.
   Если ранее задавали абсолютные пути, используйте те же значения через
   `QWEN_DATA_DIR`, `QWEN_LOGS_DIR`, `QWEN_CACHES_DIR`. Не выбирайте новые пустые
   каталоги. Смена имени Compose сама по себе не требует миграции данных.
5. Оставьте домен и маршрутизацию на сервис **qwen2api**, внутренний порт
   **3000**. Для dnsproxy домен и port mapping не создавайте. Существующие
   настройки публикации приложения сохраните (`QWEN_PORT_BINDING`, если нужны).
6. Перед Deploy просмотрите сгенерированный Compose: должны сохраниться
   `dns`, `depends_on: condition: service_healthy`, IPAM подсеть и
   `dnsproxy.networks.dns_sidecar.ipv4_address`. Coolify может добавлять свою
   сеть для HTTP proxy; отдельная сеть sidecar должна остаться bridge с IPAM.
   Дополнительные файлы конфигурации и Preserve Repository для DNS не нужны:
   все аргументы dnsproxy находятся в Compose.
7. Deploy. Дождитесь healthy у dnsproxy, затем проверьте каталог и старые
   настройки/аккаунты в UI без запуска входа, refresh или генерации.

Статический IP resolver не допускает два экземпляра dnsproxy одновременно
на одной сети. Если Coolify делает rolling deployment с двумя наборами
контейнеров, используйте **Stop → Deploy** с коротким простоем, включая
последующие обновления этого Compose. Не включайте replicas/preview с общей
подсетью; для отдельного тестового ресурса выделяйте другую подсеть и IP.

| Переменная | Значение / назначение |
| --- | --- |
| `DNS_UPSTREAM` | Обязательно: обычный DNS в формате IP:port; для этого сервера `10.20.0.151:53` |
| `DNS_BOOTSTRAP` | Обязательно: независимый IP:port для bootstrap; здесь `10.20.0.151:53` |
| `DNS_SUBNET` | Обязательно: свободная подсеть bridge, например `172.30.53.0/24` после проверки |
| `DNS_SIDECAR_IP` | Обязательно: свободный адрес из этой подсети, например `172.30.53.53`, не gateway/network/broadcast |
| `API_KEY` | Обязательно: существующий секретный ключ приложения; для теста — отдельный случайный |
| `QWEN_DATA_DIR`, `QWEN_LOGS_DIR`, `QWEN_CACHES_DIR` | Необязательно: по умолчанию `./data`, `./logs`, `./caches` |
| `QWEN_PORT_BINDING` | Необязательно: по умолчанию `3000:3000`; для теста `127.0.0.1:23215:3000` |

`LISTEN_ADDRESS`, `SEARCH_INFO_MODE`, `OUTPUT_THINK`, `SIMPLE_MODEL_MAP`,
`REDIS_URL`, `DATA_SAVE_MODE`, `ACCOUNTS`, `CACHE_MODE` сохранены с прежними
значениями по умолчанию и теперь допускают подстановку из окружения.
`SERVICE_PORT` остаётся 3000. Для существующего file/redis-хранилища
не заполняйте `ACCOUNTS` заново; режим и REDIS_URL сохраните прежними.

Перед выбором подсети на Docker host проверьте **все** Docker networks,
а также LAN/VPN-маршруты. Пример `172.30.53.0/24` не является универсальным
резервированным диапазоном; другой экземпляр должен выбрать свой диапазон:

```sh
docker network inspect $(docker network ls -q) --format '{{.Name}} {{json .IPAM.Config}}'
ip -4 route
```

Сохранить адреса хранилищ без вывода env/секретов можно так:

```sh
docker inspect <existing-qwen2api-container> --format '{{range .Mounts}}{{.Source}} -> {{.Destination}}{{println}}{{end}}'
```

## Ручная валидация и изолированный запуск

Из корня репозитория скопируйте `docker/dns.env.example` в приватный env-файл
**вне Git**, задайте новый случайный API_KEY, другую свободную подсеть и
**отдельные абсолютные пути** к пустым test-data/test-logs/test-caches через
QWEN_*_DIR. В DATA_SAVE_MODE=file и ACCOUNTS= пустое приложение может получить
публичный каталог без импорта production аккаунтов. Не монтируйте production
data и не используйте его REDIS_URL/ключ. Для теста привяжите HTTP к loopback.

```sh
docker compose --project-directory . --env-file /secure/test.env -p qwen-dns-test -f docker/docker-compose.dns.yml config --quiet
docker compose --project-directory . --env-file /secure/test.env -p qwen-dns-test -f docker/docker-compose.dns.yml up -d --build --wait --wait-timeout 120
docker compose --project-directory . --env-file /secure/test.env -p qwen-dns-test -f docker/docker-compose.dns.yml ps
```

Не публикуйте вывод `config` без `--quiet`: он содержит подставленные секреты.
Проверьте реальное разрешение имени из приложения и отсутствие hosts override:

```sh
docker exec <test-qwen2api-container> getent hosts chat.qwen.ai
docker inspect <test-qwen2api-container> --format '{{json .HostConfig.Dns}} {{json .HostConfig.ExtraHosts}}'
docker inspect <test-dnsproxy-container> --format '{{json .HostConfig.PortBindings}} {{.State.Health.Status}}'
```

Проверьте UDP и TCP A-запросы к DNS_SIDECAR_IP и через Docker `127.0.0.11`
из network namespace тестового приложения, а также обычное/локальное имя.
Например, host `dig` можно запустить через `nsenter -t <test-app-pid> -n` с
явным `@127.0.0.11`; для TCP добавьте `+tcp`. Вызовите `/v1/models` через
Qwen2API с тестовым ключом и проверьте HTTP 200 и непустой список `data`.
Пустой список сам по себе не подтверждает получение upstream-каталога.
Повтор DNS-запроса должен показать убывающий TTL; после истечения записи
нужен новый upstream-запрос. Не сравнивайте ответ с постоянным ожидаемым CDN IP.

По окончании обязательно остановите/удалите только диагностический проект:

```sh
docker compose --project-directory . --env-file /secure/test.env -p qwen-dns-test -f docker/docker-compose.dns.yml down --remove-orphans
```

## Откат

В том же ресурсе Coolify верните **Base Directory `/`** и
**Compose Location `/docker/docker-compose.dev.yml`**, прежние переменные,
port mapping и **те же источники** data/logs/caches. Выполните Stop → Deploy.
В старом Compose API_KEY задан литералом: восстановите прежний действующий
ключ в настройках итогового Compose, не публикуя его в Git. Проверьте,
что сгенерированный Compose действительно передаёт ожидаемый ключ.

После остановки старого DNS-варианта убедитесь, что dnsproxy не остался
запущенным как orphan: при необходимости удалите только его контейнер
этого ресурса. `down -v`, удаление data и `docker system prune` для отката
не нужны. Подключение без sidecar снова использует прежний Docker/host DNS.

## Проверено для этой конфигурации

21 ноября 2026 выполнены `docker compose config --quiet` для обоих Compose,
полная сборка через неизменённый Dockerfile и изолированный запуск нового
Compose с пустым file-хранилищем и отдельным случайным API-ключом. Production
данные и учётные записи не подключались. Проверены UDP/TCP DNS через Docker
resolver приложения, обычный upstream, фактическое разрешение Qwen внутри
приложения, HTTPS TCP peer приложения и HTTP 200 с непустым каталогом
`/v1/models`. ExtraHosts пуст, DNS-порты не опубликованы, entrypoint прежний.

На контролируемом DNS с TTL=2 секунды проверены попадание в кэш до истечения
TTL и новый запрос upstream с изменившимся ответом после TTL. При недоступном
bootstrap проверены отсутствие обычного fallback для Qwen, unhealthy resolver
и блокировка старта приложения при работающем обычном DNS. Перезапуск
resolver прошёл с сохранением внутреннего IP. Диагностические контейнеры и
их сети удалены; генерация, вход, refresh и аккаунтные прокси не проверялись.

## Источники

- [AdGuard dnsproxy v0.86.0: CLI, bootstrap и маршрутизация доменов](https://github.com/AdguardTeam/dnsproxy/tree/v0.86.0)
- [Coolify: Docker Compose, Base Directory, пути, storage и healthcheck](https://coolify.io/docs/applications/builds/docker-compose)
