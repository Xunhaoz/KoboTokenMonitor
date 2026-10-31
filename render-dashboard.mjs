import { Resvg } from '@resvg/resvg-js';
import { readFile, writeFile, mkdir, rename } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { normalizeProvider, timestamp } from './usage-model.mjs';

// A fixed-resolution e-paper layout: no Chromium, remote fonts, or model calls.
const argv = process.argv.slice(2);
function option(name, fallback) {
  const index = argv.indexOf(name);
  if (index < 0) return fallback;
  if (!argv[index + 1] || argv[index + 1].startsWith('--')) throw Error(`Missing ${name}`);
  return argv[index + 1];
}
const input = option('--input', 'fixtures/usage.json');
const output = resolve(option('--output', 'output/usage.png'));
let records = [], inputError = null;
try {
  const raw = JSON.parse(await readFile(input, 'utf8'));
  if (!Array.isArray(raw) && (!raw || typeof raw !== 'object')) throw Error('Invalid input shape');
  records = (Array.isArray(raw) ? raw : [raw]).filter(r => r && typeof r === 'object');
} catch (error) {
  inputError = 'Unable to read usage data';
  console.error(`Usage input unavailable (${error.code || error.name}); rendering error state.`);
}
const stamps = records.map(r => timestamp(r.usage?.updatedAt)).filter(n => n !== null);
const at = option('--at', 'snapshot');
const now = at === 'now' ? new Date() : at === 'snapshot'
  ? new Date(stamps.length ? Math.max(...stamps) : Date.now()) : new Date(at);
if (!Number.isFinite(+now)) throw Error('Invalid --at timestamp');
const colors = { ink: '#171717', muted: '#555555', line: '#D3D3D3', track: '#EBEBEB',
  green: '#42836B', orange: '#B66E45', red: '#AE4940', rose: '#F8E9E5' };
const escape = value => String(value).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&apos;'}[c]));
const text = (x,y,value,size=32,weight=400,fill=colors.ink,anchor='start',extra='') =>
  `<text x="${x}" y="${y}" font-size="${size}" font-weight="${weight}" fill="${fill}" text-anchor="${anchor}" ${extra}>${escape(value)}</text>`;
const rect = (x,y,w,h,fill,rx=0) => `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="${rx}" fill="${fill}"/>`;
const rule = y => rect(64,y,944,2,colors.line);
const parts = date => Object.fromEntries(new Intl.DateTimeFormat('en-GB', {
  timeZone:'Asia/Taipei',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hourCycle:'h23'
}).formatToParts(date).map(p => [p.type,p.value]));
const date = parts(now);
const clock = stamp => { const p=parts(new Date(stamp));return `${p.hour}:${p.minute}`; };
function reset(stamp) {
  if (!stamp || !Number.isFinite(Date.parse(stamp))) return '重置時間未提供';
  if (Date.parse(stamp) <= +now) return '重置時間已到・等待新資料';
  const p=parts(new Date(stamp));
  return `${p.day===date.day && p.month===date.month && p.year===date.year?'今天':`${Number(p.month)}/${Number(p.day)}`} ${p.hour}:${p.minute} 重置`;
}
const percent = n => n===null?'—':`${Math.round(n)}%`;
function meter(x,y,width,height,n,color) {
  return rect(x,y,width,height,colors.track,2)+(n===null
    ? text(x+width/2,y+height/2+8,'無資料',21,400,colors.muted,'middle')
    : rect(x,y,width*n/100,height,color,2));
}
function provider(record,name,y,color) {
  const id = record.provider;
  const m=normalizeProvider([record],id,now,inputError);
  const {primary:pDisplay,secondary:sDisplay,updatedAt:measured,caption}=m;
  const weekFull=m.quotaReached;
  const alert=['error','authentication_required','stale','quota_reached'].includes(m.state);
  return `
    ${rect(64,y,10,360,color,2)}
    ${text(0,0,name,Math.min(44, 340 / Math.max(1, [...name].length)),500,colors.muted,'start',`transform="translate(104 ${y + 8}) rotate(90)"`)}
    ${text(200,y+30,'五小時額度',32)}
    ${text(1008,y+30,caption,26,500,alert?colors.red:colors.muted,'end')}
    ${text(200,y+160,percent(pDisplay),128,500)}
    ${text(1008,y+100,pDisplay===null?'等待有效資料':'已使用',28,400,colors.muted,'end')}
    ${text(1008,y+153,pDisplay===null?'—':reset(m.resetPrimary),29,400,colors.ink,'end')}
    ${meter(200,y+185,808,30,pDisplay,color)}
    ${text(200,y+270,'本週額度',32)}
    ${text(1008,y+270,sDisplay===null?'—':`${percent(sDisplay)} 已使用`,43,500,colors.ink,'end')}
    ${meter(200,y+295,808,22,sDisplay,weekFull?colors.red:color)}
    ${text(200,y+360,sDisplay===null?'等待下一次成功更新':reset(m.resetSecondary),27,400,colors.muted)}
    ${text(1008,y+360,measured!==null?`資料 ${parts(new Date(measured)).month}/${parts(new Date(measured)).day} ${clock(measured)}`:'更新時間未提供',24,400,colors.muted,'end')}
  `;
}
const cards = records.some(r => r.workerId)
  ? records
  : records.length === 0 && !inputError ? [] : ['codex', 'claude'].map(id => records.find(r => r.provider === id) || {provider:id});
const available = 1138;
const cell = available / Math.max(cards.length, 1);
const scale = Math.min(1, cell * 0.95 / 400);
const stack = cards.map((r, i) => {
  const name = r.name || (r.provider === 'codex' ? 'Codex' : 'Claude');
  const x = (1072 - 1072 * scale) / 2;
  const y = 222 + i * cell + (cell - 400 * scale) / 2;
  return `<g transform="translate(${x} ${y}) scale(${scale})">${provider(r, name, 20, r.provider === 'codex' ? colors.green : colors.orange)}</g>` + (i < cards.length - 1 ? rule(222 + (i + 1) * cell) : '');
}).join('');
const svg=`<svg xmlns="http://www.w3.org/2000/svg" width="1072" height="1448" viewBox="0 0 1072 1448" role="img" aria-label="Codex 與 Claude 訂閱用量">
  <rect width="1072" height="1448" fill="#FFFFFF"/>
  <g font-family="Arial, Noto Sans CJK TC, Heiti TC, sans-serif">
    ${text(64,76,'AI USAGE',26,500,colors.muted,'start','letter-spacing="4"')}
    ${text(1008,76,`${date.year} / ${date.month} / ${date.day}`,27,400,colors.muted,'end')}
    ${text(64,162,'用量一覽',64,500)}
    ${text(1008,158,`${date.hour}:${date.minute}`,51,500,colors.ink,'end')}
    ${rule(205)}
    ${stack || text(536,780,'尚未設定 worker',40,500,colors.muted,'middle')}
    ${rule(1372)}
    ${text(64,1420,'訂閱額度 · 已使用百分比',25,400,colors.muted)}
    ${text(1008,1420,'Asia/Taipei',25,400,colors.muted,'end')}
  </g>
</svg>`;

const fontPaths = [
  process.env.KOBO_FONT,
  '/System/Library/Fonts/Supplemental/Arial.ttf',
  '/System/Library/Fonts/Supplemental/Arial Bold.ttf',
  '/System/Library/Fonts/STHeiti Light.ttc',
  '/System/Library/Fonts/STHeiti Medium.ttc',
  '/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc',
  '/usr/share/fonts/opentype/noto/NotoSansCJK-Bold.ttc'
].filter(p=>p&&existsSync(p));
const renderer=new Resvg(svg,{font:{fontFiles:fontPaths,loadSystemFonts:false,defaultFontFamily:'Arial'}});
const rendered=renderer.render();
await mkdir(dirname(output),{recursive:true});
const temporary=output+`.${process.pid}.tmp`;
await writeFile(temporary,rendered.asPng());
await rename(temporary,output);
await writeFile(output.replace(/\.png$/i,'')+'.svg',svg);
console.log(JSON.stringify({output,width:rendered.width,height:rendered.height,referenceTime:now.toISOString(),mode:at,
  states:Object.fromEntries(cards.map(r=>[r.workerId || r.provider,normalizeProvider([r],r.provider,now,inputError).state]))},null,2));
