import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
const root=path.resolve('src-tauri/speech'),manifest=path.join(root,'manifest.json');
if(!fs.existsSync(manifest))throw new Error('Offline speech assets missing. Run python scripts/prepare-neural-speech.py before building.');
const files=JSON.parse(fs.readFileSync(manifest,'utf8'));
for(const name of ['whisper/whisper-cli.exe','whisper/ggml-small-q5_1.bin','piper/piper.exe','piper/ru_RU-denis-medium.onnx','piper/ru_RU-dmitri-medium.onnx'])if(!files.some(row=>row.path===name))throw new Error('Speech manifest missing '+name);
for(const row of files){
 const file=path.resolve(root,row.path);if(!file.startsWith(root+path.sep))throw new Error('Unsafe speech asset path');
 const bytes=fs.readFileSync(file),hash=createHash('sha256').update(bytes).digest('hex');
 if(bytes.length!==row.bytes||hash!==row.sha256)throw new Error('Speech asset mismatch: '+row.path);
}
console.log('Verified offline neural speech files:',files.length);
