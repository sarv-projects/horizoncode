#!/usr/bin/env python3
"""Offline immutable-source/provenance regression checks. No network or mutation."""
from pathlib import Path
import json,re,sys
R=Path(__file__).resolve().parents[2]
A=R/'arch_V1'
errors=[];checks=0

def check(v,msg):
    global checks
    checks+=1
    if not v:errors.append(msg)

def load(path):return json.loads(path.read_text())

source=load(A/'external-source-register.json')
repos=source['repos'];patterns=source['extraction_patterns']
check(len(repos)==12,'expected 12 registered repositories')
check(len(patterns)==23,'expected 23 bounded extraction patterns')
lookup={}
for repo in repos:
    key=repo.get('key');sha=repo.get('pinned_commit','');url=repo.get('canonical_url','')
    check(key not in lookup,'duplicate repo key '+str(key));lookup[key]=repo
    check(url=='https://github.com/'+repo.get('repo',''),'canonical repo URL mismatch '+str(key))
    check(bool(re.fullmatch(r'[0-9a-f]{40}',sha)),'commit/base SHA must be full '+str(key))
    if key=='horizoncode':
        check(repo.get('pinned_tree') is None,'unpublished local Horizon base must not have public tree URL')
        check(repo.get('local_base_commit')==sha,'Horizon local base mismatch')
        check(bool(re.fullmatch(r'[0-9a-f]{40}',repo.get('remote_main_at_audit',''))),'Horizon remote-main audit SHA missing')
        check(repo.get('public_pin_status')=='local_head_not_present_on_remote_at_audit','Horizon public pin status missing')
    else:
        check(repo.get('pinned_tree')==url+'/tree/'+sha,'immutable tree mismatch '+str(key))

seen=set()
for pat in patterns:
    pid=pat.get('id');key=pat.get('source_repo')
    check(pid not in seen,'duplicate extraction ID '+str(pid));seen.add(pid)
    check(key in lookup,str(pid)+' unknown source repo '+str(key))
    if key not in lookup:continue
    repo=lookup[key]
    files=pat.get('exact_source_files',[])
    check(bool(files),str(pid)+' missing source files')
    for item in files:
        path=item.get('path','');url=item.get('url','')
        check(path and not path.startswith('/') and '..' not in Path(path).parts,str(pid)+' invalid source path '+path)
        # External extraction refs must be immutable blob links.
        if repo['key']=='horizoncode':
            check(False,str(pid)+' must not use unpublished Horizon base as an external extraction source')
        else:
            expected=repo['canonical_url']+'/blob/'+repo['pinned_commit']+'/'+path
            check(url==expected,str(pid)+' wrong immutable file URL '+path)
    for field in ['specific_logic_to_extract','horizon_owner_or_adaptation_target','required_tests','do_not_copy_or_security_limits','status','priority']:
        check(bool(pat.get(field)),str(pid)+' missing '+field)

dec=(A/'17-GOVERNANCE-DECISIONS.md').read_text()
for marker in ['A-V2-11','A-V2-21','A-V2-22','A-V2-23','A-V2-24','A-V2-25','A-V2-26']:
    check(marker in dec,'missing adopted decision '+marker)

check((A/'42-EXTERNAL-SOURCE-PROVENANCE-REGISTER.md').is_file(),'source register markdown missing')
check('local base has no valid public GitHub tree link' in (A/'42-EXTERNAL-SOURCE-PROVENANCE-REGISTER.md').read_text(),'source register does not explain local-only Horizon base')

plan=R/'docs/superpowers/plans/2026-10-11-horizoncode-converged-implementation.md'
check(plan.is_file(),'current implementation plan missing')
old=R/'docs/superpowers/plans/2026-10-10-horizon-p2-thread-cutover.md'
if old.is_file():
    text=old.read_text()
    check('SUPERSEDED' in text[:1600] and plan.name in text[:1600],'historical P2 plan lacks successor banner')

for rel in ['AGENTS.md','HANDOFF.md','IMPLEMENTER_PROMPT.md']:
    text=(R/rel).read_text()
    check('17-GOVERNANCE-DECISIONS.md' in text,rel+' missing governance pointer')
    check(plan.name in text,rel+' missing current plan pointer')
    check('42-EXTERNAL-SOURCE-PROVENANCE-REGISTER.md' in text,rel+' missing provenance pointer')

# Large mechanical manifests are optional audit evidence; if present, they must be self-consistent.
manifest=A/'repo-file-line-audit-manifest.json'
if manifest.is_file():
    s=load(manifest).get('summary',{})
    check(s.get('files',0)>=6000,'repository audit unexpectedly small')
    check(s.get('markdown_files',0)>=200,'repository markdown audit unexpectedly small')
    check(s.get('readable_text_lines',0)>1000000,'repository text audit unexpectedly small')

refs=A/'ignored-reference-source-manifest.json'
if refs.is_file():
    s=load(refs)
    check(s.get('summary',{}).get('files')==27271,'ignored reference inventory file count changed')
    check(s.get('summary',{}).get('text_lines',0)>=5900000,'ignored reference text-line count unexpectedly small')

print('SOURCE_PROVENANCE_CHECKS',checks,'FAILURES',len(errors))
for e in errors[:100]:print('FAIL',e)
sys.exit(1 if errors else 0)
