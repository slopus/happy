// Derive review artifacts from this run's verified frames; never edit source screenshots.
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import sharp from 'sharp';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../../../../..');
const task=path.join(root,'packages/happy-app/test-results/global-session-float');
const output=path.join(root,'docs/validation/assets/global-session-float');await fs.mkdir(output,{recursive:true});
const before=JSON.parse(await fs.readFile(path.join(task,'before-normal.json'),'utf8'));
const after=JSON.parse(await fs.readFile(path.join(task,'after-record.json'),'utf8'));
const find=(source,id)=>source.frames.find(f=>f.id===id).path;
const names={C1:'Sidebar switch and compact window',C2:'Drag the window',C3:'Open session and keep window'};
for(const [id,frame] of [['C1','C1-on'],['C2','C2-drag'],['C3','C3-open']]){
 const header=Buffer.from(`<svg width="3408" height="100"><rect width="100%" height="100%" fill="#101923"/><text x="16" y="34" fill="#eef3f9" font-family="sans-serif" font-size="25">${id} · ${names[id]}</text><text x="16" y="78" fill="#bdcbd7" font-family="sans-serif" font-size="22">BEFORE · 943f0e0c</text><text x="1712" y="78" fill="#9dc7dd" font-family="sans-serif" font-size="22">AFTER · same 1680×960 viewport / DPR 1</text></svg>`);
 await sharp({create:{width:3408,height:1092,channels:3,background:'#101923'}}).composite([{input:header,left:0,top:0},{input:find(before,frame),left:16,top:110},{input:find(after,frame),left:1712,top:110}]).png().toFile(path.join(output,id+'-before-after.png'));
}
const strips=[];for(const [i,id] of ['C1-off','C1-on','C1-close'].entries()){
 const cropped=await sharp(find(after,id)).extract({left:0,top:52,width:76,height:285}).resize(152,570).png().toBuffer();
 const title=Buffer.from(`<svg width="184" height="40"><text x="12" y="28" fill="white" font-family="sans-serif" font-size="21">${['OFF','ON','CLOSED'][i]}</text></svg>`);
 strips.push({input:title,left:i*184,top:0},{input:cropped,left:i*184+16,top:48});
}
await sharp({create:{width:552,height:634,channels:3,background:'#101923'}}).composite(strips).png().toFile(path.join(output,'C1-on-off-states.png'));
// A label outside the browser image explains that the live capture is sampled.
const footer=Buffer.from('<svg width="1680" height="56"><rect width="100%" height="100%" fill="#101923"/><text x="20" y="35" fill="#e2edf6" font-family="sans-serif" font-size="22">C1 ON/OFF → C2 drag → C3 open session / unread 1→0 → close · live sampled recording</text></svg>');
await sharp(footer).png().toFile(path.join(task,'video-label.png'));
console.log({output,video:after.video});
