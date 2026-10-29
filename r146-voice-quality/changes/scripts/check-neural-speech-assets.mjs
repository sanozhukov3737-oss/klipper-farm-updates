import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
const root=path.resolve('src-tauri/speech'),manifest=path.join(root,'manifest.json');
if(!fs.existsSync(manifest))throw new Error('Offline speech assets missing. Run python scripts/prepare-neural-speech.py before building.');
const files=JSON.parse(fs.readFileSync(manifest,'utf8'));
for(const name of ['whisper/whisper-cli.exe','whisper/ggml-small-q5_1.bin','whisper/recognition.args','silero/python/python.exe','silero/python/python312.dll','silero/python/python312.zip','silero/python/python312._pth','silero/python/Lib/site-packages/torch/__init__.py','silero/python/Lib/site-packages/torch/lib/torch_cpu.dll','silero/tts.py','silero/v5_6_ru.pt','silero/LICENSE.txt'])if(!files.some(row=>row.path===name))throw new Error('Speech manifest missing '+name);
if(files.some(row=>row.path.startsWith('piper/')))throw new Error('Superseded Piper voices must not be shipped in the Kseniya package');
if(!files.some(row=>row.path==='silero/python/Lib/site-packages/num2words/__init__.py'))throw new Error('Russian numeric speech dependency missing');
if(fs.readFileSync(path.join(root,'silero/python/python312._pth'),'utf8')!=='python312.zip\n.\nLib/site-packages\n')throw new Error('Embedded Python must use only packaged dependencies');
for(const row of files){
 const file=path.resolve(root,row.path);if(!file.startsWith(root+path.sep))throw new Error('Unsafe speech asset path');
 const bytes=fs.readFileSync(file),hash=createHash('sha256').update(bytes).digest('hex');
 if(bytes.length!==row.bytes||hash!==row.sha256)throw new Error('Speech asset mismatch: '+row.path);
}
console.log('Verified offline neural speech files:',files.length);
