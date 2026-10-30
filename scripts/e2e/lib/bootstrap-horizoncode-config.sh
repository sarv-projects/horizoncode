#!/usr/bin/env bash
# Shared HorizonCode E2E/dev bootstrap: primary AgentProfileV2 + top-level model pin.
# Without this, isolated runs default to opencode/big-pickle and slash commands
# that pin opencode/* models fail against a dead local gateway.
#
# Usage (after XDG_CONFIG_HOME is set):
#   . "$ROOT/scripts/e2e/lib/bootstrap-horizoncode-config.sh"
#   hz_bootstrap_horizoncode_config
#
hz_bootstrap_horizoncode_config() {
  local provider_id="${NEMOTRON_PROVIDER_ID:-nvidia}"
  local model_id="${NEMOTRON_MODEL_ID:-nvidia/nemotron-3.5-super-vl-120b-a12b}"
  mkdir -p "${XDG_CONFIG_HOME:?}/opencode"
  python3 - "$model_id" "$provider_id" >"$XDG_CONFIG_HOME/opencode/opencode.json" <<'PYCONFIG'
import json, sys
model_id, provider_id = sys.argv[1], sys.argv[2]
profile = {
    "schemaVersion": 2,
    "profileId": "user.primary",
    "revision": "1",
    "name": "HorizonCode Dev Primary",
    "description": "Primary profile for local and E2E Nemotron direct route",
    "source": "user",
    "roles": ["main"],
    "purpose": "Authorize the pinned Nemotron direct route",
    "whenToUse": "HorizonCode development and E2E",
    "whenNotToUse": "Production",
    "adapter": {"kind": "native", "adapterId": "horizon.native"},
    "model": {"providerId": provider_id, "modelId": model_id},
    "harness": "native-rich",
    "reasoning": "off",
    "variants": [],
    "instructions": {"extraRefs": [], "maxCompiledTokens": "4096"},
    "tools": [],
    "allowedSkillIds": [],
    "deniedSkillIds": [],
    "allowedMcpServers": [],
    "allowedMcpToolPatterns": [],
    "allowedSubagentIds": [],
    "deniedSubagentIds": [],
    "pathRules": [],
    "context": {"isolation": "fresh", "allowImages": False, "allowDocuments": False, "allowArtifacts": False},
    "inputMode": "default",
    "memoryPolicy": "none",
    "isolation": "workspace",
    "lifecycleHooks": [],
    "capabilityCeiling": [],
    "limits": {"maxDepth": 2, "maxActiveChildren": 2, "maxTotalChildren": 2, "maxPendingMessages": 8, "maxMessageBytes": 65536},
    "maxParallelChildren": 1,
    "enabled": True,
}
config = {
    "model": model_id if model_id.startswith(provider_id + "/") else "%s/%s" % (provider_id, model_id),
    "agent_profiles": [profile],
    "agent_profile_selectors": [{"selector": "primary", "profileId": "user.primary", "revision": "1"}],
    "primary_agent_profile_selector": "primary",
}
print(json.dumps(config))
PYCONFIG
}
