#!/usr/bin/env python3
"""Offline architecture/schema/registry/authority regression checks. No source mutation."""
from pathlib import Path
import json,re,sys
from jsonschema import Draft202012Validator

R=Path(__file__).resolve().parents[2]
A=R/'arch_V1'
D=A/'contracts-v2'
failures=[]
checked=0

def check(condition,msg):
    global checked
    checked+=1
    if not condition:
        failures.append(msg)

def load(path):
    return json.loads(path.read_text())

ACTIVE=[
 '01-SYSTEM.md','02-DOMAIN.md','03-FLOWS.md','04-STATE-EVENTS.md','05-SECURITY.md',
 '10-DELIVERY.md','11-LIFECYCLE.md','12-DOMAIN-SCHEMAS.md','13-COMPOSITION-IPC.md',
 '14-EFFECTS-EXECUTION-SECURITY.md','15-RUNTIME-EXECUTION.md','16-UX-SETTINGS-ECOSYSTEM.md',
 '17-GOVERNANCE-DECISIONS.md','18-OPERATIONS-RELEASE.md','20-OPENCODE-INTEGRATION-LLD.md',
 '21-HEALING-PERMISSIONS-WORKTREE-POOL.md','29-AGENTS-SKILLS-HOOKS-MCP.md',
 '30-CONTEXT-INDEXING-LOCAL-MODELS.md','31-UI-PERFORMANCE-ARTIFACTS-ANALYTICS.md',
 '32-TASK-BASED-AGENT-TEST-CATALOG.md','33-BUILTIN-CAPABILITIES-CATALOG.md',
 '37-RUNTIME-SERVICE-LLD.md','42-EXTERNAL-SOURCE-PROVENANCE-REGISTER.md','GLOSSARY.md','README.md'
]
STUBS=[
 '06-CAPABILITIES.md','07-UX-COMMANDS.md','08-RECONCILIATION.md','09-SOURCE-MAP.md',
 '19-OPENCODE-UPSTREAM-REUSE.md','22-UNIVERSAL-UI-COMMANDS-MEMORY.md',
 '23-ADOPTION-GATES-TESTS.md','24-LOCAL-CODE-AUDIT-AND-MIGRATION.md',
 '25-DATA-AND-CONTROL-PLANE-CROSSWALK.md','26-UX-ACCEPTANCE-AND-RELEASE.md',
 '27-IMPLEMENTATION-READINESS-AUDIT.md','28-COMPETITIVE-GAP-AUDIT.md',
 '34-DOCUMENT-LINE-AUDIT-LEDGER.md','35-USER-REQUEST-COVERAGE-MATRIX.md',
 '36-CONTRACT-CONVERGENCE-PLAN.md','38-OMP-SOURCE-COMPETITIVE-AUDIT.md',
 '39-OMP-TUI-SLASH-MODEL-SETTINGS-AUDIT.md','40-HORIZONCODE-OMP-INSPIRED-UI-PROPOSAL.md',
 '41-OMP-STREAMING-VISUAL-ARTIFACTS-AUDIT.md','43-IMPLEMENTATION-SOURCE-LLD-PLAYBOOK.md',
 '44-FINAL-REPO-AUDIT-LEDGER.md'
]

# Every expected active/stub doc exists.
for name in ACTIVE+STUBS:
    check((A/name).is_file(),'missing architecture document '+name)

# Root workspace identity is HorizonCode-owned; pinned vendor packages retain upstream IDs.
root_package=load(R/'package.json')
check(root_package.get('private') is True,'root workspace must stay private')
check(root_package.get('name')=='horizoncode-workspace','root workspace name drifted from horizoncode-workspace')
repository=root_package.get('repository')
repository_url=repository.get('url') if isinstance(repository,dict) else repository
check(repository_url=='https://github.com/sarv-projects/horizoncode.git','root repository URL is not HorizonCode')
scripts=root_package.get('scripts',{})
check(scripts.get('horizon:push-gate')=='bash scripts/architecture/run_push_gate.sh','root push-gate script missing')
check(scripts.get('horizon:full-gate')=='bash scripts/architecture/run_full_gate.sh','root full-gate script missing')

flow_text=(A/'03-FLOWS.md').read_text()
for heading in [
    '## 3.16 Native OpenCode backend',
    '## 3.17 Visual edit',
    '## 3.18 Deploy and verify',
    '## 3.19 Stop',
]:
    check(heading in flow_text,'required end-to-end flow missing: '+heading)

# Active authority contains no stale conversation-owner vocabulary or proposal-status conflict.
banned=[
 r'\bThreadService\b',r'\bThreadStoreService\b',r'Rust[- ]canonical Thread',
 r'canonical Thread transcript',r'\bNOT ADOPTED\b',
]
for name in ACTIVE:
    text=(A/name).read_text()
    for pat in banned:
        check(not re.search(pat,text,re.I),'stale active authority '+name+' / '+pat)
    section_ids=re.findall(r'^##\s+(\d+\.\d+)\b',text,re.M)
    duplicates=sorted({sid for sid in section_ids if section_ids.count(sid)>1})
    check(not duplicates,'duplicate numbered section in '+name+': '+','.join(duplicates))
    section_order=[tuple(map(int,sid.split('.'))) for sid in section_ids]
    check(section_order==sorted(section_order),'out-of-order numbered sections in '+name)

# Stubs must be short, unmistakably non-normative and archive-backed.
archive=R/'docs/architecture-archive/2026-10-11-pre-lean-consolidation/arch_V1'
check(archive.is_dir(),'pre-consolidation archive missing')
for name in STUBS:
    text=(A/name).read_text()
    check('NON-NORMATIVE COMPATIBILITY STUB' in text,'stub missing non-normative marker '+name)
    check(len(text.splitlines())<=20,'compatibility stub became a second large document '+name)
    check((archive/name).is_file(),'archived original missing '+name)

# JSON Schemas parse and validate as Draft 2020-12.
schema_files=sorted(D.glob('*.schema.json'))
for path in schema_files:
    try:
        Draft202012Validator.check_schema(load(path)); checked+=1
    except Exception as ex:
        failures.append('SCHEMA '+path.name+': '+str(ex))

# Capability registry.
registry=load(D/'capability-registry-v1.json')
reg_validator=Draft202012Validator(load(D/'capability-registry-v1.schema.json'))
check(not list(reg_validator.iter_errors(registry)),'capability registry violates schema')
records={x['id']:x for x in registry['canonical']}
check(len(records)==len(registry['canonical']),'duplicate canonical capability ID')
aliases=registry.get('aliases',[])
alias_names=[x['alias'] for x in aliases]
check(len(alias_names)==len(set(alias_names)),'duplicate capability alias')
for alias in aliases:
    check(alias['canonicalId'] in records,'alias target missing '+str(alias))
    check(alias['alias'] not in records,'alias shadows canonical ID '+alias['alias'])
for rec in registry['canonical']:
    check(rec['effectClass']!='unknown','unclassified canonical capability '+rec['id'])

# Every canonical ID in fenced §33 text is in machine registry.
catalog=(A/'33-BUILTIN-CAPABILITIES-CATALOG.md').read_text()
fence=chr(96)*3
catalog_ids=set()
for block in catalog.split(fence+'text')[1:]:
    body=block.split(fence,1)[0]
    for raw in body.splitlines():
        candidate=raw.strip()
        if re.fullmatch(r'[a-z][a-z0-9]*(?:[.][a-z][a-z0-9_]*)+',candidate):
            catalog_ids.add(candidate)
for cid in sorted(catalog_ids):
    check(cid in records,'catalog capability missing from registry '+cid)

mandatory_effect={
 'terminal.run','files.patch','agents.spawn','dom.click','mcp.invoke',
 'desktop.click','desktop.type','web.search','debug.start','debug.evaluate','repl.execute'
}
for cid in mandatory_effect:
    check(cid in records and records[cid]['effectClass']=='guarded_effect','unsafe/missing effect classification '+cid)
mandatory_read={'desktop.snapshot','web.search.providers','debug.variables','repl.status'}
for cid in mandatory_read:
    check(cid in records and records[cid]['effectClass']=='read_only','unsafe/missing read classification '+cid)

# Positive/negative fixtures for boundary schemas.
examples={
 'session-link-v1':{'schemaVersion':1,'sessionId':'ses1','sourceStoreId':'store1','sourceEpoch':1,'sourceCursor':'c1','sourceDigest':'sha256:x','ownerEpoch':2},
 'tool-batch-control-v1':{'schemaVersion':1,'batchId':'b1','sessionId':'s1','providerResponseRef':'r1','providerResponseDigest':'sha256:x','toolRegistryGeneration':'g1','policyEpoch':1,'status':'validated','calls':[{'callId':'c1','capabilityId':'files.patch','schemaDigest':'sha256:s','argumentsDigest':'sha256:a','effectClass':'guarded_effect'}],'effectRefs':[]},
 'effect-boundary-v1':{'schemaVersion':1,'effectId':'e1','capabilityId':'files.patch','phase':'prepared','argumentsDigest':'sha256:a','targetRef':'file:x','scopeRef':'project:x','policyEpoch':1,'resultClass':'none'},
 'desktop-action-v1':{'schemaVersion':1,'requestId':'r1','backend':'linux','targetRef':'window:1','expectedGeneration':1,'action':'click','arguments':{},'deadlineMs':5000},
 'web-search-request-v1':{'schemaVersion':1,'requestId':'r1','query':'test','providerId':'p1','routeClass':'direct_search','costPolicy':'free_only','maxResults':5,'timeoutMs':5000,'domains':[]},
 'web-search-result-v1':{'schemaVersion':1,'requestId':'r1','providerId':'p1','routeClass':'direct_search','retrievedAt':'2026-10-11T00:00:00Z','costClass':'free','results':[{'url':'https://example.com','title':'Example','snippet':'x'}]},
 'debug-session-action-v1':{'schemaVersion':1,'requestId':'r1','sessionId':'d1','generation':1,'action':'stack','arguments':{},'deadlineMs':5000},
 'repl-session-action-v1':{'schemaVersion':1,'requestId':'r1','sessionId':'rp1','generation':1,'language':'python','action':'status','resourceProfileRef':'resource:safe','callbackCapabilityIds':[],'deadlineMs':5000},
 'source-artifact-v1':{'schemaVersion':1,'artifactId':'a1','ownerRef':'session:s1','sourceRevision':'rev1','sha256':'0'*64,'mime':'text/plain','byteCount':1,'fidelity':'full','droppedByteCount':0,'retentionClass':'session'},
 'figure-block-v1':{'schemaVersion':1,'figureId':'f1','messagePartId':'p1','sourceRevision':1,'sourceDigest':'sha256:x','kind':'svg','status':'ready','rendererVersion':'1','themeEpoch':1,'geometryEpoch':1}
}
for stem,good in examples.items():
    schema=load(D/(stem+'.schema.json'))
    validator=Draft202012Validator(schema)
    errs=list(validator.iter_errors(good))
    check(not errs,'positive fixture '+stem+(': '+str(errs[0]) if errs else ''))
    required=schema.get('required',[])
    if required:
        bad=dict(good); bad.pop(required[0],None)
        check(bool(list(validator.iter_errors(bad))),'negative required fixture '+stem)
    bad=dict(good);bad['unexpected_privileged_override']=True
    check(bool(list(validator.iter_errors(bad))),'unknown field denied '+stem)

# FeatureExposureV1 is a derived Settings/UX contract, not proof of a wired feature.
feature_schema=load(D/'feature-exposure-v1.schema.json')
feature_validator=Draft202012Validator(feature_schema)
feature_off={
 'schemaVersion':1,'featureId':'horizon.native-search','settingKey':'features.native_search',
 'title':'Native repository search','description':'Optional audited native search backend',
 'releaseClass':'experimental','optional':True,'audience':'developer','defaultEnabled':False,
 'supportedScopes':['user','project'],'applyBoundary':'next_session','capabilityIds':['text.search'],
 'state':{
  'implementationStatus':'designed','requestedEnabled':None,'effectiveEnabled':False,
  'effectiveState':'unavailable','valueSource':'default','blockedReason':'Not implemented'
 }
}
check(not list(feature_validator.iter_errors(feature_off)),'feature exposure experimental unavailable fixture')
check(all(ref in records for ref in feature_off['capabilityIds']),'feature exposure canonical capability ref missing')
feature_on={
 **feature_off,'featureId':'horizon.editor-annotations','settingKey':'features.editor_annotations',
 'releaseClass':'stable','audience':'public','defaultEnabled':True,'capabilityIds':[],
 'state':{
  'implementationStatus':'verified','requestedEnabled':True,'effectiveEnabled':True,
  'effectiveState':'on','valueSource':'user'
 }
}
check(not list(feature_validator.iter_errors(feature_on)),'feature exposure stable-enabled fixture')
feature_pending={
 **feature_on,'state':{
  'implementationStatus':'verified','requestedEnabled':False,'effectiveEnabled':True,
  'effectiveState':'pending_apply','valueSource':'user','pendingApplyAt':'restart'
 }
}
check(not list(feature_validator.iter_errors(feature_pending)),'feature exposure pending-disable fixture')
for label,bad in [
 ('experimental default enabled',{**feature_off,'defaultEnabled':True}),
 ('developer default enabled',{**feature_off,'defaultEnabled':True,'releaseClass':'stable'}),
 ('missing setting key',{k:v for k,v in feature_off.items() if k!='settingKey'}),
 ('unknown top-level authority',{**feature_off,'privilegedOverride':True}),
 ('unknown nested authority',{**feature_off,'state':{**feature_off['state'],'guardBypass':True}}),
 ('designed feature effective on',{**feature_off,'state':{**feature_off['state'],'effectiveEnabled':True,'effectiveState':'on'}}),
 ('on state but disabled',{**feature_on,'state':{**feature_on['state'],'effectiveEnabled':False}}),
 ('blocked without reason',{**feature_off,'state':{**feature_off['state'],'effectiveState':'blocked','blockedReason':None}}),
 ('pending without apply boundary',{**feature_pending,'state':{k:v for k,v in feature_pending['state'].items() if k!='pendingApplyAt'}}),
]:
 check(bool(list(feature_validator.iter_errors(bad))),'feature exposure rejects '+label)

# Existing source anchors: source truth, not feature acceptance.
present=[
 'packages/core/src/session/runner/llm.ts','packages/core/src/tool/registry.ts',
 'packages/core/src/session/supervisor.ts','packages/core/src/horizon/skills/horizon-docs/SKILL.md',
 'packages/llm/src','packages/app','packages/desktop','packages/server','packages/opencode/src/lsp',
 'kernel/src/session_projection.rs','kernel/src/owner_log.rs','indexd/src'
]
for rel in present:
    check((R/rel).exists(),'missing purported existing source '+rel)

# External provenance: local unpublished Horizon base is not represented as a public tree link.
sources=load(A/'external-source-register.json')
hz=next((x for x in sources['repos'] if x.get('key')=='horizoncode'),None)
check(hz is not None,'horizoncode provenance row missing')
if hz:
    check(hz.get('pinned_tree') is None,'local unpublished Horizon base has fabricated public tree URL')
    check(hz.get('public_pin_status')=='local_head_not_present_on_remote_at_audit','missing first-party public pin status')
for repo in sources['repos']:
    if repo.get('key')=='horizoncode':continue
    sha=repo.get('pinned_commit','')
    check(bool(re.fullmatch(r'[0-9a-f]{40}',sha)),repo.get('key','?')+' source pin is not full SHA')
    check(repo.get('pinned_tree')==repo.get('canonical_url')+'/tree/'+sha,repo.get('key','?')+' immutable tree URL mismatch')

# No floating main/dev source links in active architecture.
floating=re.compile(r'https://github\.com/[^\s)\]]+/(?:blob|tree)/(?:main|dev)(?:/|$)')
for name in ACTIVE:
    check(not floating.search((A/name).read_text()),'floating main/dev source link in '+name)

# Markdown fence/link checks in active+stub docs.
for name in ACTIVE+STUBS:
    path=A/name;text=path.read_text()
    check(sum(1 for line in text.splitlines() if line.strip().startswith(chr(96)*3))%2==0,'backtick fence parity '+name)
    check(sum(1 for line in text.splitlines() if line.strip().startswith('~~~'))%2==0,'tilde fence parity '+name)
    for m in re.finditer(r'(?<!!)\[[^\]]+\]\(([^)]+)\)',text):
        dest=m.group(1).split('#')[0].strip()
        if not dest or dest.startswith(('http://','https://','mailto:','data:','/')):continue
        if ' ' in dest or '{' in dest:continue
        check((path.parent/dest).exists(),'broken link '+name+': '+dest)

# Operational entrypoints must point to the lean architecture/current plan.
plan=R/'docs/superpowers/plans/2026-10-11-horizoncode-converged-implementation.md'
check(plan.is_file(),'current implementation plan missing')
for rel in ['AGENTS.md','HANDOFF.md','IMPLEMENTER_PROMPT.md']:
    text=(R/rel).read_text()
    check('17-GOVERNANCE-DECISIONS.md' in text,rel+' lacks governance entrypoint')
    check('2026-10-11-horizoncode-converged-implementation.md' in text,rel+' lacks current implementation plan')

print('SCHEMA_FILES',len(schema_files))
print('CATALOG_IDS',len(catalog_ids),'REGISTRY_IDS',len(records))
print('CHECKS',checked,'FAILURES',len(failures))
for issue in failures[:100]:
    print('FAIL:',issue)
sys.exit(1 if failures else 0)
