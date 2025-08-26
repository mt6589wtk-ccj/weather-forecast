<template>
  <div class="weather-app">
    <h1>天氣變化通知</h1>

    <label>定位方式：</label>
    <select v-model="locationMethod" @change="onLocationMethodChange">
      <option value="geo">瀏覽器定位 (GPS)</option>
      <option value="manual">手動輸入城市或郵遞區號</option>
      <option value="ip">IP位址推估位置</option>
    </select>

    <div v-if="locationMethod === 'manual'">
      <input v-model="locationInput" placeholder="請輸入城市或郵遞區號" />
    </div>

    <button @click="fetchWeather">手動刷新</button>
    <button @click="testNotify" style="margin-left:8px;">測試通知</button>

    <p>溫度：{{ temp }}</p>
    <p>狀態：{{ desc }}</p>
    <p v-if="rainProb !== null">降雨機率：{{ rainProb }}%</p>
    <p class="error" v-if="error">錯誤：{{ error }}</p>
    <div v-if="geoDenied && locationMethod === 'geo'" style="margin-top:8px;">
      <small>GPS 權限被拒。可前往瀏覽器設定允許定位，或改用 IP 定位作為備援。</small>
      <div style="margin-top:6px;">
        <button @click="useIpFallback">改用 IP 定位</button>
      </div>
    </div>
    <div v-if="insecureContext" style="margin-top:8px;">
      <small>目前非安全環境（HTTP）會導致 GPS 被阻擋。請改用擴充功能 Popup 或在 HTTPS 下開發。</small>
    </div>
  </div>
</template>

<script setup>
import { ref, onMounted, onBeforeUnmount, watch } from 'vue';

const API_KEY = "831a800279d7ba8672e905415ea54ec8";

const temp = ref('');
const desc = ref('');
const rainProb = ref(null);
const error = ref('');
const locationMethod = ref('geo');
const locationInput = ref('');
const geoDenied = ref(false);
const insecureContext = ref(false);

let autoRefreshInterval = null;
const NOTIFY_DEDUP_WINDOW_MS = 45 * 60 * 1000; // 45 分鐘

function shouldNotifyChange(currDesc, nextDesc, currTemp, nextTemp) {
  try {
    const key = `${currDesc}|${Math.round(currTemp)}|${nextDesc}|${Math.round(nextTemp)}`;
    const itemRaw = localStorage.getItem('lastNotify');
    const now = Date.now();
    if (itemRaw) {
      const item = JSON.parse(itemRaw);
      if (item && item.key === key && typeof item.time === 'number' && (now - item.time) < NOTIFY_DEDUP_WINDOW_MS) {
        return false;
      }
    }
    localStorage.setItem('lastNotify', JSON.stringify({ key, time: now }));
    // 同步一份給背景腳本去重使用（允許失敗）
    if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) {
      chrome.storage.local.set({ lastNotify: { key, time: now } });
    }
    return true;
  } catch {
    return true;
  }
}

function notifyWeatherChange(currDesc, nextDesc, currTemp, nextTemp) {
  const iconUrl = (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.getURL)
    ? chrome.runtime.getURL('favicon.ico')
    : '/favicon.ico';
  if (Notification.permission === "granted") {
    new Notification("天氣即將變化", {
      body: `目前：${currDesc} ${Math.round(currTemp)}°C\n1小時後：${nextDesc} ${Math.round(nextTemp)}°C`,
      icon: iconUrl
    });
  } else if (Notification.permission !== "denied") {
    Notification.requestPermission().then(permission => {
      if (permission === "granted") {
        new Notification("天氣即將變化", {
          body: `目前：${currDesc} ${Math.round(currTemp)}°C\n1小時後：${nextDesc} ${Math.round(nextTemp)}°C`,
          icon: iconUrl
        });
      }
    });
  }
}

function testNotify() {
  const iconUrl = (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.getURL)
    ? chrome.runtime.getURL('favicon.ico')
    : '/favicon.ico';
  const show = () => new Notification('通知測試', { body: '這是一則測試通知。', icon: iconUrl });
  try {
    if (Notification.permission === 'granted') {
      show();
    } else if (Notification.permission !== 'denied') {
      Notification.requestPermission().then(p => {
        if (p === 'granted') show();
        else error.value = '未授權通知權限，請在瀏覽器允許通知。';
      });
    } else {
      error.value = '未授權通知權限，請在瀏覽器允許通知。';
    }
  } catch {
    error.value = '通知顯示失敗。';
  }
}

async function saveSettings(partial = {}) {
  try {
    if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) {
      const settings = { locationMethod: locationMethod.value, locationInput: locationInput.value, ...partial };
      chrome.storage.local.set({ settings });
    }
  } catch {}
}

async function loadSettings() {
  try {
    if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) {
      chrome.storage.local.get(['settings'], res => {
        if (res && res.settings) {
          if (res.settings.locationMethod) locationMethod.value = res.settings.locationMethod;
          if (typeof res.settings.locationInput === 'string') locationInput.value = res.settings.locationInput;
        }
      });
    }
  } catch {}
}

async function persistLastKnown(lat, lon) {
  try {
    if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) {
      chrome.storage.local.set({ lastKnown: { lat, lon, time: Date.now(), method: locationMethod.value } });
    }
  } catch {}
}

function useIpFallback() {
  locationMethod.value = 'ip';
  saveSettings();
  fetchWeather();
}

async function fetchWeatherByCoords(lat, lon) {
  error.value = '';
  temp.value = '...';
  desc.value = '...';
  rainProb.value = null;
  try {
    const url = `https://api.openweathermap.org/data/2.5/weather?lat=${lat}&lon=${lon}&appid=${API_KEY}&units=metric&lang=zh_tw`;
    const res = await fetch(url);
    const data = await res.json();
    if (data.cod !== 200) {
      error.value = "找不到指定地點的天氣資料。";
      temp.value = '';
      desc.value = '';
      rainProb.value = null;
      return;
    }
    temp.value = `${Math.round(data.main.temp)}°C`;
    desc.value = data.weather[0].description;
    await fetchForecastAndNotify(data, lat, lon);
    // 保存座標供背景使用
    persistLastKnown(lat, lon);
  } catch {
    error.value = "無法取得天氣資料，請稍後再試。";
    temp.value = '';
    desc.value = '';
    rainProb.value = null;
  }
}

async function fetchWeatherByQuery(query) {
  if (!query) {
    error.value = "請輸入城市或郵遞區號。";
    temp.value = '';
    desc.value = '';
    rainProb.value = null;
    return;
  }
  try {
    const geoUrl = `https://api.openweathermap.org/geo/1.0/direct?q=${encodeURIComponent(query)}&limit=1&appid=${API_KEY}`;
    const res = await fetch(geoUrl);
    const geoData = await res.json();
    if (!geoData || geoData.length === 0) {
      error.value = "找不到指定地點的天氣資料。";
      temp.value = '';
      desc.value = '';
      rainProb.value = null;
      return;
    }
    await fetchWeatherByCoords(geoData[0].lat, geoData[0].lon);
  } catch {
    error.value = "無法取得地理資訊。";
    temp.value = '';
    desc.value = '';
    rainProb.value = null;
  }
}

async function fetchForecastAndNotify(currentData, lat, lon) {
  try {
    const oneCallUrl = `https://api.openweathermap.org/data/3.0/onecall?lat=${lat}&lon=${lon}&exclude=minutely,daily,alerts&appid=${API_KEY}&units=metric&lang=zh_tw`;
    const res = await fetch(oneCallUrl);
    const oc = await res.json();
    if (!oc || !oc.hourly || oc.hourly.length < 2) throw new Error('no-hourly');
    const next = oc.hourly[1];
    if (!next || !next.weather || !next.weather[0] || typeof next.temp !== 'number') return;
    rainProb.value = next.pop !== undefined ? Math.round(next.pop * 100) : null;
    const currMain = currentData.weather[0].main;
    const currTemp = currentData.main.temp;
    const currDesc = currentData.weather[0].description;
    const nextMain = next.weather[0].main;
    const nextTemp = next.temp;
    const nextDesc = next.weather[0].description;
    if ((currMain !== nextMain || Math.abs(currTemp - nextTemp) >= 2) && shouldNotifyChange(currDesc, nextDesc, currTemp, nextTemp)) {
      notifyWeatherChange(currDesc, nextDesc, currTemp, nextTemp);
    }
  } catch {
    rainProb.value = null;
    await fetchForecastAndNotifyFallback3h(currentData, lat, lon);
  }
}

async function fetchForecastAndNotifyFallback3h(currentData, lat, lon) {
  try {
    const forecastUrl = `https://api.openweathermap.org/data/2.5/forecast?lat=${lat}&lon=${lon}&appid=${API_KEY}&units=metric&lang=zh_tw`;
    const res = await fetch(forecastUrl);
    const forecastData = await res.json();
    if (forecastData.cod !== "200" || !forecastData.list || forecastData.list.length === 0) return;
    const next = forecastData.list[0];
    if (!next) return;
    rainProb.value = next.pop !== undefined ? Math.round(next.pop * 100) : null;
    const currMain = currentData.weather[0].main;
    const nextMain = next.weather[0].main;
    const currTemp = currentData.main.temp;
    const nextTemp = next.main.temp;
    const currDesc = currentData.weather[0].description;
    const nextDesc = next.weather[0].description;
    if ((currMain !== nextMain || Math.abs(currTemp - nextTemp) >= 2) && shouldNotifyChange(currDesc, nextDesc, currTemp, nextTemp)) {
      notifyWeatherChange(currDesc, nextDesc, currTemp, nextTemp);
    }
  } catch {
    rainProb.value = null;
  }
}

function fetchWeather() {
  error.value = '';
  temp.value = '...';
  desc.value = '...';
  rainProb.value = null;
  geoDenied.value = false;

  // 保存目前設定
  saveSettings();

  if (locationMethod.value === 'geo') {
    if (!window.isSecureContext) {
      insecureContext.value = true;
      error.value = '目前非安全環境（HTTP），GPS 被阻擋。請改用擴充功能 Popup 或 HTTPS。';
      return;
    }
    insecureContext.value = false;
    if (navigator.geolocation) {
      navigator.geolocation.getCurrentPosition(pos => {
        persistLastKnown(pos.coords.latitude, pos.coords.longitude);
        fetchWeatherByCoords(pos.coords.latitude, pos.coords.longitude);
      }, (e) => {
        geoDenied.value = (e && e.code === e.PERMISSION_DENIED);
        error.value = '無法取得定位，請允許權限或改用其他定位方式。';
      });
    } else {
      error.value = '瀏覽器不支援定位功能。';
    }
  } else if (locationMethod.value === 'manual') {
    fetchWeatherByQuery(locationInput.value.trim());
  } else if (locationMethod.value === 'ip') {
    fetch("https://ipapi.co/json/")
        .then(res => res.json())
        .then(data => {
          if (data && data.latitude && data.longitude) {
            persistLastKnown(data.latitude, data.longitude);
            fetchWeatherByCoords(data.latitude, data.longitude);
          } else {
            error.value = "無法取得IP定位，請嘗試其他定位方式。";
            temp.value = '';
            desc.value = '';
            rainProb.value = null;
          }
        })
        .catch(() => {
          error.value = "IP定位服務無法使用。";
          temp.value = '';
          desc.value = '';
          rainProb.value = null;
        });
  }
}

function onLocationMethodChange() {
  error.value = '';
  geoDenied.value = false;
  saveSettings();
}

onMounted(() => {
  loadSettings();
  // 預檢 geolocation 權限
  try {
    if (navigator.permissions && navigator.permissions.query) {
      navigator.permissions.query({ name: 'geolocation' }).then(result => {
        geoDenied.value = (result.state === 'denied');
        result.onchange = () => { geoDenied.value = (result.state === 'denied'); };
      }).catch(() => {});
    }
  } catch {}

  fetchWeather();
  if (autoRefreshInterval) clearInterval(autoRefreshInterval);
  autoRefreshInterval = setInterval(fetchWeather, 10 * 60 * 1000); // 每10分鐘自動刷新
});

watch(locationInput, () => saveSettings());

onBeforeUnmount(() => {
  if (autoRefreshInterval) clearInterval(autoRefreshInterval);
});
</script>

<style scoped>
.weather-app {
  font-family: Arial, sans-serif;
  max-width: 400px;
  margin: 20px auto;
  padding: 20px;
  border: 1px solid #ccc;
  border-radius: 8px;
}
.error {
  color: red;
}
</style>
