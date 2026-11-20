# Qwen2API (форк)

## Project Overview

Форк [Qwen2API](https://github.com/Rfym21/Qwen2API) — прокси-сервис, преобразующий chat.qwen.ai и Qwen Code CLI в OpenAI-совместимый API. Начинали с русификации dashboard UI, сейчас правим и backend.

## Tech Stack

- **Backend**: Node.js 18+, Express, PM2
- **Frontend**: Vue 3 (Composition API, `<script setup>`), Vite, Tailwind CSS, vue-router, axios
- **Данные**: файл `data/data.json` или Redis
- **Деплой**: Docker (Coolify), образ `rfym21/qwen2api:latest`

## Структура

```
src/                     # Backend (Express)
public/                  # Frontend (Vue 3 SPA)
  src/
    App.vue              # Корневой компонент (видео-фон)
    main.js              # Точка входа Vue
    style.css            # Глобальные стили
    views/
      auth.vue           # Страница логина (~50 строк)
      dashboard.vue      # Управление аккаунтами (~800 строк, основной файл)
      settings.vue       # Настройки (~310 строк)
    routes/              # Vue Router
    assets/              # Статика
docker/                  # Docker Compose файлы
docs_fork/               # Наши заметки (в .gitignore)
```

## Деплой

- Docker Compose: `docker/docker-compose.yml`
- Env: `API_KEY`, `ACCOUNTS`, `DATA_SAVE_MODE=file`
- Coolify: проект из GitHub-репозитория
- Прод: coolify-triglav, `ssh root@10.20.0.210` (не coolify.jabc.loc), контейнер `qwen2api-m04skwsg8kck8ckwkc04ssss-*`, данные `/app/data/data.json` внутри контейнера
- Логи: `docker logs --since 30m <контейнер> 2>&1 | grep -E "\[(ERROR|AUTH|CHAT|ACCOUNT)\]" -A1` — без фильтра идут стеки axios и куски собранного JS

## Синхронизация с upstream

```bash
git remote add upstream https://github.com/Rfym21/Qwen2API.git
git fetch upstream
git merge upstream/main
```

## Правила

- Правки в `src/` держать минимальными: чем ближе к upstream, тем меньше конфликтов при слиянии
- При обновлении upstream — проверить новые строки в views
- Отвечать пользователю на русском языке
