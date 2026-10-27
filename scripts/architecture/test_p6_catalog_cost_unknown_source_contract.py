import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]
MODELS_DEV_PLUGIN_SOURCE = ROOT / "packages/core/src/plugin/models-dev.ts"


class ModelsDevUnknownPriceSourceContractTests(unittest.TestCase):
    """Protect the catalog adapter from fabricating zero-priced schedules."""

    def test_missing_rates_are_not_normalized_to_zero(self):
        source = MODELS_DEV_PLUGIN_SOURCE.read_text(encoding="utf-8")
        start = source.index("function cost(")
        end = source.index("\nfunction modeName", start)
        projection = source[start:end]
        for marker, message in (
            ("?? 0", "Models.dev price projection defaults missing rates to zero"),
            ("input: 0, output: 0", "mode-cost fallback fabricates a zero-priced schedule"),
        ):
            with self.subTest(marker=marker):
                if marker in projection:
                    self.fail(message)


if __name__ == "__main__":
    unittest.main()