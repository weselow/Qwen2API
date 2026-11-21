# Обновление из вышестоящего репозитория

Порядок синхронизации форка с upstream (Rfym21/Qwen2API).

## Раскладка веток

- **`upstream/main`** — вышестоящий репозиторий (Rfym21/Qwen2API). Только читаем.
- **`main`** — чистое зеркало `upstream/main`. Своих коммитов не держим, обновляется только fast-forward'ом.
- **`production`** — рабочая ветка форка (русификация, Coolify, прочая форк-специфика). Сюда вливаем `main`.

## Последовательность

```bash
# 0. Подтянуть upstream и оценить, что нового
git fetch upstream
git log --oneline 6273baf..upstream/main      # вместо 6273baf — текущая голова main
git rev-list --left-right --count main...upstream/main   # 0 слева = можно fast-forward

# 1. Влить upstream в зеркало main (ожидается fast-forward)
git checkout main
git merge --ff-only upstream/main
git push origin main

# 2. Влить main в production
git checkout production
git merge main
#    -> при конфликтах см. раздел ниже
git push origin production
```

## Конфликты

- Наши изменения живут **только в `public/src/`** (frontend) — конфликты возможны там.
- По опыту конфликты возникают из-за расхождения формулировок/комментариев, а не логики.
- Стратегия: принять структуру upstream, заново применить наши правки локализации.
- Файлы локализации (`public/src/locales/{ru,zh,en}.json`) обычно мержатся автоматически — upstream добавляет ключи в конец секций, мы их не двигаем.
- Backend (`src/`) не трогаем — его изменения принимаем как есть.

## После слияния — проверить

1. **Новые непереведённые строки** во vue-файлах:
   ```bash
   git diff <prev>..HEAD -- public/src/locales/ru.json    # что добавил upstream
   ```
   Upstream нередко добавляет русские строки сам (у него уже стоит наша инфраструктура vue-i18n).
   Просмотреть формулировки — машинный перевод иногда надо поправить
   (пример: пришло «CLI инициализация», естественнее «Инициализация CLI»).
2. **Сборка frontend** при изменениях в `public/src/`:
   ```bash
   cd public && npm run build
   ```
3. Голова `production` после слияния — это merge-коммит вида `Merge branch 'main' into production`.

## Важно

- `main` НЕ редактируем руками — только зеркало. Если `git merge --ff-only` не проходит,
  значит в `main` попал лишний коммит: разобраться, прежде чем форсить.
- Не делать PR в upstream прямо из `production` — туда попадёт форк-специфика
  (отдельный процесс через cherry-pick во временную ветку от `upstream/main`).
