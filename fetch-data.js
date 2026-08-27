/* ============================================================
   Moons — Robot de datos (GitHub Actions)
   Dos cuentas (CO en COP, MX en MXN). Métrica: evento "Anticipo"
   (conversión personalizada 828103137997978), que mostramos como
   "deposito" y su costo como CPD. Convierte cada gasto a USD con la
   tasa histórica del mes de cada dato (fuente FX gratis, sin llave).
   ============================================================ */

const TOKEN = process.env.META_TOKEN;
const API = 'https://graph.facebook.com/v21.0';
const YEAR_START_MONDAY = '2025-12-29';
const CHUNK_WEEKS = 2;   // bloques más chicos: el campo "conversions" agranda el payload
const PREVIEW_MAX = 60;
const ANTICIPO_CC = '828103137997978';   // conversión personalizada = evento Anticipo
// --- Eventos del funnel (nombres del píxel personalizado) ---
const LEAD_EVENT     = 'Lead-Server';       // lead elegido (píxel personalizado; se lee del campo "conversions", que sí lo desglosa por nombre)
const VENTA_CC       = '1026494197833441';  // "Sale(Venta)" como conversión personalizada (se lee de "actions")
// "Checkout WebView" es una CONVERSIÓN PERSONALIZADA con id distinto por país (regla por URL):
//   MX -> checkout.mymoons.mx (id 278309118394084) ; CO -> checkout.mymoons.co (id 1406103876985688)
const ACCOUNTS = [
  { id: '285086213215776', country: 'CO', currency: 'cop', checkoutCC: '1406103876985688' },
  { id: '633488553830053', country: 'MX', currency: 'mxn', checkoutCC: '278309118394084' },
];

if (!TOKEN) { console.error('FALTA META_TOKEN'); process.exit(1); }

const sleep = ms => new Promise(r => setTimeout(r, ms));
function isoAddDays(iso, n){ const d = new Date(iso+'T00:00:00Z'); d.setUTCDate(d.getUTCDate()+n); return d.toISOString().slice(0,10); }
function todayISO(){ return new Date().toISOString().slice(0,10); }
function esNum(n, dec=0){ return Number(n).toLocaleString('de-DE', {minimumFractionDigits:dec, maximumFractionDigits:dec}); }
function fmtUSD(n){ return '$' + esNum(n, 2) + ' USD'; }

// Códigos que reintentamos: errores temporales de Meta + límites de velocidad
// (80000-80009 = "too many calls"; 4/17/32/613 = throttling de app/usuario/página).
const RETRYABLE = [1,2,4,17,32,341,368,613,80000,80001,80002,80003,80004,80005,80006,80008,80009];
async function graph(path, params, tries=6){
  const usp = new URLSearchParams({ ...params, access_token: TOKEN });
  let lastErr;
  for (let a=0; a<tries; a++){
    // backoff creciente ante bloqueos: 0s, 8s, 32s, 60s, 60s, 60s
    if (a) await sleep(Math.min(60000, a*a*8000));
    try{
      const res = await fetch(`${API}/${path}?${usp.toString()}`);
      const json = await res.json();
      if (json.error){
        lastErr = new Error(`Graph error: ${JSON.stringify(json.error).slice(0,300)}`);
        if (!RETRYABLE.includes(json.error.code)) throw lastErr;
        continue;
      }
      return json;
    }catch(e){ lastErr = e; }
  }
  throw lastErr;
}
async function graphAll(path, params){
  let rows = [], after = null;
  do{
    const p = { limit: 300, ...params };
    if (after) p.after = after;
    const json = await graph(path, p);
    if (json.data) rows = rows.concat(json.data);
    after = (json.paging && json.paging.next && json.paging.cursors) ? json.paging.cursors.after : null;
  } while (after);
  return rows;
}

/* ---------- Anticipo (deposito) ----------
   Se lee de la acción de la conversión personalizada del evento Anticipo.
   Exacto y consistente en ambas cuentas; sin sumas ni restas.            */
function anticipoValue(actions){
  if (!Array.isArray(actions)) return 0;
  const cc = actions.find(a => a.action_type === `offsite_conversion.custom.${ANTICIPO_CC}`);
  if (cc) return parseFloat(cc.value) || 0;
  const pc = actions.find(a => typeof a.action_type === 'string' && /fb_pixel_custom\.Anticipo$/i.test(a.action_type));
  return pc ? (parseFloat(pc.value) || 0) : 0;
}
function linkClicks(actions){
  if (!Array.isArray(actions)) return 0;
  const a = actions.find(x => x.action_type === 'link_click');
  return a ? (parseFloat(a.value)||0) : 0;
}
// --- Pasos del funnel ---
function landingViews(actions){
  if (!Array.isArray(actions)) return 0;
  const a = actions.find(x => x.action_type === 'landing_page_view');
  return a ? (parseFloat(a.value)||0) : 0;
}
// eventos personalizados del píxel: offsite_conversion.fb_pixel_custom.<Nombre>
function pixelCustom(actions, name){
  if (!Array.isArray(actions) || !name) return 0;
  const a = actions.find(x => x.action_type === `offsite_conversion.fb_pixel_custom.${name}`);
  return a ? (parseFloat(a.value)||0) : 0;
}
// conversión personalizada por id: offsite_conversion.custom.<id>
function customConv(actions, id){
  if (!Array.isArray(actions) || !id) return 0;
  const a = actions.find(x => x.action_type === `offsite_conversion.custom.${id}`);
  return a ? (parseFloat(a.value)||0) : 0;
}
// evento personalizado del píxel LEÍDO DEL CAMPO "conversions" (ahí sí viene desglosado por nombre,
// a diferencia de "actions", que los suma todos en offsite_conversion.fb_pixel_custom)
function pixelCustomConv(conversions, name){
  if (!Array.isArray(conversions) || !name) return 0;
  const a = conversions.find(x => x.action_type === `offsite_conversion.fb_pixel_custom.${name}`);
  return a ? (parseFloat(a.value)||0) : 0;
}
// conversaciones de WhatsApp iniciadas (evento onsite de mensajería, cualquier ventana)
function convStarted(actions){
  if (!Array.isArray(actions)) return 0;
  let s = 0;
  actions.forEach(a => { if (typeof a.action_type==='string' && /messaging_conversation_started/i.test(a.action_type)) s += parseFloat(a.value)||0; });
  return s;
}

/* ---------- Tipos de cambio (tasa del mes de cada dato) ---------- */
const fxCache = {}; // "YYYY-MM" -> { cop, mxn }
async function fetchFxForDate(date){
  const urls = [
    `https://cdn.jsdelivr.net/npm/@fawazahmed0/currency-api@${date}/v1/currencies/usd.json`,
    `https://${date}.currency-api.pages.dev/v1/currencies/usd.json`,
    `https://cdn.jsdelivr.net/npm/@fawazahmed0/currency-api@latest/v1/currencies/usd.json`,
  ];
  for (const u of urls){
    try{
      const r = await fetch(u);
      if (!r.ok) continue;
      const j = await r.json();
      if (j.usd && j.usd.cop && j.usd.mxn) return { cop: j.usd.cop, mxn: j.usd.mxn };
    }catch(e){}
  }
  throw new Error('No pude obtener tasa FX para '+date);
}
async function preloadFx(months){
  for (const m of months){
    if (!fxCache[m]) fxCache[m] = await fetchFxForDate(`${m}-15`);
  }
}
function toUSD(localSpend, month, currency){
  const rate = fxCache[month] ? fxCache[month][currency] : null;
  if (!rate) return 0;
  return (parseFloat(localSpend)||0) / rate;
}

const INSIGHT_FIELDS = 'ad_id,ad_name,adset_id,campaign_id,impressions,reach,spend,clicks,actions,conversions';

async function fetchInsights(accId, timeIncrement, since, until){
  const raw = await graphAll(`act_${accId}/insights`, {
    level: 'ad', fields: INSIGHT_FIELDS, time_increment: timeIncrement,
    time_range: JSON.stringify({ since, until }),
  });
  return raw.filter(r => (parseFloat(r.impressions)||0) > 0);
}

// --- UBICACIONES (placements): nivel campaña, desglose por plataforma + posición ---
const PLACEMENT_DAYS = 90;
const PLACEMENT_FIELDS = 'campaign_id,campaign_name,spend,impressions,clicks,actions,conversions';
async function fetchPlacements(accId, since, until){
  const raw = await graphAll(`act_${accId}/insights`, {
    level: 'campaign', fields: PLACEMENT_FIELDS,
    breakdowns: 'publisher_platform,platform_position',
    time_range: JSON.stringify({ since, until }),
  });
  return raw.filter(r => (parseFloat(r.impressions)||0) > 0);
}
function pathOf(name){ return /ctwa|whats?app/i.test(name||'') ? 'wa' : 'web'; }

function toReportRow(r, acc){
  const dep = anticipoValue(r.actions);
  const month = (r.date_start||'').slice(0,7);
  const usd = toUSD(r.spend, month, acc.currency);
  return {
    id: r.ad_id, name: r.ad_name, adset_id: r.adset_id, campaign_id: r.campaign_id,
    creative_id: null,
    country: acc.country,
    impressions: esNum(r.impressions),
    reach: esNum(r.reach || 0),
    amount_spent: fmtUSD(usd),
    clicks: esNum(r.clicks || 0),
    'actions:link_click': esNum(linkClicks(r.actions)),
    results: { value: `${dep} (deposito)` },
    onsite_conversion_lead_grouped: 'Not available',
    // --- pasos del funnel (números planos: el reporte los lee directo) ---
    ev: {
      landing:  landingViews(r.actions),
      lead:     pixelCustomConv(r.conversions, LEAD_EVENT),
      conv:     convStarted(r.actions),
      checkout: customConv(r.actions, acc.checkoutCC),
      venta:    customConv(r.actions, VENTA_CC),
      anticipo: dep,
    },
    date_start: r.date_start, date_stop: r.date_stop,
  };
}

(async () => {
  const today = todayISO();
  console.log('=== Robot Moons: inicio', new Date().toISOString(), '===');

  let weeklyRaw = [], monthlyRaw = [], placementsRaw = [];
  const campaigns = {}, adCreative = {}, creatives = {};

  for (const acc of ACCOUNTS){
    console.log(`--- Cuenta ${acc.country} (${acc.id}, ${acc.currency.toUpperCase()}) ---`);
    // WEEKLY por bloques
    let start = YEAR_START_MONDAY;
    while (start <= today){
      const end = isoAddDays(start, CHUNK_WEEKS*7 - 1);
      const until = end < today ? end : today;
      const rows = await fetchInsights(acc.id, '7', start, until);
      rows.forEach(r => r.__acc = acc);
      weeklyRaw = weeklyRaw.concat(rows);
      start = isoAddDays(start, CHUNK_WEEKS*7);
      await sleep(600); // pausa para no saturar el límite de Meta
    }
    // MONTHLY mes por mes
    { let y=2026, mo=1;
      while (true){
        const since = `${y}-${String(mo).padStart(2,'0')}-01`;
        if (since > today) break;
        const lastDay = new Date(Date.UTC(y, mo, 0)).getUTCDate();
        let until = `${y}-${String(mo).padStart(2,'0')}-${String(lastDay).padStart(2,'0')}`;
        if (until > today) until = today;
        const rows = await fetchInsights(acc.id, 'monthly', since, until);
        rows.forEach(r => r.__acc = acc);
        monthlyRaw = monthlyRaw.concat(rows);
        mo++; if (mo>12){ mo=1; y++; }
        await sleep(600); // pausa para no saturar el límite de Meta
      }
    }
    // Campañas + creativos de esta cuenta
    (await graphAll(`act_${acc.id}/campaigns`, { fields:'id,name' })).forEach(c => { campaigns[String(c.id)] = c.name; });
    (await graphAll(`act_${acc.id}/ads`, { fields:'id,creative{id,thumbnail_url,body,title}', limit: 40 })).forEach(a => {
      if (a.creative && a.creative.id){
        adCreative[String(a.id)] = String(a.creative.id);
        creatives[String(a.creative.id)] = { thumb:a.creative.thumbnail_url||null, body:a.creative.body||null, title:a.creative.title||null };
      }
    });
    // UBICACIONES: últimos 90 días, una consulta por cuenta con desglose de placement
    { const plStart = isoAddDays(today, -PLACEMENT_DAYS);
      const plRows = await fetchPlacements(acc.id, plStart, today);
      plRows.forEach(r => r.__acc = acc);
      placementsRaw = placementsRaw.concat(plRows);
      await sleep(600);
    }
  }
  console.log('Weekly filas:', weeklyRaw.length, '| Monthly filas:', monthlyRaw.length, '| Placements filas:', placementsRaw.length);

  // Tasas FX de todos los meses presentes
  const months = [...new Set(weeklyRaw.concat(monthlyRaw).map(r => (r.date_start||'').slice(0,7)).filter(Boolean))].sort();
  console.log('Cargando tasas FX de', months.length, 'meses...');
  await preloadFx(months);
  months.forEach(m => console.log(`FX ${m}: 1 USD = ${fxCache[m].cop.toFixed(1)} COP · ${fxCache[m].mxn.toFixed(2)} MXN`));

  // A formato reporte
  const weekly = weeklyRaw.map(r => { const o = toReportRow(r, r.__acc); o.creative_id = adCreative[String(r.ad_id)]||null; return o; });
  const monthly = monthlyRaw.map(r => { const o = toReportRow(r, r.__acc); o.creative_id = adCreative[String(r.ad_id)]||null; return o; });

  // A formato ubicaciones: FX del mes más reciente (aprox. para la ventana de 90 días)
  const latestMonth = months[months.length-1];
  const placements = placementsRaw.map(r => {
    const acc = r.__acc;
    return {
      campaign_id: String(r.campaign_id||''),
      campaign_name: r.campaign_name || campaigns[String(r.campaign_id)] || ('Campaña '+r.campaign_id),
      country: acc.country,
      path: pathOf(r.campaign_name),
      platform: r.publisher_platform || '(s/d)',
      position: r.platform_position || '(s/d)',
      spendUSD: toUSD(r.spend, latestMonth, acc.currency),
      impressions: parseFloat(r.impressions)||0,
      clicks: parseFloat(r.clicks)||0,
      landing: landingViews(r.actions),
      lead: pixelCustomConv(r.conversions, LEAD_EVENT),
      conv: convStarted(r.actions),
      checkout: customConv(r.actions, acc.checkoutCC),
      anticipo: anticipoValue(r.actions),
    };
  }).filter(p => p.impressions > 0);

  // --- VALIDACIÓN: última semana completa, por país (anticipos + gasto USD) ---
  const lastFullWeek = (() => {
    const d = new Date(today+'T00:00:00Z'); const day=(d.getUTCDay()+6)%7; d.setUTCDate(d.getUTCDate()-day-7);
    return d.toISOString().slice(0,10);
  })();
  for (const c of ['CO','MX']){
    let dep=0, usd=0;
    weekly.filter(r => r.country===c && r.date_start===lastFullWeek).forEach(r => {
      dep += parseFloat(String(r.results.value))||0;
      usd += parseFloat(r.amount_spent.replace(/[^\d,.-]/g,'').replace(/\./g,'').replace(/,/g,'.'))||0;
    });
    console.log(`>>> VALIDACION ${c} semana ${lastFullWeek}: depositos=${dep} | gasto=$${usd.toFixed(0)} USD | CPD=$${dep?(usd/dep).toFixed(2):'-'}`);
  }

  // --- DIAGNÓSTICO: todos los eventos (action_types) vistos en la última semana completa ---
  // Sirve para hallar el nombre exacto del Checkout y confirmar las conversaciones de WhatsApp.
  for (const c of ['CO','MX']){
    const tally = {};
    weeklyRaw.filter(r => r.__acc.country===c && r.date_start===lastFullWeek).forEach(r => {
      (r.actions||[]).forEach(a => { tally[a.action_type] = (tally[a.action_type]||0) + (parseFloat(a.value)||0); });
    });
    console.log(`>>> EVENTOS ${c} semana ${lastFullWeek} (action_type = total):`);
    Object.entries(tally).sort((a,b)=>b[1]-a[1]).forEach(([k,v]) => console.log(`     ${k} = ${Math.round(v)}`));
  }

  // --- VALIDACIÓN DEL FUNNEL: suma de cada paso en la última semana completa ---
  for (const c of ['CO','MX']){
    let landing=0, lead=0, conv=0, chk=0, vta=0;
    weekly.filter(r => r.country===c && r.date_start===lastFullWeek).forEach(r => {
      landing+=r.ev.landing; lead+=r.ev.lead; conv+=r.ev.conv; chk+=r.ev.checkout; vta+=r.ev.venta;
    });
    console.log(`>>> FUNNEL ${c} semana ${lastFullWeek}: landing=${landing} | lead=${lead} | conversaciones=${conv} | checkout=${chk} | venta=${vta}`);
  }

  // --- DIAGNÓSTICO UBICACIONES: combos plataforma/posición con más depósitos (últimos 90 días) ---
  { const tally = {};
    placements.forEach(p => { const k = `${p.country} ${p.platform}/${p.position}`; tally[k] = (tally[k]||0) + p.anticipo; });
    console.log(`>>> UBICACIONES (${PLACEMENT_DAYS}d) — top combos por depósitos:`);
    Object.entries(tally).sort((a,b)=>b[1]-a[1]).slice(0,20).forEach(([k,v]) => console.log(`     ${k} = ${Math.round(v)} dep`));
  }

  // Previews de los anuncios con más gasto (últimas 6 semanas)
  const sixWeeksAgo = isoAddDays(today, -42);
  const spendByAd = {};
  weeklyRaw.forEach(r => { if ((r.date_start||'') >= sixWeeksAgo) spendByAd[r.ad_id] = (spendByAd[r.ad_id]||0) + toUSD(r.spend, (r.date_start||'').slice(0,7), r.__acc.currency); });
  const topAds = Object.entries(spendByAd).sort((a,b)=>b[1]-a[1]).slice(0, PREVIEW_MAX).map(x=>x[0]);
  const previews = {};
  for (const adId of topAds){
    try{
      const json = await graph(`${adId}/previews`, { ad_format: 'MOBILE_FEED_STANDARD' });
      const body = json.data && json.data[0] && json.data[0].body;
      if (body){ const m = body.match(/src="([^"]+)"/); if (m) previews[adId] = m[1].replace(/&amp;/g,'&'); }
    }catch(e){}
  }
  console.log('Previews:', Object.keys(previews).length);

  const now = new Date();
  const generated = `${String(now.getUTCDate()).padStart(2,'0')}/${String(now.getUTCMonth()+1).padStart(2,'0')}/${now.getUTCFullYear()} ${String(now.getUTCHours()).padStart(2,'0')}:${String(now.getUTCMinutes()).padStart(2,'0')} UTC`;
  const snap = { generated, campaigns, weekly, monthly, creatives, previews, placements };
  require('fs').writeFileSync('futura-data.js', 'window.__FUTURA_SNAPSHOT__=' + JSON.stringify(snap) + ';');
  console.log('=== futura-data.js generado | weekly:', weekly.length, '| placements:', placements.length, '| generated:', generated, '===');
})().catch(e => { console.error('ERROR FATAL:', e); process.exit(1); });
