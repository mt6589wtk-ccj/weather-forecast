const API_KEY = "831a800279d7ba8672e905415ea54ec8";
const NOTIFY_DEDUP_WINDOW_MS = 45 * 60 * 1000; // 45 分鐘

async function fetchJSON(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

function buildKey(currDesc, nextDesc, currTemp, nextTemp) {
  return `${currDesc}|${Math.round(currTemp)}|${nextDesc}|${Math.round(nextTemp)}`;
}

function createNotification(currDesc, nextDesc, currTemp, nextTemp) {
  const iconUrl = chrome.runtime.getURL('favicon.ico');
  chrome.notifications.create('', {
    type: 'basic',
    iconUrl,
    title: '天氣即將變化',
    message: `目前：${currDesc} ${Math.round(currTemp)}°C\n1小時後：${nextDesc} ${Math.round(nextTemp)}°C`,
    priority: 1
  });
}

async function shouldNotify(currDesc, nextDesc, currTemp, nextTemp) {
  const key = buildKey(currDesc, nextDesc, currTemp, nextTemp);
  return new Promise(resolve => {
    chrome.storage.local.get(['lastNotify'], data => {
      try {
        const now = Date.now();
        const item = data && data.lastNotify ? data.lastNotify : null;
        if (item && item.key === key && typeof item.time === 'number' && (now - item.time) < NOTIFY_DEDUP_WINDOW_MS) {
          resolve(false);
          return;
        }
        chrome.storage.local.set({ lastNotify: { key, time: now } }, () => resolve(true));
      } catch {
        resolve(true);
      }
    });
  });
}

async function geocode(query) {
  const url = `https://api.openweathermap.org/geo/1.0/direct?q=${encodeURIComponent(query)}&limit=1&appid=${API_KEY}`;
  const arr = await fetchJSON(url);
  if (!arr || !arr[0]) throw new Error('no-geo');
  return { lat: arr[0].lat, lon: arr[0].lon };
}

async function getCoordsFromSettings(settings, lastKnown) {
  const method = settings && settings.locationMethod ? settings.locationMethod : 'geo';
  if (method === 'manual' && settings && settings.locationInput) {
    const { lat, lon } = await geocode(settings.locationInput);
    chrome.storage.local.set({ lastKnown: { lat, lon, time: Date.now(), method } });
    return { lat, lon };
  }
  if (method === 'ip') {
    try {
      const ip = await fetchJSON('https://ipapi.co/json/');
      if (ip && ip.latitude && ip.longitude) {
        const lat = ip.latitude; const lon = ip.longitude;
        chrome.storage.local.set({ lastKnown: { lat, lon, time: Date.now(), method } });
        return { lat, lon };
      }
    } catch {}
  }
  // geo 或其他：優先使用 lastKnown，否則退回 IP
  if (lastKnown && typeof lastKnown.lat === 'number' && typeof lastKnown.lon === 'number') {
    return { lat: lastKnown.lat, lon: lastKnown.lon };
  }
  try {
    const ip = await fetchJSON('https://ipapi.co/json/');
    if (ip && ip.latitude && ip.longitude) {
      const lat = ip.latitude; const lon = ip.longitude;
      chrome.storage.local.set({ lastKnown: { lat, lon, time: Date.now(), method: 'ip' } });
      return { lat, lon };
    }
  } catch {}
  throw new Error('no-coords');
}

async function fetchCurrent(lat, lon) {
  const url = `https://api.openweathermap.org/data/2.5/weather?lat=${lat}&lon=${lon}&appid=${API_KEY}&units=metric&lang=zh_tw`;
  const data = await fetchJSON(url);
  if (!data || data.cod !== 200) throw new Error('bad-current');
  return data;
}

async function fetchNextHourOr3h(lat, lon) {
  try {
    const oneCallUrl = `https://api.openweathermap.org/data/3.0/onecall?lat=${lat}&lon=${lon}&exclude=minutely,daily,alerts&appid=${API_KEY}&units=metric&lang=zh_tw`;
    const oc = await fetchJSON(oneCallUrl);
    if (oc && oc.hourly && oc.hourly[1]) {
      return { source: 'onecall', item: oc.hourly[1] };
    }
    throw new Error('no-hourly');
  } catch {
    const forecastUrl = `https://api.openweathermap.org/data/2.5/forecast?lat=${lat}&lon=${lon}&appid=${API_KEY}&units=metric&lang=zh_tw`;
    const fc = await fetchJSON(forecastUrl);
    if (fc && fc.cod === '200' && fc.list && fc.list[0]) {
      return { source: 'forecast', item: fc.list[0] };
    }
    throw new Error('no-forecast');
  }
}

async function tick() {
  try {
    const { settings, lastKnown } = await new Promise(resolve => chrome.storage.local.get(['settings', 'lastKnown'], resolve));
    const { lat, lon } = await getCoordsFromSettings(settings, lastKnown);
    const current = await fetchCurrent(lat, lon);
    const nextObj = await fetchNextHourOr3h(lat, lon);

    const currMain = current.weather[0].main;
    const currTemp = current.main.temp;
    const currDesc = current.weather[0].description;

    let nextMain, nextTemp, nextDesc;
    if (nextObj.source === 'onecall') {
      nextMain = nextObj.item.weather[0].main;
      nextTemp = nextObj.item.temp;
      nextDesc = nextObj.item.weather[0].description;
    } else {
      nextMain = nextObj.item.weather[0].main;
      nextTemp = nextObj.item.main.temp;
      nextDesc = nextObj.item.weather[0].description;
    }

    if ((currMain !== nextMain || Math.abs(currTemp - nextTemp) >= 2) && await shouldNotify(currDesc, nextDesc, currTemp, nextTemp)) {
      createNotification(currDesc, nextDesc, currTemp, nextTemp);
    }
  } catch (e) {
    // 靜默失敗，避免干擾
  }
}

chrome.runtime.onInstalled.addListener(() => {
  chrome.alarms.create('weatherTick', { periodInMinutes: 10 });
  tick();
});

chrome.runtime.onStartup.addListener(() => {
  chrome.alarms.create('weatherTick', { periodInMinutes: 10 });
  tick();
});

chrome.alarms.onAlarm.addListener(alarm => {
  if (alarm && alarm.name === 'weatherTick') tick();
});

