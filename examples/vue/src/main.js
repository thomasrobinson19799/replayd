import { createApp } from 'vue';
import { ReplaydVue } from '@replayd/vue';
import App from './App.vue';

createApp(App)
  .use(ReplaydVue, { dsn: import.meta.env.VITE_REPLAYD_DSN, release: 'vue-1.0.0', environment: 'example' })
  .mount('#app');
