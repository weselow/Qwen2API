# Экспертиза агента: Qwen2API форк

## 1. Vue 3 Composition API patterns without TypeScript or state management

### Контекст проекта
Проект использует Vue 3 с `<script setup>`, без TypeScript, без Pinia/Vuex. Все данные — локальный `ref()` внутри компонентов. API-вызовы напрямую через axios.

### Best practices

**ref vs reactive:**
- `ref()` для примитивов и объектов, которые могут быть переназначены целиком (наш случай — `settings`, `tokens`, `apiKey`)
- `reactive()` только для сложных объектов, которые никогда не переназначаются целиком
- В проекте правильно используется `ref()` везде — не менять

**Организация `<script setup>`:**
```
1. Импорты (vue, vue-i18n, axios, vue-router)
2. Composables (useI18n, useRouter)
3. Реактивное состояние (ref, computed)
4. Функции (обработчики, API-вызовы)
5. Lifecycle hooks (onMounted)
```

**Декомпозиция больших компонентов (dashboard.vue ~800 строк):**
- Выносить логику в composables: `useAccounts()`, `usePagination()`, `useBatchImport()`
- НЕ делать это в рамках задачи русификации — только если будем рефакторить отдельно
- Composable = файл в `public/src/composables/`, возвращает `{ refs, methods }`

```vue
<script setup>
import { useI18n } from 'vue-i18n'
import { useFeatureA } from './composables/featureA.js'

const { t, locale } = useI18n()
const { foo, bar } = useFeatureA()
</script>
```

**Без state management — паттерн:**
- Данные живут в компоненте, который ими владеет
- Между компонентами — props/emit или provide/inject
- Для глобального состояния (locale) — vue-i18n сам управляет через `locale.value`

### Ограничения
- НЕ добавлять TypeScript — проект на чистом JS, upstream тоже
- НЕ добавлять Pinia/Vuex — нет необходимости, 3 страницы
- НЕ добавлять компонентные библиотеки — Tailwind utilities достаточно

---

## 2. vue-i18n v9+ integration in Vue 3 with Composition API

### Setup (main.js)

```javascript
import { createApp } from 'vue'
import { createI18n } from 'vue-i18n'
import ru from './locales/ru.json'
import zh from './locales/zh.json'

const i18n = createI18n({
  locale: 'ru',                // русский по умолчанию
  fallbackLocale: 'zh',        // fallback на китайский (оригинал)
  messages: { ru, zh },
  globalInjection: true         // $t доступен во всех шаблонах
})

const app = createApp(App)
app.use(i18n)
app.mount('#app')
```

### Использование в компонентах

```vue
<script setup>
import { useI18n } from 'vue-i18n'

const { t, locale } = useI18n()

// Переключение языка
const switchLocale = () => {
  locale.value = locale.value === 'ru' ? 'zh' : 'ru'
  localStorage.setItem('locale', locale.value)
}
</script>

<template>
  <!-- Простая строка -->
  <h1>{{ t('auth.title') }}</h1>

  <!-- С параметрами (named interpolation) -->
  <p>{{ t('dash.totalItems', { n: totalItems }) }}</p>

  <!-- В атрибутах -->
  <input :placeholder="t('auth.placeholder')">

  <!-- В JS (alert, confirm) -->
  <button @click="() => alert(t('msg.deleteSuccess'))">...</button>
</template>
```

### Структура locale-файлов

```json
// locales/ru.json
{
  "auth": {
    "title": "Авторизация администратора",
    "placeholder": "Введите ключ администратора",
    "login": "Войти",
    "error": "Неверный API-ключ, попробуйте снова!"
  },
  "dash": {
    "addAccount": "Добавить аккаунт",
    "totalItems": "Всего: {n}"
  }
}
```

### Ключевые решения

- **globalInjection: true** — `$t()` доступен в шаблонах без импорта `useI18n` в каждом компоненте. Но в `<script>` секции всё равно нужен `useI18n()` для доступа к `t()` в JS-коде (alert, confirm, console)
- **Плоская структура ключей с namespace**: `auth.title`, `dash.addAccount`, `settings.save` — группировка по странице
- **Параметры через `{name}`**: `t('dash.totalItems', { n: 42 })` → "Всего: 42"
- **Locale persistence**: сохранять выбор в `localStorage`, читать при инициализации
- **fallbackLocale: 'zh'** — если строка не переведена, показываем китайский оригинал (а не пустоту)

### Паттерн для alert/confirm в JS

```javascript
// Было:
alert('apiKey 校验失败,请重新输入!')

// Стало:
const { t } = useI18n()
alert(t('auth.error'))
```

### Переключатель языка (компонент)

```vue
<select v-model="locale" class="...">
  <option value="ru">Русский</option>
  <option value="zh">中文</option>
</select>
```

Разместить в `settings.vue` или в шапке `App.vue`.

---

## 3. Tailwind CSS glassmorphism and utility-first styling constraints

### Контекст проекта
Проект использует паттерн glassmorphism: полупрозрачные карточки с blur-эффектом.

### Существующие паттерны (НЕ ЛОМАТЬ)

```
Карточки:    bg-white/30 backdrop-blur-md border border-white/30 rounded-2xl
Кнопки:      rounded-2xl bg-opacity-65 border-2 transition-transform active:scale-95 hover:scale-105
Инпуты:      rounded-2xl bg-opacity-80 bg-white border-2 border-gray-100 focus:shadow-lg focus:scale-105
Анимации:    transition-all duration-300, fade-slide (CSS custom)
Тени:        shadow-xl, shadow-lg
```

### Правила при добавлении UI-элементов

- **Переключатель языка** должен использовать те же паттерны: `rounded-xl`, `border`, `bg-white/60`, `transition-all`
- НЕ вводить новые цвета — использовать существующие (gray, blue, green, red, yellow, indigo)
- НЕ добавлять кастомный CSS если можно решить Tailwind-утилитами
- Сохранять адаптивность: `md:flex-row`, `md:grid-cols-2` уже используются

---

## 4. Git fork maintenance and upstream sync

### Стратегия

```bash
# Первоначальная настройка
git remote add upstream https://github.com/Rfym21/Qwen2API.git

# Синхронизация (периодически)
git fetch upstream
git merge upstream/main

# При конфликтах
# Наши изменения ТОЛЬКО в public/src/ — конфликты будут только там
# Стратегия: принять upstream, потом заново применить наши i18n-изменения
```

### Минимизация конфликтов

- **Не форматировать и не рефакторить upstream-код** — только добавлять i18n
- **Locale файлы (ru.json, zh.json)** — upstream их не трогает, конфликтов не будет
- **main.js** — единственная точка конфликта (добавление i18n). Минимальные изменения
- **vue-файлы** — замена строк на `$t()`. При upstream-обновлении проверять новые строки

### Отслеживание новых строк

После merge upstream:
```bash
# Найти китайские строки, не покрытые i18n
grep -rn '[\u4e00-\u9fff]' public/src/views/
```

---

## 5. Vite 5 build для Docker

### Текущая конфигурация
- Frontend собирается Vite в `public/dist/`
- Backend раздаёт статику из `public/dist/`
- В Docker сборка происходит при `npm run build` (вероятно в Dockerfile)

### Правила
- НЕ менять vite.config.js без необходимости
- Новые файлы (`locales/*.json`) подхватываются автоматически через import
- После добавления vue-i18n: проверить `npm run build` — bundle size вырастет на ~30KB (gzip)
