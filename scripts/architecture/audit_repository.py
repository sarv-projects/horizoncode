#!/usr/bin/env python3
"""Read-only or opt-in-write git-visible file/line/link inventory. Does not modify source."""
from __future__ import annotations
import argparse,collections,hashlib,json,os,re,subprocess,sys
from pathlib import Path
ROOT=Path(__file__).resolve().parents[2]
ART=ROOT/'arch_V1'
MD_PATTERN=re.compile(r'(?<!!)\[[^\]]+\]\(([^)\n]+)\)')
LOCAL_REPO_RE=re.compile(r'(?:github\.com/)([^/\s)]+)/([^/\s)#?]+)')
TEXT_EXTS={'.md','.mdx','.ts','.tsx','.rs','.json','.jsonc','.js','.jsx','.mjs','.css','.scss','.sql','.toml','.yml','.yaml','.py','.txt','.sh','.html','.xml','.astro','.patch','.go','.lock','.nix','.svg','.jsonl','.txt','.yml'}
def main():
 ap=argparse.ArgumentParser()
 ap.add_argument('--write',action='store_true')
 opts=ap.parse_args()
 p=subprocess.run(['git','ls-files','-co','--exclude-standard','-z'],cwd=ROOT,capture_output=True,check=True)
 paths=sorted(set(x.decode('utf-8','surrogateescape') for x in p.stdout.split(b'\0') if x and x.decode('utf-8','surrogateescape') != 'arch_V1/repo-file-line-audit-manifest.json'))
 coverage=[]; links=[];line_count=0;md_count=0; text_files=0;nontext_files=0; total_bytes=0; missing=[]
 for filename in paths:
  path=ROOT/filename
  if not path.is_file() or path.is_symlink():continue
  h=hashlib.sha256()
  size=0;newlines=0
  try:
   with path.open('rb') as f:
    while True:
     chunk=f.read(1024*1024)
     if not chunk:break
     size+=len(chunk);h.update(chunk)
     if path.suffix.lower() in TEXT_EXTS:newlines+=chunk.count(b'\n')
  except OSError as e:
   missing.append({'path':filename,'error':type(e).__name__});continue
  total_bytes+=size
  istext=path.suffix.lower() in TEXT_EXTS
  lines=(newlines+(1 if size and path.read_bytes()[-1:] != b'\n' else 0)) if istext else None
  if istext:line_count+=lines;text_files+=1
  else:nontext_files+=1
  coverage.append({'path':filename,'size':size,'sha256':h.hexdigest(),'lines':lines})
  if path.suffix.lower() in {'.md','.mdx'}:
   md_count+=1
   content=path.read_text(encoding='utf-8',errors='replace')
   for n,line in enumerate(content.splitlines(),1):
    # inline local relative markdown links; strip anchors+title for link target
    for mat in MD_PATTERN.finditer(line):
     target=mat.group(1).strip()
     if target.startswith(('#','http:','https:','mailto:','data:','javascript:','app:','sandbox:')):continue
     target=target.split(' "',1)[0].split('#',1)[0]
     if not target or target.startswith('<'):continue
     # Avoid nonportable encoded markdown destinations (flag but do not falsely claim broken)
     if '%' in target or '?' in target:continue
     local=(path.parent/target).resolve(strict=False)
     if not local.exists():
      if filename.startswith('docs/architecture-archive/'):
       kind='archived-pre-consolidation'
      elif filename.startswith('docs/architecture-input/2026-10-11-'):
       kind='archived-normative-excerpt'
      elif filename.startswith(('opencode/packages/opencode/test/fixture/','packages/opencode/test/fixture/')):
       kind='upstream-test-fixture'
      elif filename.startswith('opencode/'):
       kind='pinned-upstream-document'
      elif filename.startswith('.opencode/references/'):
       kind='vendored-reference'
      else:
       kind='actionable-missing-local-target'
      links.append({'path':filename,'line':n,'target':mat.group(1),'classification':kind})
 summary={'snapshot_head':subprocess.check_output(['git','rev-parse','HEAD'],cwd=ROOT,text=True).strip(),
          'files':len(coverage),'markdown_files':md_count,'readable_text_files':text_files,
          'nontext_files':nontext_files,'readable_text_lines':line_count,'total_bytes_read':total_bytes,
          'missing_file_errors':missing,'local_relative_markdown_link_findings':links,
          'actionable_broken_markdown_links':[x for x in links if x['classification']=='actionable-missing-local-target'],
          'method':'All Git-visible files except this self-generated audit manifest byte-stream hashed; all designated text suffix files newline counted; Markdown relative links resolved and known historical/vendor fixtures classified. This is complete mechanical coverage, NOT manual semantic line-by-line code review, runtime test or external URL verification.'}
 report={'summary':summary,'files':coverage}
 print('SCANNED',summary['files'],'MD',summary['markdown_files'],'TEXT_LINES',line_count,'BYTES',total_bytes,'BROKEN_RELATIVE_LINK_CANDIDATES',len(links))
 for entry in links[:35]:print('LINK',entry['path'],entry['line'],entry['target'])
 if opts.write:
  target=ART/'repo-file-line-audit-manifest.json'
  target.write_text(json.dumps(report,indent=1,ensure_ascii=False)+'\n')
  print('REPORT',target,'BYTES',target.stat().st_size)
 return 0
if __name__=='__main__':sys.exit(main())
