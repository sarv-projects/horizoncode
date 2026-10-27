import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]
LLM_SOURCE = ROOT / "packages/opencode/src/session/llm.ts"
PROVIDER_SOURCE = ROOT / "packages/opencode/src/provider/provider.ts"


class DirectFreeCredentialSourceContractTests(unittest.TestCase):
    """Source-level denial guard; this is not runtime transport verification."""

    def test_llm_does_not_contain_direct_free_raw_key_flow(self):
        source = LLM_SOURCE.read_text(encoding="utf-8")
        for forbidden in (
            "HORIZON_DIRECT_FREE_CREDENTIALS",
            "resolveDirectFreeCredentialKey",
            "getDirectFreeLanguage",
        ):
            with self.subTest(forbidden=forbidden):

                if forbidden in source:
                    self.fail(f"forbidden direct-key source marker remains: {forbidden}")

    def test_provider_does_not_pass_explicit_key_to_bundled_sdk(self):
        source = PROVIDER_SOURCE.read_text(encoding="utf-8")
        if "apiKey: input.apiKey" in source:
            self.fail("bundled SDK receives the explicit apiKey input")

if __name__ == "__main__":
    unittest.main()