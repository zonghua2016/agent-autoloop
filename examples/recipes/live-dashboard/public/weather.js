const REFRESH = 15*60*1000;
const EXPIRE = 60*60*1000;
const cities = {
  beijing:{name:'北京',latitude:39.90,longitude:116.41,zone:'Asia/Shanghai'},
  shanghai:{name:'上海',latitude:31.23,longitude:121.47,zone:'Asia/Shanghai'},
  guangzhou:{name:'广州',latitude:23.13,longitude:113.26,zone:'Asia/Shanghai'},
  shenzhen:{name:'深圳',latitude:22.54,longitude:114.06,zone:'Asia/Shanghai'},
  hangzhou:{name:'杭州',latitude:30.27,longitude:120.16,zone:'Asia/Shanghai'},
  chengdu:{name:'成都',latitude:30.57,longitude:104.07,zone:'Asia/Shanghai'},
  wuhan:{name:'武汉',latitude:30.59,longitude:114.30,zone:'Asia/Shanghai'},
  xian:{name:'西安',latitude:34.34,longitude:108.94,zone:'Asia/Shanghai'},
  harbin:{name:'哈尔滨',latitude:45.80,longitude:126.53,zone:'Asia/Shanghai'}
};
const forecasts = {
  0:'clear',1:'clear',2:'cloud',3:'overcast',45:'fog',48:'fog',
  51:'rain',53:'rain',55:'rain',56:'rain',57:'rain',61:'rain',63:'rain',65:'rain',66:'rain',67:'rain',
  71:'snow',73:'snow',75:'snow',77:'snow',80:'rain',81:'rain',82:'rain',85:'snow',86:'snow',
  95:'storm',96:'storm',97:'storm',99:'storm'
};
const names={clear:'晴',cloud:'多云',overcast:'阴',fog:'雾',rain:'雨',snow:'雪',storm:'雷雨',unknown:'天气未更新'};
const previews={
  day:{kind:'clear',night:false},
  night:{kind:'clear',night:true},
  cloud:{kind:'cloud',night:false},
  rain:{kind:'rain',night:false},
  snow:{kind:'snow',night:false}
};
const formatters=new Map();
function clock(value,zone) {
  if(!formatters.has(zone))formatters.set(zone,new Intl.DateTimeFormat('zh-CN',{hour:'2-digit',minute:'2-digit',hourCycle:'h23',timeZone:zone}));
  return formatters.get(zone).format(value);
}
function followDay(report,now,zone) {
  const time=now/1000;
  if(report) {
    const {time:days,sunrise,sunset}=report.daily??{};
    const today=days?.findLastIndex(day=>day<=time)??-1;
    if(today>=0&&time<(days[today+1]??days[today]+86400)&&Number.isFinite(sunrise?.[today])&&Number.isFinite(sunset?.[today])) {
      return time<sunrise[today]||time>=sunset[today];
    }
    if(Math.abs(time-report.current.time)<1800&&[0,1].includes(report.current.is_day)) return report.current.is_day===0;
  }
  const hour=Number(clock(now,zone).slice(0,2));
  return hour<6||hour>=18;
}
function savedCity() {
  try {return localStorage.getItem('autoloop-weather-city');} catch {return null;}
}
export function connectWeather(onChange) {
  const select=document.getElementById('weather-city');
  const locate=document.getElementById('weather-location');
  const clockEl=document.getElementById('clock');
  const label=document.getElementById('weather-label');
  const note=document.getElementById('weather-note');
  const buttons=[...document.querySelectorAll('[data-weather]')];
  const remote=document.getElementById('weather-remote');
  try{remote.checked=localStorage.getItem('autoloop-weather-remote')!=='off';}catch{}
  remote.addEventListener('change',()=>{try{localStorage.setItem('autoloop-weather-remote',remote.checked?'on':'off');}catch{}if(!remote.checked){serial++;data=null;inFlight=false;}render();if(remote.checked)refresh(true);});
  let cityId=savedCity()??'beijing';
  if(!Object.hasOwn(cities,cityId))cityId='beijing';
  let place=cities[cityId], mode='auto', data=null, fetchedAt=0, lastAttempt=0;
  let serial=0, inFlight=false, locationNote='', geoRequest=0;
  for(const [id,city] of Object.entries(cities)) {
    const option=document.createElement('option');option.value=id;option.textContent=city.name;select.append(option);
  }
  select.value=cityId;
  locate.hidden=!navigator.geolocation;

  function render() {
    const now=Date.now();
    const fresh=data&&now-fetchedAt<=EXPIRE?data:null;
    const zone=fresh?.timezone||place.zone;
    const localNight=followDay(fresh,now,zone);
    const kind=fresh?forecasts[fresh.current.weather_code]??'unknown':'unknown';
    const temperature=fresh?.current.temperature_2m;
    const preview=previews[mode];
    const state=preview??{kind,night:localNight};
    clockEl.textContent=clock(now,zone);
    label.textContent=preview?'预览 · '+names[state.kind]+' · '+(state.night?'夜间':'日间')
      :place.name+' · '+names[kind]+(Number.isFinite(temperature)?' '+Math.round(temperature)+'°':'');
    note.textContent=locationNote||(preview?'场景预览中'
      :fresh?(!inFlight&&lastAttempt>fetchedAt?'显示上次更新':'按城市日出日落切换')
        :inFlight?'正在获取天气':'仅按城市时间切换昼夜');
    onChange(state);
  }
  async function refresh(force=false) {
    if(!remote.checked)return;
    if((inFlight||Date.now()-lastAttempt<REFRESH)&&!force)return;
    const id=++serial;
    inFlight=true;lastAttempt=Date.now();render();
    const params=new URLSearchParams({
      latitude:String(place.latitude),longitude:String(place.longitude),timezone:'auto',timeformat:'unixtime',
      current:'weather_code,temperature_2m,is_day',daily:'sunrise,sunset',forecast_days:'2'
    });
    try {
      const response=await fetch('https://api.open-meteo.com/v1/forecast?'+params,{signal:AbortSignal.timeout(9000),credentials:'omit'});
      if(!response.ok)throw Error('Weather request failed');
      const report=await response.json();
      if(!Number.isFinite(report.current?.weather_code)||typeof report.timezone!=='string')throw Error('Incomplete weather report');
      clock(Date.now(),report.timezone);
      if(id===serial){data=report;fetchedAt=Date.now();}
    } catch {
      // Keep the most recent valid report until it expires.
    } finally {
      if(id===serial){inFlight=false;render();}
    }
  }
  function setMode(value) {
    mode=value;
    for(const control of buttons)control.setAttribute('aria-pressed',String(control.dataset.weather===mode));
    render();
  }
  for(const button of buttons)button.addEventListener('click',()=>{
    setMode(button.dataset.weather);
    if(mode==='auto')refresh();
  });
  function changePlace(next) {
    place=next;data=null;fetchedAt=0;locationNote='';setMode('auto');refresh(true);
  }
  select.addEventListener('change',()=>{
    if(!Object.hasOwn(cities,select.value))return;
    geoRequest++;
    locate.disabled=false;
    select.querySelector('[value="nearby"]')?.remove();
    cityId=select.value;
    try {localStorage.setItem('autoloop-weather-city',cityId);} catch {}
    changePlace(cities[cityId]);
  });
  locate.addEventListener('click',()=>{
    const request=++geoRequest;
    locate.disabled=true;
    locationNote='正在获取大致位置';render();
    navigator.geolocation.getCurrentPosition(position=>{
      if(request!==geoRequest)return;
      const {latitude,longitude}=position.coords;
      let local=select.querySelector('[value="nearby"]');
      if(!local){
        local=document.createElement('option');local.value='nearby';local.textContent='当前位置';select.append(local);
      }
      select.value='nearby';locate.disabled=false;
      changePlace({name:'当前位置',latitude:Math.round(latitude*10)/10,longitude:Math.round(longitude*10)/10,
        zone:Intl.DateTimeFormat().resolvedOptions().timeZone});
    },()=>{
      if(request!==geoRequest)return;
      locate.disabled=false;locationNote='定位不可用，请从列表选择城市';render();
    },{enableHighAccuracy:false,timeout:7000,maximumAge:600000});
  });
  setInterval(()=>{if(!document.hidden){render();refresh();}},15000);
  document.addEventListener('visibilitychange',()=>{if(!document.hidden){render();refresh();}});
  addEventListener('online',()=>refresh(true));
  render();refresh(true);
}
