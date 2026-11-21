# Qwen2API / Coolify: история закрепления IP и диагностика DNS

Дата: 20 ноября 2026, Europe/Saratov (UTC+04). Основные пробы: 17:02–17:10 UTC / 21:02–21:10 Саратов.
Задача: Qwen2API-bqf; связанный транспортный инцидент: Qwen2API-o7u; следующий изолированный опыт: Qwen2API-0uv.

## Ответ

Воспоминание о подмене адреса верно. 28 августа в production добавляли **прикладное закрепление IP**, а 29 сентября его **намеренно удалили**. В нынешнем production этот механизм отсутствует. Найденные сейчас адреса 8.209.5.182 и 8.209.7.101 не являются результатом действующей старой подмены в Qwen2API.

В проверенном прямом сетевом пути обычный DNS выбирает недоступную для TCP точку Alibaba. Выбор зависит от resolver/точки выхода/ECS: это воспроизводится и через TLS-проверенный DoH. Объяснение через географический выбор точки Alibaba подтверждается значительно лучше, чем гипотеза подмены обычного DNS. Кто именно препятствует TCP к 8.209.*, не установлено; географическая выдача DNS и причина сетевой недоступности — разные вопросы.

Проверено минимальное исправление **транспорта одного запроса**: динамический DoH из существующего production network namespace. Никаких записей hosts, изменений DNS, image, аккаунтов или перезапусков не выполнялось. Успех транспортного контроля не доказывает работоспособность авторизованного production Chat Completions.

## История Git и задачи

Проверены все доступные refs после fetch origin/upstream, full-history с раскрытием merge, обе существовавшие рабочие копии и новая изолированная копия аудита. Основная рабочая копия оставлена с её исходными незакоммиченными файлами.

| Изменение | Свидетельство | Значение |
|---|---|---|
| Первичная поддержка HTTP proxy / reverse proxy URL | 55afc15 | PROXY_URL задаёт исходящий прокси; QWEN_CHAT_PROXY_URL меняет базовый URL, это не настройка DNS |
| Закрепление IP | 5acfd7ce3e7eaf60ddb0aabd637b3243bb5b2415, 2026-08-28 | QWEN_CHAT_ENDPOINT_IPS / QWEN_CLI_ENDPOINT_IPS; custom lookup для direct, PinnedHttpsProxyAgent для CONNECT к IP; домен сохраняется в SNI/Host/проверке сертификата |
| Основание августовской правки | Qwen2API-bg6, закрыта; docs/worklog/2026-08-28-zakreplenie-adresa-tochki-vhoda.md | Зафиксирован ECONNRESET для 8.209.5.182 и успешные 47.254.175.31 / 47.91.78.155; задача подтверждает merge/push production |
| Удаление закрепления | 700d0dcdaf15e8462ebeab789f613172da2624e6, 2026-09-29 | Merge commit прямо сообщает об удалении 5acfd7c: через обычные 8.209.* тогда прошли 6/6 длинных ответов; upstream перешёл на Bun/undici, старый agent не переносили |
| SOCKS5 DNS | a947146, afd1a7934670bad0829c7bdccd4e4683e61bf1dd | socks5 разрешает цель локально, socks5h — на прокси; отдельная история, не фиксированная подмена IP |
| Текущая реализация | src/utils/proxy-helper.js | account.proxy > global PROXY_URL > direct; HTTP CONNECT/undici и SOCKS-agent, без старого реестра endpoint IP |

Коммит добавления доступен из production/origin/production, но наличие его в ancestry не означает наличие кода в tip. Удаление находится именно в merge: простой git log -S без -m может его пропустить.

Точечный поиск всех refs по DNS lookup/resolve/setServers, hardcoded IP, extra_hosts/--add-host и заданным адресам выявил историческое закрепление, его удаление и SOCKS5H. Иного действующего DNS override в src/docker/tools не найдено. Совпадения lookup в model-map и mime-types не относятся к DNS.

Tracked src/docker/tools/package.json/bun.lock между production aafdb2bd и lab-base f55a709 совпадают. Локальные deployment-поправки lab меняют cookies/headers/fingerprint/refresh/persistence, но не DNS. Это не делает lab image эквивалентным production image.

GitHub-поиск DNS по issues/PR форка и upstream не нашёл отдельного обсуждения августовского pinning. Найден upstream PR [#176](https://github.com/Rfym21/Qwen2API/pull/176), merged 2026-09-27: SOCKS5H, Bun transport и egress diagnostics. Это отдельная тема. Основные свидетельства о pinning — Git и Qwen2API-bg6, не предположения по PR.

## Фактически запущенный production

- Хост: root@10.20.0.210, coolify-triglav, LXC.
- Контейнер: qwen2api-m04skwsg8kck8ckwkc04ssss-20261118T140709, e7198260faec.
- Created/StartedAt: 2026-11-18T14:07:57Z; RestartCount=0.
- Image: m04skwsg8kck8ckwkc04ssss_qwen2api:aafdb2bd129c4d43398d0f58aee5a20f537661dc.
- Image ID: sha256:ba61eb69855445944896f43627ac467456a08e1f0303658785578f7b41cf6794.
- Entrypoint: /usr/local/bin/qwen2api; это Bun executable, исходников /app/src в runtime нет.
- SHA-256 исполняемого файла: 02de782681749b2e509bbbdfdd8651ee6d1c1cb7d81c25bd51015e5472688686.
- docker diff пуст: изменений файловой системы контейнера относительно image не видно; bind mounts проверяются отдельно.
- В executable нет строк QWEN_CHAT_ENDPOINT_IPS, QWEN_CLI_ENDPOINT_IPS, createPinnedLookup, PinnedHttpsProxyAgent, 170.33.12.244, 8.209.5.182, 47.254.175.31. QWEN_CHAT_PROXY_URL и socks5h: присутствуют. Это дополнительная проверка фактического артефакта, а не только Git.
- В runtime env нет endpoint IP, QWEN_CHAT_PROXY_URL, PROXY_URL или preload-настроек NODE_OPTIONS/BUN_OPTIONS. DATA_SAVE_MODE=file.
- Dns/DnsSearch/DnsOptions не заданы; ExtraHosts=[]; network m04skwsg8kck8ckwkc04ssss, bridge, Internal=false, Options={}.
- Bind mounts только data/logs/caches. /etc/hosts и /etc/resolv.conf не подмонтированы пользователем.
- В данных 9 аккаунтов: 8 http-прокси, 1 direct. Выводились только агрегаты схем, без email, URL, credentials или токенов.

В текущем generated docker-compose.yaml и .env нет endpoint-настроек, dns или extra_hosts. Найден docker-compose.yaml.bak-20260828-before-endpoint-ips: дата/имя согласуются с августовской работой, но сам backup ДО правки не доказывает конкретных значений применённых переменных. В shell history endpoint-переменных нет. Подтверждение прежнего кода — Git/задача; восстановить точный прошлый runtime env из имеющихся файлов не удалось.

Диагностические контейнеры по-прежнему остановлены. Только qwen2api-session-dns-control-20261120 содержит ExtraHosts=[chat.qwen.ai:170.33.12.244]. У qwen2api-session-diagnostic-20261120 такого override нет. Эта запись не воздействует на production и host resolver.

## Цепочка resolver и инфраструктура

Coolify host /etc/hosts содержит только localhost, IPv6-служебные записи и PVE hostname. Записи chat.qwen.ai нет. NSS hosts: files dns. /etc/resolv.conf имеет PVE-managed блок: search jabc.loc, nameserver 10.20.0.151.

В production /etc/hosts нет Qwen; /etc/resolv.conf сгенерирован Docker: nameserver 127.0.0.11, search jabc.loc, options ndots:0. Комментарий Docker указывает ExtServers=[host(10.20.0.151)], Overrides=[]. DNS-запрос из network namespace production к 127.0.0.11 также вернул оба 8.209.*.

/etc/docker/daemon.json содержит только параметры ротации логов, глобального DNS override нет. systemd-resolved запущен, но resolv.conf mode=foreign и NSS использует files dns: обычный libc lookup читает указанный resolv.conf. resolved также показывает 10.20.0.151. dnsmasq/nscd/unbound не активны. В проверенных drop-in/network-файлах специальной настройки Qwen не найдено.

Proxmox pve-triglav (10.20.0.205): Coolify — LXC 117; net0=eth0/vmbr0, ip=dhcp. В pct config 117 нет отдельного nameserver/searchdomain; /etc/resolv.conf узла PVE также содержит search jabc.loc и 10.20.0.151. Наблюдаемая конфигурация согласуется с наследованием DNS от PVE, без специальной настройки Qwen. История изменений Proxmox целиком не восстановлена.

На Coolify iptables OUTPUT policy=ACCEPT; в просмотренном nat-правилах нет DNS redirect/DNAT. Маршруты к 8.209.5.182, 170.33.12.244 и 1.1.1.1 идут через один шлюз 10.20.0.1/eth0. На MikroTik безопасная выборка всех NAT-правил не выявила перенаправления DNS/53. Это не проверка всех устройств и всех правил фильтрации на внешнем пути.

VM 10.20.0.218: systemd-resolved stub 127.0.0.53. LAN ens18 использует 10.20.0.151 для jabc.loc; WireGuard omnirouter использует 1.1.1.1 с routing domain ~. Публичное имя resolvectl разрешает через link omnirouter в 170.33.12.244. ip route get 1.1.1.1 без привязки выбирает LAN, с oif omnirouter — туннель (10.30.0.30). Поэтому прямой dig @1.1.1.1 на этой VM может вернуть 8.209.*, хотя системный getaddrinfo возвращает 170.33.12.244: такие запросы идут разными путями.

Кэши не сбрасывались. Конфигурация upstream/forwarder самого 10.20.0.151 не читалась; для объяснения расхождения она не является единственной необходимой гипотезой, поскольку та же пара IP воспроизводится по TLS-проверенному DoH и у authoritative DNS.

## DNS-пробы 20 ноября

Во всех положительных ответах chat.qwen.ai ссылается на ga-bp126u6glc02vbpq9tob9.aliyunga0019.com. Различается A-запись этой цели.

| Запрос с Coolify | Результат |
|---|---|
| getaddrinfo; production 127.0.0.11 | 8.209.5.182, 8.209.7.101 |
| UDP и TCP @10.20.0.151 | та же пара 8.209.* |
| UDP и TCP @1.1.1.1; UDP @1.0.0.1 | та же пара 8.209.* |
| UDP и TCP @8.8.8.8 | та же пара 8.209.* |
| UDP @9.9.9.9 | 170.33.12.244; TCP: EOF, поэтому это ещё не готовая рекомендация постоянного resolver |
| UDP/TCP @192.0.2.1 (TEST-NET, контроль) | timeout; ответа от произвольного адреса не получено |
| Cloudflare DoH cloudflare-dns.com, обычное разрешение его имени | 170.33.12.244 |
| Тот же Cloudflare DoH, resolver endpoint принудительно 1.1.1.1 или 1.0.0.1; hostname/TLS сохранены | 8.209.5.182, 8.209.7.101 |
| Google DoH, без ECS-параметра | 8.209.5.182, 8.209.7.101 |
| Google DoH, edns_client_subnet=0.0.0.0/0 | 170.33.12.244 |
| Google DoH, edns_client_subnet=77.88.8.0/24 | 8.209.5.182, 8.209.7.101 |
| Google DoH, edns_client_subnet=8.8.8.0/24 | 47.77.4.100, 47.77.67.38 |

ECS-подсети — контрольные значения запроса, не адреса пользовательских аккаунтов. Доступность адресов 47.77.* здесь не проверялась.

Cloudflare /cdn-cgi/trace: обычный cloudflare-dns.com дал colo=WAW, принудительный resolver endpoint 1.1.1.1 — colo=DME. Для обычного DNS @1.1.1.1 запрос id.server CH TXT вернул dme05 по UDP и TCP. Самоответ trace/id.server — вспомогательное свидетельство расположения точек, не криптографическая аттестация DNS-маршрута. DoH-соединения использовали штатную TLS-проверку.

Дополнительно: ns1.alibabadns.com (47.88.74.38) вернул CNAME с флагом aa. Authoritative серверы vip3.alidns.com, адреса 170.33.73.26 / 170.33.32.210 / 170.33.80.10, при прямом +norecurse запросе цели возвращали оба 8.209.* с aa и TTL=600. Два из них также вернули эту пару при ECS=77.88.8.0/24; ECS scope=24. Часть других authoritative probes завершилась timeout. Обычный DNS не криптографически аутентифицирован, поэтому флаг aa отдельно не исключает вмешательство; решающая независимая проверка — такая же выдача через HTTPS с валидированным сертификатом resolver.

Наблюдения согласуются с [документацией Alibaba о выборе ответа по географии/ECS и адресу resolver](https://www.alibabacloud.com/help/en/dns/pubz-intelligent-analysis) и [описанием ECS в Google Public DNS](https://developers.google.com/speed/public-dns/docs/ecs). Документация объясняет механизм; конкретные ответы Qwen установлены пробами выше.

Следовательно, различие здесь нельзя сводить к «порт 53 подменяют, а HTTPS правильный»: один и тот же защищённый протокол воспроизводит оба набора адресов. Наиболее обоснованное объяснение расхождения — разные точки resolver/контекст геолокации, включая ECS. Разные кэши также возможны; одного кэширования недостаточно для объяснения всей повторяемой матрицы ECS и различных Cloudflare PoP. Полное отсутствие какого-либо селективного вмешательства на пути этим аудитом не доказано.

## TCP/TLS и отдельные маршруты аккаунтов

С Coolify и VM 10.20.0.218 TCP/443 к обоим 8.209.* завершился timeout за ограниченные 3–4 секунды. К 170.33.12.244 соединение устанавливалось с обоих хостов. С Coolify Python TLSv1.3 с server_hostname=chat.qwen.ai и штатной проверкой сертификата прошёл; GET /api/models без токена вернул HTTP 200. Другой клиент curl получил HTTP 405, при этом TLS verification=0 (успешная проверка сертификата). Различие HTTP-ответов не отменяет установленного транспорта и не доказывает рабочую авторизацию.

Из namespace работающего production контейнера (nsenter только network, host curl, без изменения filesystem/process/env приложения):

| Режим одного GET /api/models без токена | Итог |
|---|---|
| Обычный DNS | curl exit 28, HTTP 000, TCP timeout около 4.003 s; TLS не начался |
| --resolve chat.qwen.ai:443:170.33.12.244, прежний статический контроль | HTTP 405, TLS verify=0, remote=170.33.12.244 |
| --doh-url https://cloudflare-dns.com/dns-query, без закрепления Qwen IP | HTTP 405, TLS verify=0, remote=170.33.12.244, около 1.525 s |

Не следует трактовать ssl_verify_result=0 из неуспешного TCP-запроса как выполненную проверку TLS. В положительных контролях выполнены и TCP, и TLS, и HTTP.

У восьми прокси-аккаунтов выполнены ровно по одной паре CONNECT/TLS-проб: CONNECT chat.qwen.ai:443 и CONNECT 170.33.12.244:443, всегда с SNI/проверкой сертификата chat.qwen.ai, без Qwen JWT/cookies и без запроса генерации. Credentials использовались только для аутентификации в уже настроенном прокси, без вывода или сохранения.

Результат: CONNECT 200 для всех 16 туннелей. С доменным CONNECT 7/8 прошли TLSv1.3 с валидным сертификатом; одна проба получила SSLEOFError после CONNECT 200. С IP-контролем 8/8 прошли TLS. Это краткий снимок: единичный EOF не доказывает DNS-причину для восьмого прокси; точные выбранные прокси удалённые IP не наблюдались. Проверка не воспроизводит длительный SSE/body timeout. Для большинства прокси начальное TCP/TLS препятствие прямого пути в этот момент не воспроизвелось.

HTTP-прокси получает доменное имя через CONNECT и разрешает его у себя. Исправление resolver Coolify само по себе не меняет такое разрешение для 8 аккаунтов. Нельзя объяснять все production-сбои только DNS хоста, как нельзя объяснять TCP timeout токеном или WAF.

## Минимальное исправление и границы вывода

Уже проверен динамический DoH для отдельного прямого запроса из production namespace: он устранил TCP timeout без статического CDN IP. Следующий минимальный прикладной опыт — отдельный диагностический экземпляр штатного production image с изолированными данными и resolver, который динамически разрешает только Qwen через проверенный DoH endpoint, учитывает TTL и не затрагивает LAN split DNS. Сначала проверять безтокенные TCP/TLS/catalog, затем отдельно авторизованный запрос при наличии действующей сессии. В данном аудите экземпляр не запускался, токены не обновлялись и не импортировались.

DoH сам по себе не гарантирует иной A-ответ: endpoint 1.1.1.1 по HTTPS здесь дал те же недоступные IP. Критерий проверки — динамически полученный адрес и достижимость, сохранение имени/TLS, корректное обновление по TTL. Кандидат cloudflare-dns.com в текущем маршруте прошёл транспортный опыт; это не гарантия неизменности его PoP/ответа в будущем.

Для HTTP-прокси потребуется отдельный опыт через конкретный проблемный маршрут: доменный CONNECT против CONNECT к динамически разрешённой точке с исходным SNI/Host. Если решено реализовать прикладное переопределение, оно должно учитывать нынешний Bun/undici, proxy/direct, ключи пулов и TTL; возвращение августовского Node https.Agent или добавление старых env-переменных к текущему image не включит удалённую функцию. Восстановление статических старых 47.* либо постоянный hosts=170.33.12.244 не обосновано.

Не хватает для окончательной сетевой причины: сопоставления SYN/SYN-ACK на шлюзе и внешней стороне/у Alibaba либо ответа оператора о доступности 8.209.*. Из доступных timeout нельзя определить место потери или виновника. Для объяснения конкретных production UND_ERR_HEADERS/BODY_TIMEOUT нужны маршрут/аккаунт и фаза сбоя в момент ошибки; текущие короткие TLS-пробы не восстанавливают это задним числом. Конфигурация DNS-forwarder 10.20.0.151 и полная история PVE не исследованы; признаков, делающих их обязательной причиной нынешней выдачи, не найдено.

Срок JWT и отказ WAF остаются отдельными ограничениями. Успешные non-stream/stream из исходного отчёта относятся к модифицированному lab-image и свежей короткоживущей сессии. Здесь авторизованный production Chat Completions не проверялся и обход CAPTCHA/WAF не выполнялся.

## Сохранность и завершение

Основной контейнер не перезапускался; DNS/сеть/образ/аккаунты/volumes не изменялись. Оба диагностических контейнера оставлены остановленными. Защищённые backup/data/env из qwen-session-test не выгружались. В отчёте только безопасные агрегаты и выбранные поля. Исходный отчёт M:/repos/servers/omnirouter.jabc.loc/docs/coolify-qwen-session-comparison.md использован как входной артефакт, не изменён.

Изменён только этот отчёт в изолированном worktree Qwen2API. Для документации применяется git diff --check; тесты приложения не требуются, runtime-код не менялся.

Синхронизация: автоматическая проверка безопасности отклонила bd dolt push из-за публикации сведений production в непроверенный remote. bd dolt remote list затем подтвердил отсутствие настроенных remote. Отчёт и задачи сохранены локально; синхронизация beads требует подтверждённого назначения. Origin weselow/Qwen2API — публичный репозиторий; этот инфраструктурный отчёт в него не отправлялся.
