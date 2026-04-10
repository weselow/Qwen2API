import { createApp } from 'vue'
import { createI18n } from 'vue-i18n'
import router from './routes/index.js'
import App from './App.vue'
import ru from './locales/ru.json'
import zh from './locales/zh.json'
import "./style.css"

const i18n = createI18n({
  locale: localStorage.getItem('locale') || 'ru',
  fallbackLocale: 'zh',
  messages: { ru, zh },
  globalInjection: true
})

createApp(App)
  .use(i18n)
  .use(router)
  .mount('#app')
