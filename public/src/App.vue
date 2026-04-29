<template>
  <video id="video-background" autoplay loop muted>
    <source src="./assets/background.mp4" type="video/mp4">
  </video>

  <div class="locale-switcher">
    <select v-model="locale" @change="onLocaleChange" :title="t('lang.label')"
      class="rounded-xl border border-gray-200 bg-white/60 backdrop-blur-sm shadow-sm px-3 py-2 text-sm focus:border-indigo-500 focus:ring-indigo-500 focus:outline-none transition-all duration-300">
      <option value="ru">{{ t('lang.ru') }}</option>
      <option value="zh">{{ t('lang.zh') }}</option>
    </select>
  </div>

  <router-view></router-view>

</template>

<script setup>
import { useI18n } from 'vue-i18n'

const { t, locale } = useI18n()

const onLocaleChange = () => {
  localStorage.setItem('locale', locale.value)
}
</script>

<style lang="css" scoped>
body,
html {
  margin: 0;
  padding: 0;
  width: 100%;
  height: 100%;
  overflow: hidden;
  position: relative;
}

#video-background {
  position: fixed;
  top: 0;
  left: 0;
  width: 100%;
  height: 100%;
  z-index: -1000;
  object-fit: cover;
}

.locale-switcher {
  position: fixed;
  top: 12px;
  left: 12px;
  z-index: 50;
}
</style>
