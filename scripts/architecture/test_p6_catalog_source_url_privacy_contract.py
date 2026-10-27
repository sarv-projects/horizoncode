import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]
MODELS_DEV_SOURCE = ROOT / "packages/core/src/models-dev.ts"
PROVIDER_HANDLER_SOURCE = ROOT / "packages/opencode/src/server/routes/instance/httpapi/handlers/provider.ts"
PROVIDER_DTO_SOURCE = ROOT / "packages/opencode/src/provider/provider.ts"


class CatalogSourceUrlPrivacyContractTests(unittest.TestCase):
    """Source-only privacy checks; these do not verify runtime redaction."""

    def test_provider_list_handler_does_not_forward_raw_source_url(self):
        source = PROVIDER_HANDLER_SOURCE.read_text(encoding="utf-8")
        if "sourceURL" in source:
            self.fail("Provider List handler still forwards raw catalog sourceURL")

    def test_provider_list_dto_does_not_publish_raw_source_url(self):
        source = PROVIDER_DTO_SOURCE.read_text(encoding="utf-8")
        if "sourceURL" in source:
            self.fail("Provider List DTO still declares raw catalog sourceURL")

    def test_refresh_failure_diagnostic_does_not_log_raw_cause_or_url(self):
        source = MODELS_DEV_SOURCE.read_text(encoding="utf-8")
        unsafe_log = 'Effect.logError("Failed to fetch models.dev", { cause: cause })'
        if unsafe_log in source:
            self.fail("Models.dev refresh diagnostic still logs a raw cause that may contain the URL")


if __name__ == "__main__":
    unittest.main()