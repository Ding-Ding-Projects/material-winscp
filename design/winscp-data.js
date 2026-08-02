// winscp-data.js — simulation core: catalog assets, fs builders, color math, schemas.
import { I18N, resolveI18n } from './winscp-i18n.js';
export { I18N, resolveI18n };

export const VERSION = '6.5.0-m3.1';
export const DISHES = [
  { id:'hk-dish-0001', en:'Classic Har Gow', zh:'蝦餃', jy:'haa1 gaau2', img:'assets/dim-0001-har-gow.png' },
  { id:'hk-dish-0011', en:'Classic Siu Mai', zh:'燒賣', jy:'siu1 maai2', img:'assets/dim-0011-siu-mai.png' },
  { id:'hk-dish-0051', en:'Classic Char Siu Bao', zh:'叉燒包', jy:'caa1 siu1 baau1', img:'assets/dim-0051-char-siu-bao.png' },
  { id:'hk-dish-0058', en:'Steamed Custard Bao', zh:'奶黃包', jy:'naai5 wong4 baau1', img:'assets/dim-0058-custard-bao.png' },
  { id:'hk-dish-0081', en:'Steamed Radish Cake', zh:'蘿蔔糕', jy:'lo4 baak6 gou1', img:'assets/dim-0081-radish-cake.png' },
  { id:'hk-dish-0139', en:'Puff Pastry Egg Tarts', zh:'酥皮蛋撻', jy:'sou1 pei4 daan6 taat1', img:'assets/dim-0139-egg-tarts.png' },
];
export const CODENAME = DISHES[0]; // one code name per release, used once

export const PROTOCOLS = [
  { id:'SFTP', port:22, enc:null },
  { id:'SCP', port:22, enc:null },
  { id:'FTP', port:21, enc:['No encryption','TLS/SSL Explicit encryption','TLS/SSL Implicit encryption'] },
  { id:'WebDAV', port:443, enc:['TLS/SSL Implicit encryption','No encryption'] },
  { id:'S3', port:443, enc:['Amazon S3','S3-compatible'] },
];
export const SEEDS = [
  { id:'azure', label:'Azure', hex:'#0B57D0' },
  { id:'jade', label:'Jade', hex:'#146C2E' },
  { id:'plum', label:'Plum', hex:'#6750A4' },
  { id:'ember', label:'Ember', hex:'#A33B12' },
];
export const FONTS = [
  { name:'Roboto', stack:"'Roboto','Noto Sans HK',sans-serif" },
  { name:'Roboto Flex', stack:"'Roboto Flex','Roboto','Noto Sans HK',sans-serif" },
  { name:'Noto Sans HK', stack:"'Noto Sans HK','Roboto',sans-serif" },
  { name:'Segoe UI', stack:"'Segoe UI','Noto Sans HK',sans-serif" },
  { name:'system-ui', stack:"system-ui,'Noto Sans HK',sans-serif" },
  { name:'Arial', stack:"Arial,'Noto Sans HK',sans-serif" },
  { name:'Verdana', stack:"Verdana,'Noto Sans HK',sans-serif" },
  { name:'Trebuchet MS', stack:"'Trebuchet MS','Noto Sans HK',sans-serif" },
  { name:'Georgia', stack:"Georgia,'Noto Sans HK',serif" },
  { name:'Times New Roman', stack:"'Times New Roman','Noto Sans HK',serif" },
  { name:'Roboto Mono', stack:"'Roboto Mono','Noto Sans HK',monospace" },
  { name:'Consolas', stack:"Consolas,'Roboto Mono',monospace" },
  { name:'Courier New', stack:"'Courier New',monospace" },
];
export const REGEX_CONSTRUCTS = [
  { l:'Text (escaped)', ins:'TEXT', prompt:true, d:'Literal text, special characters escaped' },
  { l:'Any character', ins:'.', d:'Matches any single character except newline' },
  { l:'Digit', ins:'\\d', d:'0-9' }, { l:'Non-digit', ins:'\\D', d:'Anything but 0-9' },
  { l:'Word character', ins:'\\w', d:'Letter, digit or underscore' }, { l:'Whitespace', ins:'\\s', d:'Space, tab, newline' },
  { l:'Character class', ins:'[abc]', d:'Any one of the listed characters' },
  { l:'Negated class', ins:'[^abc]', d:'Any character NOT listed' },
  { l:'Range', ins:'[a-z]', d:'Any character in the range' },
  { l:'Start of line', ins:'^', d:'Anchor: start' }, { l:'End of line', ins:'$', d:'Anchor: end' },
  { l:'Word boundary', ins:'\\b', d:'Between word and non-word' },
  { l:'Group', ins:'(…)', raw:'()', d:'Capture group' },
  { l:'Named group', ins:'(?<name>…)', raw:'(?<name>)', d:'Capture group with a name' },
  { l:'Non-capturing', ins:'(?:…)', raw:'(?:)', d:'Group without capturing' },
  { l:'Alternation', ins:'a|b', raw:'|', d:'Either the left or the right side' },
  { l:'0 or more', ins:'*', d:'Quantifier' }, { l:'1 or more', ins:'+', d:'Quantifier' },
  { l:'Optional', ins:'?', d:'0 or 1' }, { l:'Exactly n', ins:'{2}', d:'Quantifier {n}' },
  { l:'Between n,m', ins:'{2,5}', d:'Quantifier {n,m}' }, { l:'Lazy', ins:'*?', d:'Match as little as possible' },
  { l:'Lookahead', ins:'(?=…)', raw:'(?=)', d:'Followed by, without consuming' },
  { l:'Neg. lookahead', ins:'(?!…)', raw:'(?!)', d:'NOT followed by' },
  { l:'Lookbehind', ins:'(?<=…)', raw:'(?<=)', d:'Preceded by' },
  { l:'Unicode letter', ins:'\\p{L}', d:'Any letter (needs u flag)' },
];
export const RB_FLAGS = [
  { f:'g', d:'global — all matches' }, { f:'i', d:'ignore case' }, { f:'m', d:'multiline ^ $' },
  { f:'s', d:'dot matches newline' }, { f:'u', d:'unicode' }, { f:'y', d:'sticky' },
];
export const DEFAULT_PRESETS = [
  { id:'default', name:'Default', mode:'auto', preserveTs:true, perms:false, exclude:'', speed:0, newerOnly:false },
  { id:'text', name:'Text', mode:'text', preserveTs:true, perms:false, exclude:'', speed:0, newerOnly:false },
  { id:'binary', name:'Binary', mode:'binary', preserveTs:true, perms:false, exclude:'', speed:0, newerOnly:false },
  { id:'backup', name:'Exclude temporaries', mode:'auto', preserveTs:true, perms:false, exclude:'-*.tmp;-*.bak;-Thumbs.db;-.DS_Store', speed:0, newerOnly:false },
];
export const DEFAULT_CUSTOM_COMMANDS = [
  { name:'Execute', cmd:'"./!"', remote:true, dirs:false, recurse:false },
  { name:'Touch', cmd:'touch "!"', remote:true, dirs:true, recurse:false },
  { name:'Tar/GZip', cmd:'tar -czf "!?&Archive name:?archive.tgz!" !&', remote:true, dirs:true, recurse:false },
  { name:'UnTar/GZip', cmd:'tar -xzf "!"', remote:true, dirs:false, recurse:false },
  { name:'Grep', cmd:'grep "!?&Text to find:?!" !&', remote:true, dirs:false, recurse:false },
];

// ---------- deterministic rng ----------
export function strHash(s){ let h=1779033703^s.length; for(let i=0;i<s.length;i++){ h=Math.imul(h^s.charCodeAt(i),3432918353); h=h<<13|h>>>19; } return h>>>0; }
export function mulberry32(a){ return function(){ a|=0; a=a+0x6D2B79F5|0; let t=Math.imul(a^a>>>15,1|a); t=t+Math.imul(t^t>>>7,61|t)^t; return ((t^t>>>14)>>>0)/4294967296; }; }

// ---------- fs model ----------
let _id=1; const nid=()=>'n'+(_id++)+'_'+Math.random().toString(36).slice(2,7);
export function F(n,s,m,x,r,o,g){ return { id:nid(), n, t:'f', s:(s||0)>0? s : (x?x.length:0), m, x, r:r||'rw-r--r--', o:o||'you', g:g||'users' }; }
export function D(n,m,c,r,o,g){ return { id:nid(), n, t:'d', s:0, m, c:c||[], r:r||'rwxr-xr-x', o:o||'you', g:g||'users' }; }
const day=864e5;
export function buildLocalFs(now){
  const t=(d)=>now-d*day;
  return D('', t(300), [
    D('C:', t(300), [
      D('Users', t(280), [ D('you', t(2), [
        D('Documents', t(1), [
          D('Reports', t(6), [
            F('q1-report.md', 0, t(40), '# Q1 Report\n\nTransfers are up 34%.\nMaterial redesign shipped to the pilot group.\n\n## Next\n- roll out tab groups\n- collect feedback\n'),
            F('q2-report.md', 0, t(6), '# Q2 Report\n\nSync adoption doubled.\nQueue throughput steady at 8 parallel transfers.\n'),
          ]),
          F('notes.txt', 0, t(1), 'remember:\n- rotate the deploy key\n- backup /var/www before friday\n- try the new synchronize preview\n'),
          F('budget.csv', 0, t(12), 'item,amount\nhosting,120\ndomains,36\nbackups,18\n'),
        ]),
        D('Downloads', t(3), [ F('server-backup-2026-07.tar.gz', 48211456, t(9)), F('putty-installer.exe', 3902464, t(60)) ]),
        D('Pictures', t(15), [ F('holiday-001.jpg', 2841203, t(15)), F('holiday-002.jpg', 3120887, t(15)), F('team-photo.png', 1204331, t(90)) ]),
        D('Projects', t(0.2), [ D('website', t(0.2), [
          F('index.html', 0, t(0.4), '<!doctype html>\n<html>\n<head><title>My site</title><link rel="stylesheet" href="css/main.css"></head>\n<body>\n<h1>Hello from the local copy</h1>\n<script src="js/app.js"></script>\n</body>\n</html>\n'),
          F('README.md', 0, t(5), '# website\n\nDeploy with WinSCP Material: synchronize local → /var/www/html.\n'),
          D('css', t(2), [ F('main.css', 0, t(2), 'body{font-family:system-ui;margin:2rem;color:#222}\nh1{color:#0b57d0}\n') ]),
          D('js', t(0.4), [ F('app.js', 0, t(0.4), "console.log('local build', new Date().toISOString());\n") ]),
        ]) ]),
        D('Music', t(200), []),
      ]) ]),
      D('Program Files', t(300), [ D('WinSCP Material', t(30), [ F('readme.txt',0,t(30),'WinSCP Material '+VERSION+' — simulated install directory.\n') ]) ], 'r-xr-xr-x'),
      D('Windows', t(300), [], 'r-xr-xr-x', 'SYSTEM','SYSTEM'),
    ]),
    D('D:', t(120), [ D('Backup', t(20), [ F('sites-2026-06.json', 18233, t(45)), F('sites-2026-07.json', 19702, t(14)) ]) ]),
  ]);
}
const WORDS=['atlas','harbor','bamboo','lotus','ferry','peak','kowloon','victoria','jade','pearl'];
export function buildRemoteFs(host, user, proto, now){
  const rng=mulberry32(strHash(host)); const t=(max)=>now-Math.floor(rng()*max*day)-3600e3;
  const w=()=>WORDS[Math.floor(rng()*WORDS.length)];
  const u=user||'guest';
  if(proto==='S3'){
    const b1=w()+'-assets', b2=w()+'-backups';
    return D('', t(300), [
      D(b1, t(90), [ D('img', t(30), [F('logo.png', 48213, t(30)), F('hero.jpg', 812331, t(22))]), F('site.css',0,t(12),'/* served from '+b1+' */\nbody{margin:0}\n') ], 'rwxr-xr-x', u, 's3'),
      D(b2, t(40), [ F('db-2026-07-28.sql.gz', 10241833, t(4)), F('db-2026-07-21.sql.gz', 10113407, t(11)) ], 'rwxr-xr-x', u, 's3'),
    ]);
  }
  const home = D(u, t(2), [
    D('www', t(1), [
      F('index.html',0,t(1),'<!doctype html>\n<html>\n<head><title>'+host+'</title></head>\n<body>\n<h1>Welcome to '+host+'</h1>\n<p>Served since 2024.</p>\n</body>\n</html>\n'),
      F('style.css',0,t(8),'body{font:16px/1.5 system-ui;background:#fafafa}\n'),
      D('img', t(20), [F('banner.jpg', 421900, t(20)), F('icon.png', 8123, t(50))]),
    ]),
    D('logs', t(0.1), [
      F('access.log',0,t(0.1),'127.0.0.1 - - [01/Aug/2026:07:58:01] "GET / HTTP/1.1" 200 5123\n127.0.0.1 - - [01/Aug/2026:08:02:44] "GET /style.css HTTP/1.1" 200 812\n10.0.0.7 - - [01/Aug/2026:08:05:12] "POST /api/upload HTTP/1.1" 201 96\n'),
      F('error.log',0,t(2),'[warn] 2026-07-30 rotating logs\n[error] 2026-07-31 upstream timed out (110)\n'),
    ]),
    D('scripts', t(15), [
      F('deploy.sh',0,t(15),'#!/bin/sh\nset -e\nrsync -a ~/www/ /var/www/html/\necho deployed\n','rwxr-xr-x'),
      F('cleanup.py',0,t(33),'import os\nfor f in os.listdir("/tmp"):\n    print("would remove", f)\n'),
    ]),
    D('backup', t(6), [ F('www-2026-07-26.tar.gz', 22140033, t(6)) ]),
    D('docs', t(50), [ F('server-notes.md',0,t(50),'# '+host+'\n\n- nginx 1.24\n- certbot renews on the 3rd\n- contact: ops@'+host+'\n') ]),
    D('.ssh', t(120), [ F('authorized_keys',0,t(120),'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5 you@laptop\n','rw-------') ], 'rwx------'),
    F('.bashrc',0,t(200),'export PS1="\\u@\\h:\\w$ "\nalias ll="ls -la"\n'),
    F('.profile',0,t(200),'# ~/.profile\numask 022\n'),
    F('todo.txt',0,t(0.5),'- renew TLS cert\n- prune old backups\n- review upload API quota\n'),
  ], 'rwxr-xr-x', u, u);
  return D('', t(400), [
    D('home', t(400), [home], 'rwxr-xr-x','root','root'),
    D('var', t(400), [ D('www', t(90), [ D('html', t(1), [
      F('index.html',0,t(1),'<!doctype html>\n<html><head><title>'+host+' — live</title></head>\n<body><h1>'+host+'</h1><p>production build</p></body></html>\n','rw-r--r--','www-data','www-data'),
      F('robots.txt',0,t(200),'User-agent: *\nAllow: /\n','rw-r--r--','www-data','www-data'),
    ], 'rwxr-xr-x','www-data','www-data') ], 'rwxr-xr-x','root','root') ], 'rwxr-xr-x','root','root'),
    D('etc', t(400), [ F('hostname',0,t(400),host+'\n','rw-r--r--','root','root'), F('nginx.conf',0,t(70),'events{}\nhttp{ server{ listen 80; root /var/www/html; } }\n','rw-r--r--','root','root') ], 'rwxr-xr-x','root','root'),
    D('tmp', t(0.1), [], 'rwxrwxrwx','root','root'),
  ], 'rwxr-xr-x','root','root');
}
export function homePath(user, proto){ return proto==='S3' ? '/' : '/home/'+(user||'guest'); }

// ---------- fs ops (pure, operate on tree) ----------
export function splitPath(p){ return (p||'').split(/[\\/]+/).filter(Boolean); }
export function joinPath(segs, local){ return local ? segs.join('\\') : '/'+segs.join('/'); }
export function fsGet(root, p){ let cur=root; for(const s of splitPath(p)){ if(!cur||cur.t!=='d') return null; cur=(cur.c||[]).find(k=>k.n===s); } return cur||null; }
export function fsParent(root, p){ const segs=splitPath(p); const name=segs.pop(); return { dir: segs.length? fsGetSegs(root,segs):root, name, segs }; }
function fsGetSegs(root, segs){ let cur=root; for(const s of segs){ if(!cur||cur.t!=='d') return null; cur=(cur.c||[]).find(k=>k.n===s); } return cur||null; }
export function fsDeepSize(node){ if(node.t==='f') return node.s; return (node.c||[]).reduce((a,k)=>a+fsDeepSize(k),0); }
export function fsCount(node){ if(node.t==='f') return {f:1,d:0}; return (node.c||[]).reduce((a,k)=>{const r=fsCount(k); return {f:a.f+r.f, d:a.d+r.d+(k.t==='d'?1:0)};},{f:0,d:0}); }
export function cloneNode(node){ const c={...node, id:nid()}; if(node.c) c.c=node.c.map(cloneNode); return c; }
export function maskToRegex(mask){ // WinSCP-style file mask piece → RegExp
  const esc=mask.replace(/[.+^${}()|[\]\\]/g,'\\$&').replace(/\*/g,'.*').replace(/\?/g,'.');
  return new RegExp('^'+esc+'$','i');
}
export function matchMask(name, maskList){ // "*.jpg;*.png" with "-" exclusions
  if(!maskList) return true; let inc=null, excluded=false;
  for(let m of maskList.split(';').map(s=>s.trim()).filter(Boolean)){
    const neg=m.startsWith('-'); if(neg)m=m.slice(1);
    let ok=false; try{ ok=maskToRegex(m).test(name); }catch(e){}
    if(neg){ if(ok) excluded=true; } else { if(inc===null) inc=false; if(ok) inc=true; }
  }
  return !excluded && (inc===null?true:inc);
}
export function fmtSize(bytes, mode){ // mode: bytes|kb|short
  if(bytes==null) return '';
  if(mode==='bytes') return bytes.toLocaleString('en-US');
  if(mode==='kb') return Math.max(1,Math.ceil(bytes/1024)).toLocaleString('en-US')+' KB';
  if(bytes<1024) return bytes+' B';
  const u=['KB','MB','GB','TB']; let v=bytes/1024, i=0;
  while(v>=1024&&i<u.length-1){v/=1024;i++;}
  return (v>=100?Math.round(v):v.toFixed(1))+' '+u[i];
}
export function fmtDate(ms){ const d=new Date(ms); const p=n=>String(n).padStart(2,'0');
  return d.getFullYear()+'-'+p(d.getMonth()+1)+'-'+p(d.getDate())+' '+p(d.getHours())+':'+p(d.getMinutes()); }
export function rightsToOctal(r){ let o=''; for(let i=0;i<9;i+=3){ o+= (r[i]!=='-'?4:0)+(r[i+1]!=='-'?2:0)+(r[i+2]!=='-'?1:0); } return '0'+o; }
export function octalToRights(oct){ const s=oct.replace(/^0/,'').padStart(3,'0'); let r='';
  for(const ch of s){ const v=parseInt(ch,8)||0; r+=(v&4?'r':'-')+(v&2?'w':'-')+(v&1?'x':'-'); } return r; }
export function extOf(n){ const i=n.lastIndexOf('.'); return i>0? n.slice(i+1).toLowerCase():''; }
export function fileKind(node){ if(node.t==='d') return 'dir';
  const e=extOf(node.n);
  if(['jpg','jpeg','png','gif','webp','svg','ico'].includes(e)) return 'img';
  if(['html','htm','css','js','ts','py','sh','json','yml','yaml','conf','xml','md'].includes(e)) return 'code';
  if(['zip','gz','tgz','tar','7z','rar'].includes(e)) return 'zip';
  if(['txt','log','csv','ini'].includes(e)) return 'txt';
  if(['exe','msi','dll'].includes(e)) return 'bin';
  if(['mp3','wav','flac'].includes(e)) return 'audio';
  if(['sql'].includes(e)) return 'db';
  return node.x!=null?'txt':'file';
}
export function typeName(node){ if(node.t==='d') return 'File folder';
  const e=extOf(node.n); return e? e.toUpperCase()+' file' : 'File'; }
export function fingerprint(host){ const h=strHash('hostkey:'+host); const rng=mulberry32(h);
  const b64='ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  let s=''; for(let i=0;i<43;i++) s+=b64[Math.floor(rng()*64)];
  return 'ssh-ed25519 255 SHA256:'+s; }

// ---------- color math (infinite picker + translator) ----------
export const NAMED_COLORS={black:'#000000',white:'#ffffff',red:'#ff0000',lime:'#00ff00',blue:'#0000ff',yellow:'#ffff00',cyan:'#00ffff',magenta:'#ff00ff',silver:'#c0c0c0',gray:'#808080',maroon:'#800000',olive:'#808000',green:'#008000',purple:'#800080',teal:'#008080',navy:'#000080',orange:'#ffa500',pink:'#ffc0cb',gold:'#ffd700',indigo:'#4b0082',violet:'#ee82ee',coral:'#ff7f50',salmon:'#fa8072',khaki:'#f0e68c',crimson:'#dc143c',tomato:'#ff6347',orchid:'#da70d6',plum:'#dda0dd',skyblue:'#87ceeb',steelblue:'#4682b4',slategray:'#708090',chocolate:'#d2691e',tan:'#d2b48c',beige:'#f5f5dc',ivory:'#fffff0',lavender:'#e6e6fa',turquoise:'#40e0d0',seagreen:'#2e8b57',forestgreen:'#228b22',royalblue:'#4169e1',hotpink:'#ff69b4',rebeccapurple:'#663399'};
export function hexToRgb(hex){ let h=hex.replace('#',''); if(h.length===3||h.length===4) h=[...h].map(c=>c+c).join('');
  if(!/^[0-9a-f]{6}([0-9a-f]{2})?$/i.test(h)) return null;
  return { r:parseInt(h.slice(0,2),16), g:parseInt(h.slice(2,4),16), b:parseInt(h.slice(4,6),16), a: h.length===8? parseInt(h.slice(6,8),16)/255 : 1 }; }
export function rgbToHex(r,g,b,a){ const p=v=>Math.round(Math.max(0,Math.min(255,v))).toString(16).padStart(2,'0');
  return '#'+p(r)+p(g)+p(b)+(a!=null&&a<1? p(a*255):''); }
export function rgbToHsl(r,g,b){ r/=255;g/=255;b/=255; const mx=Math.max(r,g,b),mn=Math.min(r,g,b); let h=0,s=0,l=(mx+mn)/2;
  if(mx!==mn){ const d=mx-mn; s=l>0.5? d/(2-mx-mn): d/(mx+mn);
    h= mx===r? (g-b)/d+(g<b?6:0) : mx===g? (b-r)/d+2 : (r-g)/d+4; h*=60; }
  return {h, s:s*100, l:l*100}; }
export function hslToRgb(h,s,l){ s/=100;l/=100; const k=n=>(n+h/30)%12; const a=s*Math.min(l,1-l);
  const f=n=>l-a*Math.max(-1,Math.min(k(n)-3,Math.min(9-k(n),1)));
  return { r:f(0)*255, g:f(8)*255, b:f(4)*255 }; }
export function rgbToHsv(r,g,b){ r/=255;g/=255;b/=255; const mx=Math.max(r,g,b),mn=Math.min(r,g,b),d=mx-mn;
  let h=0; if(d){ h= mx===r? ((g-b)/d)%6 : mx===g? (b-r)/d+2 : (r-g)/d+4; h*=60; if(h<0)h+=360; }
  return {h, s:(mx?d/mx:0)*100, v:mx*100}; }
export function hsvToRgb(h,s,v){ s/=100;v/=100; const c=v*s, x=c*(1-Math.abs((h/60)%2-1)), m=v-c;
  let [r,g,b]= h<60?[c,x,0]:h<120?[x,c,0]:h<180?[0,c,x]:h<240?[0,x,c]:h<300?[x,0,c]:[c,0,x];
  return {r:(r+m)*255,g:(g+m)*255,b:(b+m)*255}; }
export function rgbToHwb(r,g,b){ const {h}=rgbToHsv(r,g,b); return {h, w:Math.min(r,g,b)/255*100, bl:(1-Math.max(r,g,b)/255)*100}; }
export function rgbToCmyk(r,g,b){ r/=255;g/=255;b/=255; const k=1-Math.max(r,g,b);
  if(k===1) return {c:0,m:0,y:0,k:100};
  return { c:(1-r-k)/(1-k)*100, m:(1-g-k)/(1-k)*100, y:(1-b-k)/(1-k)*100, k:k*100 }; }
const lin=v=>{v/=255; return v<=0.04045? v/12.92 : Math.pow((v+0.055)/1.055,2.4);};
export function rgbToXyz(r,g,b){ const R=lin(r),G=lin(g),B=lin(b);
  return { x:(0.4124564*R+0.3575761*G+0.1804375*B)*100, y:(0.2126729*R+0.7151522*G+0.0721750*B)*100, z:(0.0193339*R+0.1191920*G+0.9503041*B)*100 }; }
export function xyzToLab(x,y,z){ const ref=[95.047,100,108.883]; const f=t=>t>0.008856?Math.cbrt(t):(7.787*t+16/116);
  const fx=f(x/ref[0]),fy=f(y/ref[1]),fz=f(z/ref[2]);
  return { L:116*fy-16, a:500*(fx-fy), b:200*(fy-fz) }; }
export function labToLch(L,a,b){ return { L, C:Math.sqrt(a*a+b*b), H:(Math.atan2(b,a)*180/Math.PI+360)%360 }; }
export function rgbToOklab(r,g,b){ const R=lin(r),G=lin(g),B=lin(b);
  const l=Math.cbrt(0.4122214708*R+0.5363325363*G+0.0514459929*B);
  const m=Math.cbrt(0.2119034982*R+0.6806995451*G+0.1073969566*B);
  const s=Math.cbrt(0.0883024619*R+0.2817188376*G+0.6299787005*B);
  return { L:0.2104542553*l+0.7936177850*m-0.0040720468*s, a:1.9779984951*l-2.4285922050*m+0.4505937099*s, b:0.0259040371*l+0.7827717662*m-0.8086757660*s }; }
export function contrastRatio(rgb1,rgb2){ const lum=({r,g,b})=>0.2126*lin(r)+0.7152*lin(g)+0.0722*lin(b);
  const l1=lum(rgb1),l2=lum(rgb2); const [a,b]=l1>l2?[l1,l2]:[l2,l1]; return (a+0.05)/(b+0.05); }
export function parseColor(str){ if(!str) return null; str=String(str).trim().toLowerCase();
  if(NAMED_COLORS[str]) return {...hexToRgb(NAMED_COLORS[str]), name:str};
  if(str.startsWith('#')) return hexToRgb(str);
  let m=str.match(/^rgba?\(([^)]+)\)/); if(m){ const p=m[1].split(/[,\s/]+/).map(parseFloat); return {r:p[0],g:p[1],b:p[2],a:p[3]==null?1:(p[3]>1?p[3]/100:p[3])}; }
  m=str.match(/^hsla?\(([^)]+)\)/); if(m){ const p=m[1].split(/[,\s/%]+/).map(parseFloat); const c=hslToRgb(p[0],p[1],p[2]); return {...c, a:p[3]==null?1:(p[3]>1?p[3]/100:p[3])}; }
  return null; }
export function nearestNamed(r,g,b){ let best=null,bd=1e9;
  for(const [n,hx] of Object.entries(NAMED_COLORS)){ const c=hexToRgb(hx); const d=(c.r-r)**2+(c.g-g)**2+(c.b-b)**2;
    if(d<bd){bd=d;best={name:n,exact:d===0};} } return best; }
export function translateColor(r,g,b,a){ // all representations for the translator panel
  const f1=v=>Math.round(v*10)/10, f2=v=>Math.round(v*100)/100, f3=v=>Math.round(v*1000)/1000;
  const hsl=rgbToHsl(r,g,b), hsv=rgbToHsv(r,g,b), hwb=rgbToHwb(r,g,b), cmyk=rgbToCmyk(r,g,b);
  const xyz=rgbToXyz(r,g,b), lab=xyzToLab(xyz.x,xyz.y,xyz.z), lch=labToLch(lab.L,lab.a,lab.b);
  const ok=rgbToOklab(r,g,b), okl=labToLch(ok.L,ok.a,ok.b);
  const named=nearestNamed(r,g,b);
  const A=a==null?1:a; const as=A<1? ' / '+f2(A):'';
  return [
    { k:'Named', v: named.exact? named.name : '≈ '+named.name },
    { k:'HEX', v: rgbToHex(r,g,b) }, { k:'HEX8', v: rgbToHex(r,g,b,A??1).length===7? rgbToHex(r,g,b)+'ff' : rgbToHex(r,g,b,A) },
    { k:'RGB', v:'rgb('+Math.round(r)+' '+Math.round(g)+' '+Math.round(b)+(as?as:'')+')' },
    { k:'HSL', v:'hsl('+f1(hsl.h)+' '+f1(hsl.s)+'% '+f1(hsl.l)+'%'+as+')' },
    { k:'HSV/HSB', v:'hsv('+f1(hsv.h)+' '+f1(hsv.s)+'% '+f1(hsv.v)+'%)' },
    { k:'HWB', v:'hwb('+f1(hwb.h)+' '+f1(hwb.w)+'% '+f1(hwb.bl)+'%'+as+')' },
    { k:'CIELAB', v:'lab('+f1(lab.L)+'% '+f1(lab.a)+' '+f1(lab.b)+as+')' },
    { k:'LCH', v:'lch('+f1(lch.L)+'% '+f1(lch.C)+' '+f1(lch.H)+as+')' },
    { k:'OKLab', v:'oklab('+f3(ok.L)+' '+f3(ok.a)+' '+f3(ok.b)+as+')' },
    { k:'OKLCH', v:'oklch('+f3(ok.L)+' '+f3(okl.C)+' '+f1(okl.H)+as+')' },
    { k:'CMYK', v:'cmyk('+f1(cmyk.c)+'% '+f1(cmyk.m)+'% '+f1(cmyk.y)+'% '+f1(cmyk.k)+'%)' },
  ];
}

// ---------- preferences + site-advanced schemas (t: check|radio|select|number|text|slider|password) ----------
export const PREF_PAGES = [
  { id:'interface', icon:'wysiwyg', L:'pInterface', group:'pEnvironment', controls:[
    { k:'interfaceStyle', t:'radio', L:'interfaceStyle', opts:[['commander','commanderStyle'],['explorer','explorerStyle']] },
  ], custom:'appearance' },
  { id:'window', icon:'select_window', L:'pWindow', group:'pEnvironment', controls:[
    { k:'showTips', t:'check', L:'showTips' },
    { k:'confirmExit', t:'check', L:'confirmExit' },
    { k:'autoReload', t:'check', L:'autoReload' },
    { k:'preserveDirs', t:'check', L:'preserveDirChanges' },
  ]},
  { id:'commander', icon:'vertical_split', L:'pCommander', group:'pEnvironment', controls:[
    { k:'swapPanels', t:'check', L:'swapHint' },
    { k:'fullRow', t:'check', L:'fullRowSelect' },
    { k:'treeVisible', t:'check', L:'treeVisible' },
    { k:'useLocationProfiles', t:'check', L:'useLocationProfiles' },
  ]},
  { id:'explorer', icon:'web_asset', L:'pExplorer', group:'pEnvironment', controls:[
    { k:'explorerToolbar', t:'check', L:'toolbars' },
    { k:'explorerAddress', t:'check', L:'statusBarMenu' },
  ]},
  { id:'languages', icon:'translate', L:'pLanguages', group:'pEnvironment', custom:'languages', controls:[] },
  { id:'notifications', icon:'notifications', L:'pNotifications', group:'pEnvironment', controls:[
    { k:'notifSecs', t:'slider', L:'notifDuration', min:2, max:15, step:1, unit:'s' },
    { k:'reducedMotion', t:'check', L:'reducedMotion' },
  ], custom:'notifications' },
  { id:'panels', icon:'view_column', L:'pPanels', controls:[
    { k:'showHidden', t:'check', L:'showHiddenPref' },
    { k:'sizeFormat', t:'radio', L:'sizeFormatPref', opts:[['bytes','bytes_'],['kb','kilobytes'],['short','shortFmt']] },
    { k:'dblClick', t:'radio', L:'dblClickAction', opts:[['open','dblOpen'],['edit','dblEdit'],['transfer','dblTransfer']] },
    { k:'dimInaccessible', t:'check', L:'showInaccesible' },
  ]},
  { id:'fileColors', icon:'palette', L:'pFileColors', group:'pPanels', custom:'fileColors', controls:[] },
  { id:'panelRemote', icon:'dns', L:'pRemote', group:'pPanels', controls:[
    { k:'remoteRefreshSec', t:'number', L:'connTimeout', min:0, max:600 },
  ]},
  { id:'panelLocal', icon:'computer', L:'pLocal', group:'pPanels', controls:[
    { k:'localShowSystem', t:'check', L:'showHiddenPref' },
  ]},
  { id:'editors', icon:'edit_note', L:'pEditor', custom:'editors', controls:[] },
  { id:'editorInternal', icon:'code', L:'pEditorInternal', group:'pEditor', controls:[
    { k:'edFontSize', t:'slider', L:'editorFontSize', min:11, max:24, step:1, unit:'px' },
    { k:'edTabSize', t:'number', L:'editorTabSize', min:2, max:8 },
    { k:'edLineNumbers', t:'check', L:'editorLineNumbers' },
    { k:'edWrap', t:'check', L:'editorWrap' },
  ]},
  { id:'transfer', icon:'swap_vert', L:'pTransfer', custom:'presets', controls:[
    { k:'confirmOverwrite', t:'check', L:'confirmOverwrite' },
    { k:'confirmDelete', t:'check', L:'confirmDeletion' },
  ]},
  { id:'background', icon:'stacked_line_chart', L:'pBackground', group:'pTransfer', controls:[
    { k:'queueParallel', t:'slider', L:'queueParallel', min:1, max:9, step:1 },
    { k:'queueByDefault', t:'check', L:'queueByDefault' },
    { k:'queueNoConfirm', t:'check', L:'queueNoConfirm' },
  ]},
  { id:'endurance', icon:'battery_charging_full', L:'pEndurance', group:'pTransfer', controls:[
    { k:'resumeAboveKb', t:'number', L:'enduranceResume', min:0, max:1048576, unit:'KB' },
    { k:'keepAlive', t:'check', L:'enduranceKeepAlive' },
  ]},
  { id:'dragdrop', icon:'drag_pan', L:'pDragDrop', group:'pTransfer', controls:[
    { k:'dragOut', t:'check', L:'dragDropDownloads' },
    { k:'dragTemp', t:'check', L:'dragDropTemp' },
    { k:'confirmDrag', t:'check', L:'confirmDrag' },
  ]},
  { id:'commands', icon:'terminal', L:'pCustomCommands', custom:'customCommands', controls:[] },
  { id:'applications', icon:'apps', L:'pApplications', group:'pIntegration', controls:[
    { k:'puttyPath', t:'text', L:'appsPutty' },
    { k:'puttyKeepDir', t:'check', L:'appsKeepOpen' },
  ]},
  { id:'logging', icon:'receipt_long', L:'pLogging', custom:'logging', controls:[
    { k:'logEnabled', t:'check', L:'logEnable' },
    { k:'logLevel', t:'radio', L:'logLevel', opts:[['normal','logNormal'],['debug1','logDebug1'],['debug2','logDebug2']] },
    { k:'logWindow', t:'check', L:'logWindow' },
  ]},
  { id:'network', icon:'lan', L:'pNetwork', controls:[
    { k:'proxyType', t:'select', L:'proxyType', opts:[['none','none'],['socks4','custom'],['socks5','custom'],['http','custom']], rawOpts:['None','SOCKS4','SOCKS5','HTTP'] },
    { k:'proxyHost', t:'text', L:'proxyHost' },
    { k:'proxyPort', t:'number', L:'proxyPort', min:1, max:65535 },
    { k:'connTimeout', t:'number', L:'connTimeout', min:5, max:600, unit:'s' },
    { k:'reconnectAuto', t:'check', L:'reconnectAuto' },
  ]},
  { id:'security', icon:'shield_lock', L:'pSecurity', custom:'security', controls:[]},
  { id:'storage', icon:'database', L:'pStorage', custom:'storage', controls:[]},
  { id:'updates', icon:'system_update_alt', L:'pUpdates', custom:'updates', controls:[
    { k:'updatesAuto', t:'check', L:'updatesAuto' },
    { k:'updatesFreq', t:'radio', L:'updatesFreq', opts:[['daily','daily'],['weekly','weekly'],['monthly','monthly'],['never','never']] },
  ]},
];
export const SITE_ADV_PAGES = [
  { id:'environment', icon:'public', L:'pEnvironment', controls:[
    { k:'utf8', t:'select', lab:'UTF-8 encoding for filenames', rawOpts:['Auto','On','Off'] },
    { k:'tzOffset', t:'number', lab:'Time zone offset (hours)', min:-12, max:14 },
  ]},
  { id:'directories', icon:'folder', L:'siteFolder', lab:'Directories', controls:[
    { k:'remoteDir', t:'text', lab:'Remote directory' },
    { k:'localDir', t:'text', lab:'Local directory' },
    { k:'cacheDirs', t:'check', lab:'Cache visited remote directories' },
    { k:'cacheDeep', t:'check', lab:'Cache directory trees additionally' },
  ]},
  { id:'recycle', icon:'recycling', lab:'Recycle bin', controls:[
    { k:'recycleOn', t:'check', lab:'Preserve deleted remote files to recycle bin' },
    { k:'recyclePath', t:'text', lab:'Recycle bin path' },
    { k:'overwriteToRecycle', t:'check', lab:'Preserve overwritten files as well' },
  ]},
  { id:'encryption', icon:'enhanced_encryption', L:'encryption', controls:[
    { k:'encryptFiles', t:'check', lab:'Encrypt new files (client-side, AES-256)' },
    { k:'encryptKey', t:'password', lab:'Encryption key' },
  ]},
  { id:'sftp', icon:'swap_horiz', lab:'SFTP', controls:[
    { k:'sftpServer', t:'text', lab:'SFTP server command (blank = default subsystem)' },
    { k:'sftpMaxVersion', t:'select', lab:'Preferred SFTP protocol version', rawOpts:['6','5','4','3','2','1','0'] },
  ]},
  { id:'shell', icon:'terminal', lab:'Shell (SCP)', controls:[
    { k:'shell', t:'select', lab:'Shell', rawOpts:['Default','/bin/bash','/bin/sh','sudo -s'] },
    { k:'returnVar', t:'text', lab:'Return code variable (blank = autodetect)' },
    { k:'lsOptions', t:'check', lab:'Use scp2 compatible file listing' },
  ]},
  { id:'connection', icon:'settings_ethernet', lab:'Connection', controls:[
    { k:'timeoutS', t:'number', lab:'Server response timeout (s)', min:5, max:600 },
    { k:'keepaliveS', t:'number', lab:'Keepalive interval (s, 0 = off)', min:0, max:3600 },
    { k:'ipv', t:'select', lab:'Internet protocol version', rawOpts:['Auto','IPv4','IPv6'] },
  ]},
  { id:'proxy', icon:'alt_route', lab:'Proxy', controls:[
    { k:'proxyType', t:'select', lab:'Proxy type', rawOpts:['None','SOCKS4','SOCKS5','HTTP','Telnet','Local'] },
    { k:'proxyHost', t:'text', lab:'Proxy host' },
    { k:'proxyPort', t:'number', lab:'Port', min:1, max:65535 },
    { k:'proxyUser', t:'text', lab:'User name' },
  ]},
  { id:'tunnel', icon:'sync_alt', lab:'Tunnel', controls:[
    { k:'tunnelOn', t:'check', lab:'Connect through SSH tunnel' },
    { k:'tunnelHost', t:'text', lab:'Tunnel host name' },
    { k:'tunnelPort', t:'number', lab:'Port', min:1, max:65535 },
    { k:'tunnelUser', t:'text', lab:'User name' },
  ]},
  { id:'ssh', icon:'key', lab:'SSH', controls:[
    { k:'compression', t:'check', lab:'Enable compression' },
    { k:'cipher', t:'select', lab:'Preferred encryption cipher', rawOpts:['AES (recommended)','ChaCha20','3DES','Blowfish'] },
  ]},
  { id:'kex', icon:'sync_lock', lab:'Key exchange', controls:[
    { k:'kex', t:'select', lab:'Preferred algorithm', rawOpts:['ECDH (recommended)','Diffie-Hellman group exchange','Diffie-Hellman group 14'] },
    { k:'rekeyMin', t:'number', lab:'Max minutes before rekey', min:0, max:1440 },
  ]},
  { id:'auth', icon:'fingerprint', lab:'Authentication', controls:[
    { k:'agentAuth', t:'check', lab:'Attempt authentication using Pageant (agent)' },
    { k:'keyFile', t:'text', lab:'Private key file' },
    { k:'gssapi', t:'check', lab:'Attempt GSSAPI authentication' },
  ]},
  { id:'bugs', icon:'bug_report', lab:'Bugs', controls:[
    { k:'bugIgnore1', t:'select', lab:'Chokes on SSH-1 ignore messages', rawOpts:['Auto','Off','On'] },
    { k:'bugHmac2', t:'select', lab:'Miscomputes SSH-2 HMAC keys', rawOpts:['Auto','Off','On'] },
    { k:'bugPksessid2', t:'select', lab:'Misuses the session ID in SSH-2 PK auth', rawOpts:['Auto','Off','On'] },
  ]},
  { id:'ftp', icon:'settings_input_antenna', lab:'FTP', controls:[
    { k:'passive', t:'check', lab:'Passive mode' },
    { k:'ftpAccount', t:'text', lab:'Account' },
    { k:'ftpListAll', t:'select', lab:'Support LIST -a', rawOpts:['Auto','On','Off'] },
  ]},
  { id:'s3', icon:'cloud', lab:'S3', controls:[
    { k:'s3Region', t:'text', lab:'Default region' },
    { k:'s3UrlStyle', t:'select', lab:'URL style', rawOpts:['Virtual Host','Path'] },
    { k:'s3ReducedRedundancy', t:'check', lab:'Use reduced redundancy storage class' },
  ]},
  { id:'webdav', icon:'http', lab:'WebDAV', controls:[
    { k:'davCompression', t:'check', lab:'Enable compression' },
    { k:'davTls', t:'select', lab:'Minimum TLS version', rawOpts:['TLS 1.2','TLS 1.3'] },
  ]},
  { id:'note', icon:'sticky_note_2', L:'siteNote', controls:[ { k:'note', t:'textarea', lab:'Note shown in the site list' } ]},
  { id:'color', icon:'palette', L:'siteColor', custom:'siteColor', controls:[]},
];
export const IMPORT_SOURCES = ['PuTTY','FileZilla','OpenSSH config','WinSCP INI file'];
export const ENCODINGS = ['UTF-8','UTF-8 BOM','Windows-1252','ISO-8859-1','Big5','GB18030'];
