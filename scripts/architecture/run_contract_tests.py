#!/usr/bin/env python3
"""Run contract-convergence static validation plus existing Bun/Rust ABI smoke tests.

This validates existing Session/IPC code alongside DESIGN-only JSON schemas.
It does not claim that the new Browser/LSP/Automation/UiEventMux interfaces exist.
"""
from pathlib import Path
import os,subprocess,sys,time
R=Path(__file__).resolve().parents[2]
env=dict(os.environ)
env['PATH']='/home/sarvesh/.cargo/bin:/home/sarvesh/.bun/bin:'+env.get('PATH','')
tests=[
 ('ARCHITECTURE_SCHEMA_REGISTRY',['python3','scripts/architecture/validate_convergence.py'],R,45),
 ('PINNED_SOURCE_IMPLEMENTATION_HANDOFF',['python3','scripts/architecture/validate_external_sources.py'],R,45),
 ('EXISTING_TS_RUST_SESSION_INTEROP',['bun','test','./test/kernel-projection-live.test.ts'],R/'packages/core',120),
 ('EXISTING_RUST_RPC_ABI',['cargo','test','--manifest-path',str(R/'kernel/Cargo.toml'),'--test','session_rpc_delivery','--locked','--offline'],R,120),
]
failed=[]
for label,cmd,cwd,limit in tests:
 print('START',label,' '.join(cmd),flush=True)
 try:
  result=subprocess.run(cmd,cwd=cwd,env=env,text=True,capture_output=True,timeout=limit)
  print('RESULT',label,'EXIT',result.returncode,'SECONDS_LIMIT',limit,flush=True)
  print('STDOUT_TAIL',result.stdout[-1500:],flush=True)
  print('STDERR_TAIL',result.stderr[-1500:],flush=True)
  if result.returncode:failed.append(label)
 except Exception as ex:
  failed.append(label)
  print('RESULT',label,'ERROR',repr(ex),flush=True)
print('SUMMARY',len(tests)-len(failed),'PASSED',len(failed),'FAILED',','.join(failed),flush=True)
print('LIMIT: new contracts-v2 service schemas are NOT wired/generated in real TS/Rust services; their runtime fixtures must be added at each C4 implementation gate.')
sys.exit(1 if failed else 0)
