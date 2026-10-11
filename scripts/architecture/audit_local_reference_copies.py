#!/usr/bin/env python3
"""Mechanical SHA/line audit for ignored LOCAL REFERENCE source copies, never modifies them."""
from pathlib import Path
import argparse,collections,hashlib,json,os
R=Path(__file__).resolve().parents[2]
DEST=R/'arch_V1/ignored-reference-source-manifest.json'
SKIP={'.git','node_modules','target','dist','build','.next','.turbo','.cache','vendor','.venv','venv'}
TEXT={'.ts','.tsx','.rs','.py','.js','.jsx','.mjs','.md','.mdx','.json','.jsonc','.yaml','.yml','.toml','.sh','.go','.txt','.css','.sql','.xml','.svg','.html','.astro','.nix','.lock','.patch','.proto','.graphql','.gql','.kdl','.bash','.zsh'}
def main():
 a=argparse.ArgumentParser();a.add_argument('--write',action='store_true');opt=a.parse_args()
 totals=collections.Counter();repoData=[]
 for source in ['cline','codex','deepseek-harness']:
  repo=R/'repos'/source
  if not repo.is_dir():continue
  items=[];count=collections.Counter();overall=hashlib.sha256()
  for base,dirs,files in os.walk(repo):
   dirs[:]=sorted(d for d in dirs if d not in SKIP and not (Path(base)/d).is_symlink())
   for name in sorted(files):
    p=Path(base)/name
    if not p.is_file() or p.is_symlink():continue
    relative=p.relative_to(repo).as_posix()
    h=hashlib.sha256();size=0;lines=0;istext=p.suffix.lower() in TEXT;last=b''
    try:
     with p.open('rb') as file:
      while True:
       chunk=file.read(1024*1024)
       if not chunk:break
       h.update(chunk);size+=len(chunk);last=chunk[-1:]
       if istext:lines+=chunk.count(b'\n')
    except OSError as e:
     count['read_errors']+=1;continue
    if istext and size and last!=b'\n':lines+=1
    if not istext:lines=None
    count['files']+=1;count['bytes']+=size
    if istext:count['text_files']+=1;count['text_lines']+=lines
    if p.suffix.lower()=='.md':count['markdown_files']+=1
    digest=h.hexdigest()
    overall.update(relative.encode('utf8')+b'\0'+digest.encode('ascii')+b'\0')
    items.append({'path':relative,'bytes':size,'sha256':digest,'lines':lines})
  repoData.append({'path':'repos/'+source,'git_provenance':'NOT VERIFIED: local ignored reference copy has no independently resolved Git HEAD in audit','summary':dict(count),'tree_digest_sha256':overall.hexdigest(),'files':items})
  totals.update(count)
  print('SCANNED',source,dict(count),flush=True)
 data={'scope':'Three local ignored repository reference copies under agentx/repos; excludes .git, generated build, dependencies, caches and symlinks; byte-hash all remaining regular files and newline-count designated text suffix files; NOT human semantic review or Git provenance verification','summary':dict(totals),'references':repoData}
 if opt.write:
  DEST.write_text(json.dumps(data,indent=1,ensure_ascii=False)+'\n')
  print('MANIFEST',DEST,'bytes',DEST.stat().st_size,flush=True)
 return 0
if __name__=='__main__':raise SystemExit(main())
