"""Typed proof inputs for offline resource admission policy."""
import unittest

import admission_policy as ap


class TerminalReservationProofTests(unittest.TestCase):
    def test_terminal_proof_must_be_an_explicit_boolean(self):
        for label, invalid in (("integer", 1), ("string", "proof-present"),
                               ("object", object())):
            with self.subTest(value=label):
                with self.assertRaisesRegex(ValueError, "terminal_proof must be a bool"):
                    ap.reservation_headroom("RELEASED", 300, terminal_proof=invalid)

    def test_explicit_terminal_proof_controls_capacity_release(self):
        self.assertEqual(
            ap.reservation_headroom("RELEASED", 300, terminal_proof=False), 300)
        self.assertEqual(
            ap.reservation_headroom("RELEASED", 300, terminal_proof=True), 0)


if __name__ == "__main__":
    unittest.main()