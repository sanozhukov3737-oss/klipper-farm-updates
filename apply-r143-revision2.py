"""Reconstruct the complete R143 revision2 patch from saved GitHub revision1."""
import argparse,base64,hashlib,json
from pathlib import Path
p=argparse.ArgumentParser();p.add_argument('original_patch',type=Path);p.add_argument('overlay',type=Path);p.add_argument('output_patch',type=Path);args=p.parse_args()
sha=lambda data:hashlib.sha256(data).hexdigest()
old_bytes=args.original_patch.read_bytes();overlay=json.loads(args.overlay.read_text(encoding='utf-8-sig'))
assert sha(old_bytes)==overlay['parentPatchSha256'],'GitHub revision1 patch differs'
packet=json.loads(old_bytes); rows={row['path']:row for row in packet['files']}
for change in overlay['files']:
 row=rows[change['path']];assert row['sha256']==change['beforeSha256']
 assert sha(base64.b64decode(change['contentBase64'],validate=True))==change['sha256']
 row['sha256']=change['sha256'];row['contentBase64']=change['contentBase64']
packet['candidate']='R143-code-maintenance-revision2';packet['revision']=2
packet['supersedesPatchSha256']=sha(old_bytes)
packet['revisionNotes']='Detaches owned staging buffers immediately on modern WebView2; retains older-engine fallback. Startup budget uses the median of three fresh contexts, preserving original limits. GPU submission lengths are captured synchronously before the renderer detaches CPU storage.'
data=(json.dumps(packet,ensure_ascii=False,indent=2)+'\n').encode()
assert sha(data)==overlay['revision2CompletePatchSha256'],'Reconstructed revision2 patch differs'
args.output_patch.write_bytes(data)
print('Verified revision2 patch SHA256',sha(data))
