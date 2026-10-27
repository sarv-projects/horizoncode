"""Item-25 blocker fixture: `PreAdmissionReserved` lease-proof generation.

P2's managed admission reducer (`durable_lease_proof_matches_attempt`,
kernel/src/managed_control.rs:2435) requires a lease proof whose purpose is
`PreAdmissionReserved` with complete `pre_admission_pins`; the existing
`DurableManagedLeaseProofV1::test_fixture` mints `LegacyAdmitted`. These tests
pin the Python/data half: a fixture generator that derives the candidate tuple
and the Stage-A -> Stage-B digest chain from validated inputs and can never
emit a caller-chosen or broken-chain record.
"""
import hashlib
import json
import tempfile
import unittest
from pathlib import Path

import pre_admission_proof as pap
import eval_harness as evaluation

def _temporary_directory():
    temp_root = Path(__file__).resolve().parents[2] / ".tmp" / "tests-p8-proof"
    temp_root.mkdir(parents=True, exist_ok=True)
    return tempfile.TemporaryDirectory(dir=temp_root)


CANONICAL_FIXTURE = (Path(__file__).resolve().parents[2] / "kernel" / "tests"
                     / "fixtures" / "pre-admission-reserved-proof-v1.json")


class PreAdmissionFixtureShapeTests(unittest.TestCase):
    def record(self, **overrides):
        inputs = pap.canonical_input()
        for key, value in overrides.items():
            inputs[key] = value
        return pap.build_pre_admission_reserved_fixture(inputs)

    def test_fixture_has_the_exact_reducer_shape(self):
        record = self.record()
        self.assertEqual(record["schema"], pap.FIXTURE_SCHEMA)
        self.assertEqual(record["purpose"], "PreAdmissionReserved")
        self.assertEqual(record["stage"], "RESERVED_CONTEXT_BOUND")
        lease = record["leaseProof"]
        self.assertEqual(set(lease), set(pap.LEASE_PROOF_FIELDS))
        self.assertEqual(lease["purpose"], "PreAdmissionReserved")
        self.assertIsNone(lease["admissionPins"])
        self.assertIsNone(lease["delegation"])
        facts = lease["facts"]
        self.assertEqual(set(facts), set(pap.LEASE_FACTS_FIELDS))
        self.assertEqual(facts["workerState"], "RESERVED")
        self.assertEqual(facts["budgetDimension"], "ACTIVE_WORKERS")
        self.assertEqual(facts["reservedAmount"], 1)
        self.assertIsNone(facts["processIdentity"])
        pins = lease["preAdmissionPins"]
        self.assertEqual(set(pins), set(pap.PINS_FIELDS))
        self.assertEqual(pins["dimension"], "ACTIVE_WORKERS")
        self.assertEqual(pins["amount"], 1)
        self.assertTrue(pins["stagedPreAdmission"])
        self.assertRegex(pins["contextSelectionDigest"], r"blake3:[0-9a-f]{64}")

    def test_canonical_capability_ceiling_uses_guard_exact_sha256(self):
        inputs = pap.canonical_input()
        pins = inputs["pins"]
        owner = pins["owner"]
        builtin_owner_digest = "blake3:" + pap.blake3.blake3(
            b"horizoncode.agent-profile-owner.builtin.v1\0").hex()
        ceiling = {
            "acceptedScopeDigest": pins["acceptedScopeDigest"],
            "attemptID": owner["attemptId"],
            "capabilities": [],
            "guardPolicyRevision": pap._current_guard_policy_revision(),
            "ownerEpoch": str(owner["ownerEpoch"]),
            "profileDigest": pins["profileDigest"],
            "profileID": pins["profileId"],
            "profileOwnerBindingDigest": builtin_owner_digest,
            "profilePermissionDigest": pins["profilePermissionCeilingDigest"],
            "profileRevision": str(pins["profileRevision"]),
            "runID": owner["runId"],
            "schemaVersion": 1,
            "taskID": owner["taskId"],
        }
        preimage = (b"horizoncode.effective-capability-ceiling.v1\0"
                    + pap._messagepack_value(ceiling))
        expected = "sha256:" + hashlib.sha256(preimage).hexdigest()
        self.assertEqual(pins["capabilityCeilingDigest"], expected)
        self.assertRegex(expected, r"^sha256:[0-9a-f]{64}$")
        self.assertNotRegex(pins["capabilityCeilingDigest"], r"^blake3:")
        pap.build_pre_admission_reserved_fixture(inputs)

    def test_candidate_tuple_is_derived_not_caller_chosen(self):
        record = self.record()
        derived = record["derived"]
        attempt_id = derived["candidateAttemptID"]
        self.assertRegex(attempt_id, r"attempt_[0-9a-f]{64}")
        self.assertEqual(derived["childSessionID"], f"ses_managed_{attempt_id}")
        pins_digest = record["digestChain"]["pinsDigest"]
        suffix = pins_digest.removeprefix("blake3:")
        self.assertEqual(derived["ticketID"], f"worker-ticket-{suffix}")
        self.assertEqual(derived["workerExecutionID"], f"worker-execution-{suffix}")
        self.assertEqual(derived["budgetLeaseID"],
                         f"worker-reservation-worker-execution-{suffix}")
        owner = record["leaseProof"]["preAdmissionPins"]["owner"]
        self.assertEqual(owner["attemptId"], attempt_id)
        self.assertEqual(owner["sessionId"], derived["childSessionID"])

    def test_digest_chain_recomputes_exactly(self):
        record = self.record()
        chain = record["digestChain"]
        pins = record["leaseProof"]["preAdmissionPins"]
        self.assertEqual(chain["pinsDigest"], pap.compute_pins_digest(pins))
        stage_a = record["stageAReservation"]
        stage_b = record["stageBReservation"]
        derived = record["derived"]
        self.assertEqual(
            chain["stageAProofDigest"],
            pap.stage_a_proof_digest(chain["pinsDigest"],
                                     derived["workerExecutionID"],
                                     derived["ticketID"],
                                     stage_a["workspaceLeaseId"]))
        self.assertEqual(chain["stageALeaseProofDigest"],
                         pap.lease_proof_digest(stage_a))
        self.assertEqual(chain["contextSelectionDigest"],
                         pins["contextSelectionDigest"])
        self.assertEqual(stage_b["contextSelectionDigest"],
                         pins["contextSelectionDigest"])
        self.assertIsNone(stage_a["contextSelectionDigest"])
        self.assertEqual(chain["stageBReceiptDigest"],
                         pap.context_bound_receipt_digest(stage_b))
        # Stage-A proof binds the pins digest; Stage-B receipt binds the context.
        self.assertIn(chain["pinsDigest"],
                      pap.stage_a_proof_digest_inputs(stage_a))

    def test_fixture_is_json_round_trip_stable(self):
        record = self.record()
        self.assertEqual(json.loads(json.dumps(record, sort_keys=True)), record)


class PreAdmissionFixtureNegativeTests(unittest.TestCase):
    def record(self, **overrides):
        inputs = pap.canonical_input()
        for key, value in overrides.items():
            inputs[key] = value
        return pap.build_pre_admission_reserved_fixture(inputs)

    def test_missing_manifest_produces_no_fixture(self):
        inputs = pap.canonical_input()
        del inputs["manifest"]
        with self.assertRaisesRegex(pap.PreAdmissionFixtureError, "manifest"):
            pap.build_pre_admission_reserved_fixture(inputs)
        inputs = pap.canonical_input()
        inputs["manifest"] = {"schema": evaluation.SCHEMA}
        with self.assertRaises(evaluation.EvalError):
            pap.build_pre_admission_reserved_fixture(inputs)

    def test_manifest_task_link_is_required(self):
        inputs = pap.canonical_input()
        inputs["taskId"] = "fixture-foreign"
        with self.assertRaisesRegex(pap.PreAdmissionFixtureError, "taskId"):
            pap.build_pre_admission_reserved_fixture(inputs)

    def test_missing_pin_field_produces_no_fixture(self):
        for path in (("profileDigest",), ("expiresAtMs",),
                     ("owner", "principalRef"), ("worktree", "worktreeId"),
                     ("resourcePolicyDigest",)):
            inputs = pap.canonical_input()
            target = inputs["pins"]
            for key in path[:-1]:
                target = target[key]
            del target[path[-1]]
            with self.subTest(missing=".".join(path)):
                with self.assertRaisesRegex(pap.PreAdmissionFixtureError,
                                            "missing"):
                    pap.build_pre_admission_reserved_fixture(inputs)

    def test_wrong_purpose_claim_produces_no_fixture(self):
        inputs = pap.canonical_input()
        inputs["claims"] = {"purpose": "LegacyAdmitted"}
        with self.assertRaisesRegex(pap.PreAdmissionFixtureError, "purpose"):
            pap.build_pre_admission_reserved_fixture(inputs)
        inputs = pap.canonical_input()
        inputs["claims"] = {"purpose": "AttachedAttempt"}
        with self.assertRaisesRegex(pap.PreAdmissionFixtureError, "purpose"):
            pap.build_pre_admission_reserved_fixture(inputs)

    def test_digest_chain_break_produces_no_fixture(self):
        for field, message in (("pinsDigest", "pins digest"),
                               ("stageAProofDigest", "Stage-A proof digest"),
                               ("stageBReceiptDigest", "Stage-B receipt digest")):
            inputs = pap.canonical_input()
            inputs["claims"] = {field: "blake3:" + "0" * 64}
            with self.subTest(claim=field):
                with self.assertRaisesRegex(pap.PreAdmissionFixtureError, message):
                    pap.build_pre_admission_reserved_fixture(inputs)

    def test_caller_chosen_tuple_produces_no_fixture(self):
        inputs = pap.canonical_input()
        inputs["claims"] = {"candidateAttemptID": "attempt_" + "0" * 64}
        with self.assertRaisesRegex(pap.PreAdmissionFixtureError,
                                    "candidate Attempt"):
            pap.build_pre_admission_reserved_fixture(inputs)
        inputs = pap.canonical_input()
        inputs["claims"] = {"childSessionID": "ses_managed_attempt_" + "0" * 64}
        with self.assertRaisesRegex(pap.PreAdmissionFixtureError, "child Session"):
            pap.build_pre_admission_reserved_fixture(inputs)
        inputs = pap.canonical_input()
        inputs["pins"]["owner"]["attemptId"] = "attempt_" + "0" * 64
        with self.assertRaisesRegex(pap.PreAdmissionFixtureError, "attemptId"):
            pap.build_pre_admission_reserved_fixture(inputs)
        inputs = pap.canonical_input()
        inputs["pins"]["owner"]["sessionId"] = "ses_managed_attempt_" + "0" * 64
        with self.assertRaisesRegex(pap.PreAdmissionFixtureError, "sessionId"):
            pap.build_pre_admission_reserved_fixture(inputs)

    def test_mismatched_capability_ceiling_claim_produces_no_fixture(self):
        for digest, message in (("sha256:" + "00" * 32, "Guard-derived"),
                                ("blake3:" + "00" * 32, "sha256")):
            inputs = pap.canonical_input()
            inputs["pins"]["capabilityCeilingDigest"] = digest
            with self.subTest(digest=digest[:12]):
                with self.assertRaisesRegex(pap.PreAdmissionFixtureError, message):
                    pap.build_pre_admission_reserved_fixture(inputs)

    def test_invalid_digest_format_produces_no_fixture(self):
        inputs = pap.canonical_input()
        inputs["contextSelectionDigest"] = "sha256:" + "0" * 64
        with self.assertRaisesRegex(pap.PreAdmissionFixtureError, "blake3"):
            pap.build_pre_admission_reserved_fixture(inputs)


class PreAdmissionFixtureWriterTests(unittest.TestCase):
    def directory(self):
        temp = _temporary_directory()
        self.addCleanup(temp.cleanup)
        root = Path(temp.name) / "kernel" / "tests" / "fixtures"
        root.mkdir(parents=True)
        return root

    def test_writer_creates_a_new_fixture_exactly_once(self):
        record = pap.build_pre_admission_reserved_fixture(pap.canonical_input())
        directory = self.directory()
        path = directory / "pre-admission-reserved-proof-v1.json"
        pap.write_fixture(record, path)
        payload = path.read_text(encoding="utf-8")
        self.assertEqual(payload,
                         json.dumps(record, sort_keys=True,
                                    separators=(",", ":")) + "\n")
        with self.assertRaisesRegex(pap.PreAdmissionFixtureError, "already exists"):
            pap.write_fixture(record, path)

    def test_writer_refuses_names_outside_the_new_fixture_contract(self):
        record = pap.build_pre_admission_reserved_fixture(pap.canonical_input())
        directory = self.directory()
        for name in ("reservation-wire-v1.json", "pre-admission-reserved.json.bak",
                     "pre-admission-reserved-"):
            with self.subTest(name=name):
                with self.assertRaisesRegex(pap.PreAdmissionFixtureError, "pre-admission-reserved-"):
                    pap.write_fixture(record, directory / name)

    def test_writer_refuses_a_directory_outside_kernel_tests_fixtures(self):
        record = pap.build_pre_admission_reserved_fixture(pap.canonical_input())
        temp = _temporary_directory()
        self.addCleanup(temp.cleanup)
        elsewhere = Path(temp.name) / "elsewhere"
        elsewhere.mkdir()
        with self.assertRaisesRegex(pap.PreAdmissionFixtureError, "kernel/tests/fixtures"):
            pap.write_fixture(record,
                              elsewhere / "pre-admission-reserved-x.json")

    def test_committed_fixture_is_new_and_matches_the_generator(self):
        self.assertTrue(CANONICAL_FIXTURE.exists(),
                        "canonical fixture must be emitted as a NEW file")
        committed = json.loads(CANONICAL_FIXTURE.read_text(encoding="utf-8"))
        self.assertEqual(committed, pap.build_pre_admission_reserved_fixture(
            pap.canonical_input()))
        self.assertEqual(committed["purpose"], "PreAdmissionReserved")


if __name__ == "__main__":
    unittest.main()
