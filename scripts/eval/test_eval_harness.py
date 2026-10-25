"""Unrun HUP-005 fixtures for the offline fake-only paired evaluator."""
import json
import os
import tempfile
import unittest
from dataclasses import replace
from pathlib import Path
from unittest.mock import patch

import eval_harness as evaluation


def response(output="ok", expected="ok", capability_complete=True):
    return evaluation.FakeResponse(output, expected, "fixture-oracle-evidence", elapsed_ms=3,
                                   input_tokens=2, output_tokens=1, cost_micros=4,
                                   capability_complete=capability_complete, tool_calls=2, retries=0)


def provider_for(manifest, overrides=None):
    values = {}
    overrides = overrides or {}
    for task in manifest["tasks"]:
        for arm in (item["id"] for item in manifest["arms"]):
            values[(task["taskId"], arm)] = overrides.get((task["taskId"], arm), response())
    return evaluation.FixtureFakeProvider(values)


def ablation_manifest(feature="delegation"):
    manifest = evaluation.selfcheck_manifest()
    manifest["runId"] = f"hup005-ablation-{feature}"
    manifest["comparison"] = {"kind": "full_vs_ablation", "referenceArmId": "full",
                               "candidateArmId": "ablation", "ablatedFeature": feature}
    manifest["arms"] = [
        {"id": "full", "harnessDigest": evaluation.digest("full-fixture"),
         "harnessCommit": "fixture-source-v1",
         "declaredFactor": "horizoncode_harness"},
        {"id": "ablation", "harnessDigest": evaluation.digest(f"without:{feature}"),
         "harnessCommit": "fixture-source-v1",
         "declaredFactor": f"without:{feature}"},
    ]
    return manifest


class EvaluationManifestTests(unittest.TestCase):
    def test_seeded_pair_order_is_reproducible_and_contains_each_arm_once(self):
        manifest = evaluation.selfcheck_manifest()
        first = evaluation.paired_call_plan(manifest)
        second = evaluation.paired_call_plan(manifest)
        self.assertEqual(first, second)
        for task in manifest["tasks"]:
            self.assertEqual({arm for task_id, arm in first if task_id == task["taskId"]}, set(evaluation.ARMS))
        first_arms = [first[index][1] for index in range(0, len(first), 2)]
        self.assertLessEqual(abs(first_arms.count("minimal") - first_arms.count("horizoncode")), 1)

    def test_pair_order_cannot_override_the_frozen_manifest_seed(self):
        manifest = evaluation.selfcheck_manifest()
        with self.assertRaises(evaluation.EvalError):
            evaluation.paired_call_plan(manifest, seed=manifest["seed"] + 1)
        with self.assertRaises(evaluation.EvalError):
            evaluation.paired_call_plan(manifest, seed=True)
        self.assertEqual(evaluation.paired_call_plan(manifest, seed=manifest["seed"]),
                         evaluation.paired_call_plan(manifest))

    def test_manifest_rejects_duplicate_task_ids_and_duplicate_json_fields(self):
        manifest = evaluation.selfcheck_manifest()
        manifest["tasks"].append(dict(manifest["tasks"][0]))
        with self.assertRaises(evaluation.EvalError):
            evaluation.validate_manifest(manifest)
        with self.assertRaises(evaluation.EvalError):
            evaluation.json.loads('{"schema":"a","schema":"b"}',
                                  object_pairs_hook=evaluation._pairs_no_duplicates)

    def test_manifest_reader_rejects_symlink_and_oversized_file(self):
        with tempfile.TemporaryDirectory(dir=Path(__file__).resolve().parent) as directory:
            root = Path(directory)
            manifest_path = root / "manifest.json"
            manifest_path.write_text(json.dumps(evaluation.selfcheck_manifest()))
            link = root / "link.json"
            link.symlink_to(manifest_path)
            with self.assertRaises(evaluation.EvalError):
                evaluation.load_manifest(link)
            manifest_path.write_bytes(b"{" + b" " * evaluation.MAX_MANIFEST_BYTES)
            with self.assertRaises(evaluation.EvalError):
                evaluation.load_manifest(manifest_path)

    def test_arm_route_and_budget_parity_is_structural(self):
        manifest = evaluation.selfcheck_manifest()
        self.assertEqual(manifest["arms"], [
            {"id": "minimal", "harnessDigest": evaluation.digest("minimal-fixture"),
             "harnessCommit": "fixture-source-v1",
             "declaredFactor": "minimal_single_turn"},
            {"id": "horizoncode", "harnessDigest": evaluation.digest("horizoncode-fixture"),
             "harnessCommit": "fixture-source-v1",
             "declaredFactor": "horizoncode_harness"},
        ])
        self.assertIn("providerRoute", manifest["shared"])
        self.assertIn("budgets", manifest["shared"])
        broken = json.loads(json.dumps(manifest))
        broken["arms"][0]["providerRoute"] = "different-route"
        with self.assertRaises(evaluation.EvalError):
            evaluation.validate_manifest(broken)

    def test_development_smoke_and_heldout_partitions_cannot_overlap(self):
        manifest = evaluation.selfcheck_manifest()
        manifest["taskPartitions"]["heldout"] = ["fixture-1"]
        with self.assertRaises(evaluation.EvalError):
            evaluation.validate_manifest(manifest)

    def test_boolean_cancellation_limit_is_not_accepted_as_an_integer(self):
        manifest = evaluation.selfcheck_manifest()
        manifest["cancelAfterCalls"] = True
        with self.assertRaises(evaluation.EvalError):
            evaluation.validate_manifest(manifest)

    def test_cost_ceiling_must_be_a_finite_nonnegative_integer(self):
        for invalid in (None, True, -1, 1.5):
            manifest = evaluation.selfcheck_manifest()
            manifest["shared"]["budgets"]["costMicros"] = invalid
            with self.subTest(invalid=invalid), self.assertRaises(evaluation.EvalError):
                evaluation.validate_manifest(manifest)

    def test_model_class_is_required_and_reported_for_each_frozen_bundle(self):
        for model_class in evaluation.MODEL_CLASSES:
            manifest = evaluation.selfcheck_manifest()
            manifest["shared"]["modelClass"] = model_class
            manifest["shared"]["providerRoute"] = (
                "local/llama" if model_class == "local" else f"fixture/{model_class}")
            evaluation.validate_manifest(manifest)
            self.assertEqual(manifest["shared"]["modelClass"], model_class)
        for invalid in (None, "", "SMALL", "frontier", 1, True):
            manifest = evaluation.selfcheck_manifest()
            manifest["shared"]["modelClass"] = invalid
            with self.subTest(invalid=invalid), self.assertRaises(evaluation.EvalError):
                evaluation.validate_manifest(manifest)
        missing = evaluation.selfcheck_manifest()
        del missing["shared"]["modelClass"]
        with self.assertRaises(evaluation.EvalError):
            evaluation.validate_manifest(missing)

    def test_analysis_rejects_nonfinite_values(self):
        manifest = evaluation.selfcheck_manifest()
        manifest["analysis"]["minimumMeaningfulDifferencePp"] = float("nan")
        with self.assertRaises(evaluation.EvalError):
            evaluation.validate_manifest(manifest)

class FakeEvaluationTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory(dir=Path(__file__).resolve().parent)
        self.artifact = Path(self.directory.name) / "result.jsonl"
        self.manifest = evaluation.selfcheck_manifest()

    def tearDown(self):
        self.directory.cleanup()

    def test_pair_summary_rejects_duplicate_foreign_and_stale_rows(self):
        result = evaluation.run_fake_selfcheck(self.manifest, provider_for(self.manifest), self.artifact)
        with self.assertRaises(evaluation.EvalError):
            evaluation.summarize_pairs((*result.records, result.records[0]), self.manifest)
        unknown = dict(result.records[0], taskId="not-in-manifest")
        with self.assertRaises(evaluation.EvalError):
            evaluation.summarize_pairs((unknown,), self.manifest)
        stale = dict(result.records[0], manifestDigest="sha256:" + "0" * 64)
        with self.assertRaises(evaluation.EvalError):
            evaluation.summarize_pairs((stale,), self.manifest)

    def test_fake_selfcheck_is_task_isolated_scored_and_persisted(self):
        provider = provider_for(self.manifest)
        result = evaluation.run_fake_selfcheck(self.manifest, provider, self.artifact)
        self.assertEqual(result.mode, "FAKE_SELF_CHECK")
        self.assertFalse(result.official_score_eligible)
        self.assertEqual(len(result.records), 4)
        self.assertTrue(all(row["status"] == "PASS_VERIFIED" for row in result.records))
        self.assertEqual(len({row["manifestDigest"] for row in result.records}), 1)
        self.assertEqual(len({call.shared_digest for call in provider.calls}), 1)
        self.assertEqual({(call.task_id, call.arm_id) for call in provider.calls},
                         {(task["taskId"], arm) for task in self.manifest["tasks"] for arm in evaluation.ARMS})
        self.assertEqual(self.artifact.read_bytes().count(b"\n"), 5)  # frozen manifest header + four trials
        self.assertEqual(result.artifact_digest, "sha256:" + __import__("hashlib").sha256(
            self.artifact.read_bytes()).hexdigest())

    def test_oracle_mismatch_fails_without_claiming_pass(self):
        provider = provider_for(self.manifest, {("fixture-1", "minimal"): response("wrong", "ok")})
        result = evaluation.run_fake_selfcheck(self.manifest, provider, self.artifact)
        row = next(item for item in result.records if item["taskId"] == "fixture-1" and item["armId"] == "minimal")
        self.assertEqual(row["status"], "FAIL_UNVERIFIED")
        self.assertEqual(row["failureClass"], "unknown")
        self.assertEqual(row["fixtureOutput"], "wrong")

    def test_fake_provider_rejects_boolean_or_overflow_accounting(self):
        bad = evaluation.FakeResponse("ok", "ok", "evidence", tool_calls=True)
        provider = provider_for(self.manifest, {("fixture-1", "minimal"): bad})
        result = evaluation.run_fake_selfcheck(self.manifest, provider, self.artifact)
        row = next(item for item in result.records
                   if item.get("taskId") == "fixture-1" and item.get("armId") == "minimal")
        self.assertEqual(row["status"], "INFRASTRUCTURE_FAILURE")

    def test_budget_exhaustion_cannot_be_scored_as_pass(self):
        over = evaluation.FakeResponse("ok", "ok", "fixture-oracle-evidence", tool_calls=5)
        provider = provider_for(self.manifest, {("fixture-1", "minimal"): over})
        result = evaluation.run_fake_selfcheck(self.manifest, provider, self.artifact)
        row = next(item for item in result.records
                   if item.get("taskId") == "fixture-1" and item.get("armId") == "minimal")
        self.assertEqual(row["status"], "FAIL_UNVERIFIED")
        self.assertEqual(row["failureClass"], "budget_exhaustion")
        self.assertEqual(row["evidenceStage"], "budget_exhaustion")

    def test_paired_summary_uses_only_complete_pairs_and_reports_absolute_delta(self):
        provider = provider_for(self.manifest, {
            ("fixture-1", "minimal"): response("wrong", "ok"),
            ("fixture-1", "horizoncode"): response("ok", "ok"),
            ("fixture-2", "horizoncode"): RuntimeError("fixture infra"),
        })
        result = evaluation.run_fake_selfcheck(self.manifest, provider, self.artifact)
        summary = evaluation.summarize_pairs(result.records, self.manifest)
        self.assertEqual(summary["completePairs"], 1)
        self.assertEqual(summary["incompletePairs"], 1)
        self.assertEqual(summary["absoluteChangePercentagePoints"], 100.0)
        self.assertEqual(summary["relativeUplift"], None)  # baseline pass rate is zero
        self.assertFalse(summary["officialScoreEligible"])
        self.assertIsNone(summary["elapsedMs"])
        self.assertTrue(summary["elapsedTimeUnknown"])
        self.assertTrue(summary["costUnknown"])

    def test_pair_summary_reports_all_invoked_arm_accounting(self):
        result = evaluation.run_fake_selfcheck(self.manifest, provider_for(self.manifest), self.artifact)
        summary = evaluation.summarize_pairs(result.records, self.manifest)
        self.assertEqual(summary["elapsedMs"], 12)
        self.assertEqual(summary["inputTokens"], 8)
        self.assertEqual(summary["outputTokens"], 4)
        self.assertEqual(summary["toolCalls"], 8)
        self.assertEqual(summary["retries"], 0)
        self.assertEqual(summary["costMicros"], 16)
        self.assertEqual(summary["costProvenance"], "FIXTURE_REPORTED")
        self.assertFalse(summary["costUnknown"])

    def test_full_vs_single_feature_ablation_has_explicit_roles(self):
        manifest = ablation_manifest("repointel")
        artifact = self.artifact.with_name("ablation.jsonl")
        result = evaluation.run_fake_selfcheck(manifest, provider_for(manifest), artifact)
        summary = evaluation.summarize_pairs(result.records, manifest)
        self.assertEqual(summary["comparisonKind"], "full_vs_ablation")
        self.assertEqual(summary["referenceArmId"], "full")
        self.assertEqual(summary["candidateArmId"], "ablation")
        self.assertEqual(summary["ablatedFeature"], "repointel")
        self.assertIsNone(summary["baselinePasses"])
        self.assertIsNone(summary["harnessPasses"])

    def test_report_pins_required_provenance_and_marks_fake_metrics_honestly(self):
        result = evaluation.run_fake_selfcheck(self.manifest, provider_for(self.manifest), self.artifact)
        report = evaluation.evaluation_report(result, self.manifest)
        self.assertFalse(report["officialScoreEligible"])
        self.assertEqual(report["authorityStatus"], "FAKE_SELF_CHECK_ONLY")
        self.assertEqual(report["rawArtifactDigest"], result.artifact_digest)
        self.assertEqual(report["taskIds"], ["fixture-1", "fixture-2"])
        self.assertEqual(report["arms"][0]["harnessCommit"], "fixture-source-v1")
        self.assertEqual(report["sharedConfiguration"]["modelClass"], "small")
        self.assertEqual(report["summary"]["resourceUse"]["status"], "UNKNOWN")
        self.assertEqual(report["summary"]["statusCounts"]["PASS_VERIFIED"], 4)
        self.assertEqual(report["summary"]["costProvenance"], "FIXTURE_REPORTED")
        self.assertEqual(report["summary"]["accountingByArm"]["minimal"]["invocations"], 2)
        self.assertEqual(report["summary"]["accountingByArm"]["horizoncode"]["invocations"], 2)
        self.assertIn("failureStageCounts", report["summary"]["accountingByArm"]["minimal"])

    def test_grouped_interval_is_reported_and_cannot_complete_hup001(self):
        provider = provider_for(self.manifest, {
            ("fixture-1", "minimal"): response("wrong", "ok"),
            ("fixture-1", "horizoncode"): response(),
            ("fixture-2", "minimal"): response(),
            ("fixture-2", "horizoncode"): response(),
        })
        result = evaluation.run_fake_selfcheck(self.manifest, provider, self.artifact)
        summary = evaluation.summarize_pairs(result.records, self.manifest)
        self.assertEqual(summary["pairedUncertaintyInterval"]["method"],
                         "repository_cluster_bootstrap_percentile")
        self.assertEqual(summary["pairedUncertaintyInterval"]["independentRepositoryGroups"], 2)
        self.assertEqual(summary["hup001Complete"], False)
        self.assertNotEqual(summary["gainEvidence"], "MEANINGFUL_GAIN_SUPPORTED")

    def test_infrastructure_fault_is_not_a_task_failure_or_pass(self):
        provider = provider_for(self.manifest, {("fixture-1", "minimal"): RuntimeError("transport")})
        result = evaluation.run_fake_selfcheck(self.manifest, provider, self.artifact)
        infra_index = next(index for index, row in enumerate(result.records)
                           if row["status"] == "INFRASTRUCTURE_FAILURE")
        self.assertEqual(result.records[infra_index]["failureClass"], "infrastructure")
        self.assertEqual(len(result.records), 4)
        self.assertTrue(all(row["status"] == "NOT_RUN" for row in result.records[infra_index + 1:]))

    def test_unsupported_capability_is_retained_separately_and_resumes_without_repeat(self):
        unsupported_key = ("fixture-1", "minimal")
        provider = provider_for(self.manifest, {unsupported_key: response(capability_complete=False)})
        result = evaluation.run_fake_selfcheck(self.manifest, provider, self.artifact)
        self.assertTrue(any(row["status"] == "UNSUPPORTED_CAPABILITY" for row in result.records))
        summary = evaluation.summarize_pairs(result.records, self.manifest)
        self.assertEqual(summary["capabilityIncompletePairs"], 1)
        resumed_provider = provider_for(self.manifest)
        resumed = evaluation.run_fake_selfcheck(self.manifest, resumed_provider, self.artifact)
        self.assertEqual(len(resumed.records), 4)
        self.assertNotIn(unsupported_key, {(call.task_id, call.arm_id) for call in resumed_provider.calls})

    def test_cancellation_is_recorded_and_stops_later_calls(self):
        self.manifest["cancelAfterCalls"] = 1
        provider = provider_for(self.manifest)
        result = evaluation.run_fake_selfcheck(self.manifest, provider, self.artifact)
        self.assertEqual(next(row["status"] for row in result.records if row["status"] == "CANCELLED"), "CANCELLED")
        self.assertEqual(len(result.records), 4)
        cancellation_index = next(index for index, row in enumerate(result.records)
                                  if row["status"] == "CANCELLED")
        cancellation = result.records[cancellation_index]
        self.assertFalse(cancellation["dispatchStarted"])
        self.assertNotIn("providerCallIndex", cancellation)
        self.assertTrue(all(row["status"] == "NOT_RUN" for row in result.records[cancellation_index + 1:]))
        self.assertEqual(len(provider.calls), 1)

    def test_resume_reuses_exact_completed_task_arm_without_repeating_it(self):
        frozen_digest = evaluation.digest(self.manifest)
        first_task, first_arm = evaluation.paired_call_plan(self.manifest)[0]
        task_group = next(task["taskGroup"] for task in self.manifest["tasks"] if task["taskId"] == first_task)
        journal = evaluation._ArtifactJournal(self.artifact, self.manifest, frozen_digest)
        journal.append({"taskId": first_task, "taskGroup": task_group, "armId": first_arm,
                        "manifestDigest": frozen_digest, "providerCallIndex": 0,
                        "status": "PASS_VERIFIED", "failureClass": "none",
                        "dispatchStarted": True, "mode": "FAKE_SELF_CHECK"})
        journal.close()
        provider = provider_for(self.manifest)
        result = evaluation.run_fake_selfcheck(self.manifest, provider, self.artifact)
        self.assertEqual(len(result.records), 4)
        self.assertNotIn((first_task, first_arm), {(call.task_id, call.arm_id) for call in provider.calls})
        self.assertEqual(len(provider.calls), 3)

    def test_resume_rejects_duplicate_provider_call_indexes(self):
        evaluation.run_fake_selfcheck(self.manifest, provider_for(self.manifest), self.artifact)
        rows = [json.loads(line) for line in self.artifact.read_text().splitlines()]
        trials = [row for row in rows[1:] if row["recordType"] == "trial"]
        trials[1]["providerCallIndex"] = trials[0]["providerCallIndex"]
        self.artifact.write_text("\n".join(json.dumps(row) for row in rows) + "\n")
        with self.assertRaisesRegex(evaluation.EvalError, "provider call indexes"):
            evaluation.run_fake_selfcheck(self.manifest, provider_for(self.manifest), self.artifact)

    def test_non_development_or_non_fake_manifest_is_rejected(self):
        manifest = evaluation.selfcheck_manifest()
        manifest["lane"] = "heldout"
        with self.assertRaises(evaluation.EvalError):
            evaluation.run_fake_selfcheck(manifest, provider_for(manifest), self.artifact)

    def test_artifact_persistence_preserves_unrelated_partial_file(self):
        # A stale similarly named file is unrelated; the JSONL journal appends only
        # to its pinned artifact and never removes neighboring files.
        stale = self.artifact.with_name(self.artifact.name + ".partial")
        stale.write_text("owned elsewhere")
        evaluation.run_fake_selfcheck(self.manifest, provider_for(self.manifest), self.artifact)
        self.assertEqual(stale.read_text(), "owned elsewhere")
        self.assertTrue(self.artifact.exists())

    def test_artifact_rejects_symlink_components_and_replaced_file_identity(self):
        link = Path(self.directory.name) / "link"
        link.symlink_to(self.directory.name, target_is_directory=True)
        with self.assertRaises(evaluation.EvalError):
            evaluation.run_fake_selfcheck(self.manifest, provider_for(self.manifest), link / "linked.jsonl")

        pinned_path = Path(self.directory.name) / "pinned.jsonl"
        journal = evaluation._ArtifactJournal(pinned_path, self.manifest, evaluation.digest(self.manifest))
        pinned_path.unlink()
        pinned_path.write_text("replacement")
        with self.assertRaises(evaluation.EvalError):
            journal.append({"taskId": "fixture-1", "armId": "minimal",
                            "manifestDigest": evaluation.digest(self.manifest),
                            "status": "PASS_VERIFIED", "mode": "FAKE_SELF_CHECK"})
        journal.close()

        concurrent_path = Path(self.directory.name) / "concurrent.jsonl"
        concurrent = evaluation._ArtifactJournal(concurrent_path, self.manifest,
                                                 evaluation.digest(self.manifest))
        with concurrent_path.open("ab") as stream:
            stream.write(b"external\n")
        with self.assertRaises(evaluation.EvalError):
            concurrent.append({"taskId": "fixture-1", "armId": "minimal",
                               "manifestDigest": evaluation.digest(self.manifest),
                               "status": "PASS_VERIFIED", "mode": "FAKE_SELF_CHECK"})
        concurrent.close()

    def test_artifact_rejects_lexically_external_path_without_access(self):
        with self.assertRaises(evaluation.EvalError):
            evaluation.run_fake_selfcheck(self.manifest, provider_for(self.manifest), Path("../outside.jsonl"))

    def test_artifact_resume_rejects_group_or_world_accessible_file(self):
        evaluation.run_fake_selfcheck(self.manifest, provider_for(self.manifest), self.artifact)
        self.artifact.chmod(0o640)
        with self.assertRaisesRegex(evaluation.EvalError, "private repository-local regular file"):
            evaluation._ArtifactJournal(
                self.artifact, self.manifest, evaluation.digest(self.manifest))

    def test_artifact_rejects_deep_json_and_closes_all_descriptors(self):
        evaluation.run_fake_selfcheck(self.manifest, provider_for(self.manifest), self.artifact)
        with self.artifact.open('ab') as stream:
            stream.write((b'[' * 10_000) + b'0' + (b']' * 10_000) + b'\n')

        real_open, real_close = os.open, os.close
        opened, closed = [], []

        def tracked_open(*args, **kwargs):
            fd = real_open(*args, **kwargs)
            opened.append(fd)
            return fd

        def tracked_close(fd):
            closed.append(fd)
            return real_close(fd)

        with patch.object(evaluation.os, 'open', new=tracked_open), \
                patch.object(evaluation.os, 'close', new=tracked_close), \
                patch.object(evaluation.os, 'supports_dir_fd',
                             os.supports_dir_fd | {tracked_open}):
            with self.assertRaisesRegex(evaluation.EvalError, 'malformed JSON'):
                evaluation._ArtifactJournal(
                    self.artifact, self.manifest, evaluation.digest(self.manifest))
        self.assertCountEqual(opened, closed)


class HostRunBoundaryTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory(dir=Path(__file__).resolve().parent)
        self.artifact = Path(self.directory.name) / "host-run.jsonl"
        self.manifest = evaluation.selfcheck_manifest()
        self.manifest.pop("fakeSelfcheck")
        self.manifest["runId"] = "hup001-host-boundary-fixture"
        self.manifest["shared"]["providerRoute"] = "explicit-selected-route"
        self.manifest["shared"]["modelRevision"] = "selected-model-revision"
        self.tasks = {}
        for task in self.manifest["tasks"]:
            local = {"taskId": task["taskId"], "taskGroup": task["taskGroup"],
                     "input": {"prompt": "bounded fixture task"}}
            task["inputDigest"] = evaluation.digest(local)
            self.tasks[task["taskId"]] = local

    def tearDown(self):
        self.directory.cleanup()

    def write_task_catalog(self, path, *, changed_input=False):
        header = {"recordType": "catalog", "schema": evaluation.RepositoryTaskImageResolver.SCHEMA,
                  "benchmarkDigest": evaluation.digest(self.manifest["benchmark"]),
                  "repositoryImageDigest": self.manifest["shared"]["repositoryImageDigest"],
                  "taskCount": len(self.manifest["tasks"])}
        rows = [header]
        for index, task in enumerate(self.manifest["tasks"]):
            envelope = self.tasks[task["taskId"]]
            if changed_input and index == 0:
                envelope = {**envelope, "input": {"prompt": "changed"}}
            rows.append({"recordType": "task", "taskId": task["taskId"],
                         "taskGroup": task["taskGroup"], "input": envelope["input"]})
        path.write_bytes(b"".join(evaluation.canonical_json(row) + b"\n" for row in rows))

    def test_repository_task_catalog_is_frozen_bounded_and_repository_local(self):
        path = Path(self.directory.name) / "tasks.jsonl"
        self.write_task_catalog(path)
        resolver = evaluation.RepositoryTaskImageResolver(path, self.manifest)
        first = self.manifest["tasks"][0]["taskId"]
        self.assertEqual(resolver.resolve_task(first), self.tasks[first])
        with self.assertRaises(evaluation.EvalError):
            resolver.resolve_task("outside-task")

        tampered = Path(self.directory.name) / "tampered.jsonl"
        self.write_task_catalog(tampered, changed_input=True)
        with self.assertRaisesRegex(evaluation.EvalError, "frozen task digest"):
            evaluation.RepositoryTaskImageResolver(tampered, self.manifest)

        link = Path(self.directory.name) / "task-link.jsonl"
        link.symlink_to(path)
        with self.assertRaises(evaluation.EvalError):
            evaluation.RepositoryTaskImageResolver(link, self.manifest)

    def outcome_for(self, invocation):
        return evaluation.HostRunOutcomeV1(
            run_id=self.manifest["runId"], attempt_id=f"attempt-{invocation.call_index}",
            task_id=invocation.task["taskId"],
            dispatch_idempotency_key=invocation.dispatch_idempotency_key,
            arm_id=invocation.arm["id"],
            provider_route=self.manifest["shared"]["providerRoute"],
            model_revision=self.manifest["shared"]["modelRevision"],
            harness_digest=invocation.arm["harnessDigest"],
            workspace_revision="blake3:" + "a" * 64,
            verifier_digest=self.manifest["benchmark"]["evaluatorDigest"],
            verifier_verdict="PASS", host_run_receipt_ref=f"receipt-{invocation.call_index}",
            verifier_evidence_ref=f"evidence-{invocation.call_index}",
            owner_log_event_digest="blake3:" + "b" * 64,
            elapsed_ms=5, input_tokens=10, output_tokens=4, cost_micros=None,
            cost_provenance="UNKNOWN", tool_calls=1, retries=0, interventions=0,
            resource_use={"status": "UNKNOWN"},
        )

    def test_host_run_pairs_are_indexed_and_remain_non_official(self):
        outer = self

        class Bridge:
            def __init__(self):
                self.calls = []

            def dispatch_guarded_trial(self, invocation):
                self.calls.append(invocation)
                return outer.outcome_for(invocation)

        class Resolver:
            def resolve_task(self, task_id):
                return outer.tasks[task_id]

        bridge = Bridge()
        result = evaluation.run_host_paired_evaluation(
            self.manifest, bridge, Resolver(), self.artifact)
        self.assertEqual(len(bridge.calls), 4)
        self.assertFalse(result.official_score_eligible)
        self.assertEqual(evaluation.evaluation_report(result, self.manifest)["authorityStatus"],
                         "HOST_RUN_ADAPTER_UNATTESTED")
        self.assertTrue(all(row["mode"] == "HOST_RUN_PAIRED" for row in result.records))
        self.assertEqual([row["hostRunDispatchIndex"] for row in result.records], [0, 1, 2, 3])
        summary = evaluation.summarize_pairs(result.records, self.manifest)
        self.assertEqual(summary["resourceUse"]["status"], "UNKNOWN")
        self.assertFalse(summary["officialScoreEligible"])
        self.assertFalse(summary["hup001Complete"])

    def test_unattested_resource_claim_is_unknown_and_stops_without_replay(self):
        outer = self

        class Bridge:
            def __init__(self):
                self.calls = 0

            def dispatch_guarded_trial(self, invocation):
                self.calls += 1
                return replace(
                    outer.outcome_for(invocation),
                    resource_use={"status": "UNKNOWN", "rssBytes": 1, "pssBytes": 0},
                )

        class Resolver:
            def resolve_task(self, task_id):
                return outer.tasks[task_id]

        bridge = Bridge()
        result = evaluation.run_host_paired_evaluation(
            self.manifest, bridge, Resolver(), self.artifact)
        self.assertEqual(bridge.calls, 1)
        self.assertEqual(result.records[0]["status"], "UNKNOWN")
        self.assertTrue(result.records[0]["dispatchStarted"])
        self.assertTrue(all(row["status"] == "NOT_RUN" for row in result.records[1:]))
        self.assertNotIn("rssBytes", result.records[0].get("resourceUse", {}))

        resumed = evaluation.run_host_paired_evaluation(
            self.manifest, bridge, Resolver(), self.artifact)
        self.assertEqual(bridge.calls, 1)
        self.assertEqual(resumed.records, result.records)

    def test_foreign_run_outcome_is_unknown_and_never_replayed(self):
        outer = self

        class Bridge:
            def __init__(self):
                self.calls = 0

            def dispatch_guarded_trial(self, invocation):
                self.calls += 1
                return replace(outer.outcome_for(invocation), run_id='foreign-run')

        class Resolver:
            def resolve_task(self, task_id):
                return outer.tasks[task_id]

        bridge = Bridge()
        result = evaluation.run_host_paired_evaluation(
            self.manifest, bridge, Resolver(), self.artifact)
        self.assertEqual(bridge.calls, 1)
        self.assertEqual(result.records[0]['status'], 'UNKNOWN')
        self.assertTrue(result.records[0]['dispatchStarted'])
        self.assertTrue(all(row['status'] == 'NOT_RUN' for row in result.records[1:]))

        resumed = evaluation.run_host_paired_evaluation(
            self.manifest, bridge, Resolver(), self.artifact)
        self.assertEqual(bridge.calls, 1)
        self.assertEqual(resumed.records, result.records)

    def test_host_run_receipt_and_verifier_evidence_must_be_distinct(self):
        outer = self

        class Bridge:
            def __init__(self):
                self.calls = 0

            def dispatch_guarded_trial(self, invocation):
                self.calls += 1
                same = f"same-ref-{invocation.call_index}"
                return replace(outer.outcome_for(invocation),
                               host_run_receipt_ref=same, verifier_evidence_ref=same)

        class Resolver:
            def resolve_task(self, task_id):
                return outer.tasks[task_id]

        bridge = Bridge()
        result = evaluation.run_host_paired_evaluation(
            self.manifest, bridge, Resolver(), self.artifact)
        self.assertEqual(bridge.calls, 1)
        self.assertEqual(result.records[0]["status"], "UNKNOWN")
        self.assertTrue(all(row["status"] == "NOT_RUN" for row in result.records[1:]))

    def test_summary_rejects_contradictory_or_unattested_host_run_evidence(self):
        outer = self

        class Bridge:
            def dispatch_guarded_trial(self, invocation):
                return outer.outcome_for(invocation)

        class Resolver:
            def resolve_task(self, task_id):
                return outer.tasks[task_id]

        result = evaluation.run_host_paired_evaluation(
            self.manifest, Bridge(), Resolver(), self.artifact)
        row = dict(result.records[0])
        self.assertEqual(row["status"], "PASS_VERIFIED")
        contradictions = (
            ({"securityFailure": True, "failureClass": "security_failure"},
             "contradicts its verifier/security evidence"),
            ({"verifierVerdict": "FAIL", "falseCompletion": True},
             "contradicts its verifier/security evidence"),
            ({"resourceUse": {"status": "MEASURED", "pssBytes": 1}},
             "must stay UNKNOWN"),
            ({"resourceUse": {"status": "UNKNOWN", "pssBytes": 1}},
             "must stay UNKNOWN"),
            ({"verifierVerdict": "ed25519"},
             "missing a valid verifier verdict"),
        )
        for overrides, message in contradictions:
            with self.subTest(overrides=sorted(overrides)):
                with self.assertRaisesRegex(evaluation.EvalError, message):
                    evaluation.summarize_pairs(({**row, **overrides},), self.manifest)
        incomplete = {key: value for key, value in row.items() if key != "verifierVerdict"}
        with self.assertRaisesRegex(evaluation.EvalError, "missing a valid verifier verdict"):
            evaluation.summarize_pairs((incomplete,), self.manifest)

    def test_journal_rejects_persisted_contradictory_host_run_pass(self):
        task_id, arm_id = evaluation.paired_call_plan(self.manifest)[0]
        task = next(item for item in self.manifest["tasks"] if item["taskId"] == task_id)
        self._write_host_journal_rows([
            {"taskId": task_id, "taskGroup": task["taskGroup"], "armId": arm_id,
             "manifestDigest": evaluation.digest(self.manifest),
             "hostRunDispatchIndex": 0, "dispatchStarted": True,
             "status": "PASS_VERIFIED", "verifierVerdict": "FAIL",
             "securityFailure": True, "falseCompletion": True, "failureClass": "security_failure",
             "resourceUse": {"status": "UNKNOWN"}, "mode": "HOST_RUN_PAIRED"},
        ])

        class Bridge:
            def __init__(self):
                self.calls = 0

            def dispatch_guarded_trial(self, invocation):
                self.calls += 1
                return None

        class Resolver:
            def resolve_task(self, task_id):
                return {}

        bridge = Bridge()
        with self.assertRaisesRegex(evaluation.EvalError, "contradicts its verifier/security"):
            evaluation.run_host_paired_evaluation(
                self.manifest, bridge, Resolver(), self.artifact)
        self.assertEqual(bridge.calls, 0)

    def _write_host_journal_rows(self, rows, path=None):
        frozen_digest = evaluation.digest(self.manifest)
        journal = evaluation._ArtifactJournal(
            path or self.artifact, self.manifest, frozen_digest, mode="HOST_RUN_PAIRED")
        try:
            for row in rows:
                journal.append(row)
        finally:
            journal.close()

    def test_resume_rejects_dispatch_after_unknown_terminal(self):
        plan = evaluation.paired_call_plan(self.manifest)
        tasks = {task["taskId"]: task for task in self.manifest["tasks"]}
        first_task, first_arm = plan[0]
        second_task, second_arm = plan[1]
        frozen_digest = evaluation.digest(self.manifest)
        self._write_host_journal_rows([
            {"taskId": first_task, "taskGroup": tasks[first_task]["taskGroup"],
             "armId": first_arm, "manifestDigest": frozen_digest,
             "hostRunDispatchIndex": 0, "dispatchStarted": True,
             "status": "UNKNOWN", "mode": "HOST_RUN_PAIRED"},
            {"taskId": second_task, "taskGroup": tasks[second_task]["taskGroup"],
             "armId": second_arm, "manifestDigest": frozen_digest,
             "hostRunDispatchIndex": 1, "dispatchStarted": True,
             "status": "PASS_VERIFIED", "mode": "HOST_RUN_PAIRED"},
        ])

        class Bridge:
            def __init__(self):
                self.calls = 0

            def dispatch_guarded_trial(self, invocation):
                self.calls += 1
                return outer.outcome_for(invocation)

        outer = self

        class Resolver:
            def resolve_task(self, task_id):
                return outer.tasks[task_id]

        bridge = Bridge()
        with self.assertRaisesRegex(evaluation.EvalError, "after a terminal trial"):
            evaluation.run_host_paired_evaluation(
                self.manifest, bridge, Resolver(), self.artifact)
        self.assertEqual(bridge.calls, 0)

    def test_resume_rejects_not_run_before_terminal_trial(self):
        plan = evaluation.paired_call_plan(self.manifest)
        tasks = {task["taskId"]: task for task in self.manifest["tasks"]}
        first_task, first_arm = plan[0]
        second_task, second_arm = plan[1]
        frozen_digest = evaluation.digest(self.manifest)
        self._write_host_journal_rows([
            {"taskId": first_task, "taskGroup": tasks[first_task]["taskGroup"],
             "armId": first_arm, "manifestDigest": frozen_digest, "dispatchStarted": True,
             "status": "NOT_RUN", "mode": "HOST_RUN_PAIRED"},
            {"taskId": second_task, "taskGroup": tasks[second_task]["taskGroup"],
             "armId": second_arm, "manifestDigest": frozen_digest,
             "hostRunDispatchIndex": 0, "dispatchStarted": True,
             "status": "PASS_VERIFIED", "mode": "HOST_RUN_PAIRED"},
        ])

        class Bridge:
            def dispatch_guarded_trial(self, invocation):
                return outer.outcome_for(invocation)

        outer = self

        class Resolver:
            def resolve_task(self, task_id):
                return outer.tasks[task_id]

        with self.assertRaisesRegex(evaluation.EvalError, "NOT_RUN precedes a terminal trial"):
            evaluation.run_host_paired_evaluation(
                self.manifest, Bridge(), Resolver(), self.artifact)

    def test_resume_rejects_pass_marked_as_not_dispatched(self):
        task_id, arm_id = evaluation.paired_call_plan(self.manifest)[0]
        task = next(item for item in self.manifest["tasks"] if item["taskId"] == task_id)
        self._write_host_journal_rows([
            {"taskId": task_id, "taskGroup": task["taskGroup"], "armId": arm_id,
             "manifestDigest": evaluation.digest(self.manifest),
             "hostRunDispatchIndex": 0, "dispatchStarted": False,
             "status": "PASS_VERIFIED", "mode": "HOST_RUN_PAIRED"},
        ])

        class Bridge:
            def __init__(self):
                self.calls = 0

            def dispatch_guarded_trial(self, invocation):
                self.calls += 1
                return outer.outcome_for(invocation)

        outer = self

        class Resolver:
            def resolve_task(self, task_id):
                return outer.tasks[task_id]

        bridge = Bridge()
        with self.assertRaisesRegex(evaluation.EvalError, "dispatch state contradicts trial status"):
            evaluation.run_host_paired_evaluation(
                self.manifest, bridge, Resolver(), self.artifact)
        self.assertEqual(bridge.calls, 0)

    def test_resume_does_not_trust_or_skip_persisted_host_run_pass(self):
        task_id, arm_id = evaluation.paired_call_plan(self.manifest)[0]
        task = next(item for item in self.manifest["tasks"] if item["taskId"] == task_id)
        self._write_host_journal_rows([
            {"taskId": task_id, "taskGroup": task["taskGroup"], "armId": arm_id,
             "manifestDigest": evaluation.digest(self.manifest),
             "hostRunDispatchIndex": 0, "dispatchStarted": True,
             "status": "PASS_VERIFIED", "mode": "HOST_RUN_PAIRED"},
        ])

        class Bridge:
            def __init__(self):
                self.calls = 0

            def dispatch_guarded_trial(self, invocation):
                self.calls += 1
                return outer.outcome_for(invocation)

        outer = self

        class Resolver:
            def resolve_task(self, task_id):
                return outer.tasks[task_id]

        bridge = Bridge()
        with self.assertRaisesRegex(evaluation.EvalError, "requires authenticated reconciliation"):
            evaluation.run_host_paired_evaluation(
                self.manifest, bridge, Resolver(), self.artifact)
        self.assertEqual(bridge.calls, 0)

    def test_resume_does_not_trust_persisted_host_run_nonpass_outcomes(self):
        plan = evaluation.paired_call_plan(self.manifest)
        tasks = {task["taskId"]: task for task in self.manifest["tasks"]}
        statuses = ("FAIL_UNVERIFIED", "UNSUPPORTED_CAPABILITY")
        rows = []
        for index, (task_id, arm_id) in enumerate(plan[:len(statuses)]):
            rows.append({"taskId": task_id, "taskGroup": tasks[task_id]["taskGroup"],
                         "armId": arm_id, "manifestDigest": evaluation.digest(self.manifest),
                         "hostRunDispatchIndex": index, "dispatchStarted": True,
                         "status": statuses[index], "mode": "HOST_RUN_PAIRED"})
        self._write_host_journal_rows(rows)

        class Bridge:
            def __init__(self):
                self.calls = 0

            def dispatch_guarded_trial(self, invocation):
                self.calls += 1
                return outer.outcome_for(invocation)

        outer = self

        class Resolver:
            def resolve_task(self, task_id):
                return outer.tasks[task_id]

        bridge = Bridge()
        with self.assertRaisesRegex(evaluation.EvalError, "requires authenticated reconciliation"):
            evaluation.run_host_paired_evaluation(
                self.manifest, bridge, Resolver(), self.artifact)
        self.assertEqual(bridge.calls, 0)

    def test_ambiguous_host_dispatch_is_unknown_and_never_replayed(self):
        class Bridge:
            def __init__(self):
                self.calls = 0

            def dispatch_guarded_trial(self, invocation):
                self.calls += 1
                raise TimeoutError("ambiguous HostRun transport")

        class Resolver:
            def resolve_task(self, task_id):
                return self.tasks[task_id]

        bridge = Bridge()
        resolver = Resolver()
        resolver.tasks = self.tasks
        result = evaluation.run_host_paired_evaluation(
            self.manifest, bridge, resolver, self.artifact)
        self.assertEqual(bridge.calls, 1)
        unknown = next(row for row in result.records if row["status"] == "UNKNOWN")
        self.assertEqual(unknown["hostRunDispatchIndex"], 0)
        resumed = evaluation.run_host_paired_evaluation(
            self.manifest, bridge, resolver, self.artifact)
        self.assertEqual(bridge.calls, 1)
        self.assertEqual(resumed.records, result.records)

    def test_host_run_cancellation_is_pre_dispatch_and_stops_remaining_pairs(self):
        self.manifest["cancelAfterCalls"] = 1
        outer = self

        class Bridge:
            def __init__(self):
                self.calls = 0

            def dispatch_guarded_trial(self, invocation):
                self.calls += 1
                return outer.outcome_for(invocation)

        class Resolver:
            def resolve_task(self, task_id):
                local = outer.tasks[task_id]
                return local

        bridge = Bridge()
        result = evaluation.run_host_paired_evaluation(
            self.manifest, bridge, Resolver(), self.artifact)
        cancellation = next(row for row in result.records if row["status"] == "CANCELLED")
        self.assertFalse(cancellation["dispatchStarted"])
        self.assertNotIn("hostRunDispatchIndex", cancellation)
        self.assertEqual(bridge.calls, 1)
        self.assertTrue(all(row["status"] == "NOT_RUN" for row in result.records[
            result.records.index(cancellation) + 1:]))

    # --- non-outcome terminal rows cannot carry outcome evidence ----------

    def _terminal_evidence_row(self, status, **extra):
        """A frozen-plan HostRun journal row whose status never reaches an outcome.

        Only ``PASS_VERIFIED``/``FAIL_UNVERIFIED``/``UNSUPPORTED_CAPABILITY``
        rows receive verifier verdict, security, false-completion or resource
        evidence; the runner's own ``UNKNOWN``/``CANCELLED``/``INFRASTRUCTURE_
        FAILURE``/``NOT_RUN`` rows carry a ``failureClass`` classification and
        nothing else. A locally edited row must not smuggle outcome evidence
        (in particular a measured resource figure or a PASS verdict) onto a
        status that was never resolved.
        """
        task_id, arm_id = evaluation.paired_call_plan(self.manifest)[0]
        task = next(item for item in self.manifest["tasks"] if item["taskId"] == task_id)
        row = {"taskId": task_id, "taskGroup": task["taskGroup"], "armId": arm_id,
               "manifestDigest": evaluation.digest(self.manifest),
               "dispatchStarted": status != "NOT_RUN",
               "status": status, "failureClass": "unknown",
               "mode": "HOST_RUN_PAIRED"}
        if status != "NOT_RUN":
            row["hostRunDispatchIndex"] = 0
        if status == "CANCELLED":
            row["dispatchStarted"] = False
            del row["hostRunDispatchIndex"]
        row.update(extra)
        return row

    def test_journal_rejects_terminal_host_run_row_carrying_outcome_evidence(self):
        self._write_host_journal_rows([self._terminal_evidence_row(
            "UNKNOWN",
            verifierVerdict="PASS", securityFailure=False, falseCompletion=False,
            resourceUse={"status": "MEASURED", "pssBytes": 1})])

        class Bridge:
            def __init__(self):
                self.calls = 0

            def dispatch_guarded_trial(self, invocation):
                self.calls += 1
                return outer.outcome_for(invocation)

        outer = self

        class Resolver:
            def resolve_task(self, task_id):
                return outer.tasks[task_id]

        bridge = Bridge()
        with self.assertRaisesRegex(
                evaluation.EvalError, "cannot carry verifier or resource evidence"):
            evaluation.run_host_paired_evaluation(
                self.manifest, bridge, Resolver(), self.artifact)
        self.assertEqual(bridge.calls, 0)

    def test_summary_rejects_terminal_host_run_row_carrying_outcome_evidence(self):
        cases = (
            (self._terminal_evidence_row(
                "UNKNOWN", verifierVerdict="PASS", securityFailure=False,
                falseCompletion=False, resourceUse={"status": "MEASURED", "rssBytes": 1}),
             "cannot carry verifier or resource evidence"),
            (self._terminal_evidence_row(
                "CANCELLED", verifierVerdict="PASS", securityFailure=True,
                falseCompletion=False, failureClass="security_failure",
                resourceUse={"status": "UNKNOWN"}),
             "cannot carry verifier or resource evidence"),
            (self._terminal_evidence_row(
                "NOT_RUN", resourceUse={"status": "UNKNOWN", "reason": "caller supplied"}),
             "cannot carry verifier or resource evidence"),
            (self._terminal_evidence_row(
                "INFRASTRUCTURE_FAILURE", verifierVerdict="FAIL"),
             "cannot carry verifier or resource evidence"),
        )
        for row, message in cases:
            with self.subTest(status=row["status"], keys=sorted(
                    {"verifierVerdict", "securityFailure", "falseCompletion", "resourceUse"}
                    & set(row))):
                with self.assertRaisesRegex(evaluation.EvalError, message):
                    evaluation.summarize_pairs((row,), self.manifest)

    def test_summary_accepts_runner_shaped_terminal_rows_without_outcome_evidence(self):
        for row in (
            self._terminal_evidence_row("UNKNOWN", failureClass="unknown",
                                        hostRunUnknownReason="host_run_binding_absent"),
            self._terminal_evidence_row("CANCELLED", failureClass="infrastructure"),
            self._terminal_evidence_row("NOT_RUN", failureClass="infrastructure",
                                        stopReason="UNKNOWN"),
        ):
            with self.subTest(status=row["status"]):
                summary = evaluation.summarize_pairs((row,), self.manifest)
                self.assertEqual(summary["resourceUse"]["status"], "UNKNOWN")


def _b3(text: str) -> str:
    """Canonical blake3 digest of a text value (local helper for fixtures)."""
    return "blake3:" + evaluation.blake3.blake3(text.encode("utf-8")).hex()


def host_outcome(manifest, invocation, **overrides):
    """A structurally valid HostRun outcome for a fixture invocation."""
    values = {
        "run_id": manifest["runId"], "attempt_id": f"attempt-{invocation.call_index}",
        "task_id": invocation.task["taskId"],
        "dispatch_idempotency_key": invocation.dispatch_idempotency_key,
        "arm_id": invocation.arm["id"],
        "provider_route": manifest["shared"]["providerRoute"],
        "model_revision": manifest["shared"]["modelRevision"],
        "harness_digest": invocation.arm["harnessDigest"],
        "workspace_revision": "blake3:" + "a" * 64,
        "verifier_digest": manifest["benchmark"]["evaluatorDigest"],
        "verifier_verdict": "PASS",
        "host_run_receipt_ref": f"receipt-{invocation.call_index}",
        "verifier_evidence_ref": f"evidence-{invocation.call_index}",
        "owner_log_event_digest": "blake3:" + "b" * 64,
        "elapsed_ms": 5, "input_tokens": 10, "output_tokens": 4, "cost_micros": None,
        "cost_provenance": "UNKNOWN", "tool_calls": 1, "retries": 0, "interventions": 0,
        "resource_use": {"status": "UNKNOWN"},
    }
    values.update(overrides)
    return evaluation.HostRunOutcomeV1(**values)


class FakeHostRunTransport:
    """Local model of P2's three published HostRun routes — a **test double**.

    This is not HostKernel and confers no authority: it derives nothing from an
    authenticated peer/fence, Stage-A/B admission facts, Guarded Create/Inspect
    receipts or the P1 effect projection. It exists so the P8 consumer's
    sequencing, strict bodies/replies and fail-closed decisions can be exercised
    offline. Authentic evidence stays BLOCKED (see
    `AuthenticHostRunPositiveFixtureTests`).
    """

    def __init__(self, *, verified_revision="blake3:" + "a" * 64):
        self.verified_revision = verified_revision
        self.operations = []
        self.bindings = {}
        self.p2_receipts = {}
        self.owner_receipts = {}
        self.forced_reason = None
        self.forced_post_dispatch_reason = None
        self.fail_operation = None
        self.terminal_status = "SUCCEEDED"
        self.inspect_counts = {}

    def call(self, service, operation, body):
        self.operations.append((operation, dict(body)))
        if service != evaluation.MANAGED_SERVICE_ID:
            raise evaluation.EvalError("unexpected service id")
        if self.fail_operation == operation:
            raise ConnectionError(f"simulated {operation} transport failure")
        if operation == evaluation.HOST_RUN_BIND_OPERATION:
            return self._bind(body)
        if operation == evaluation.HOST_RUN_BIND_RECEIPT_OPERATION:
            return self._bind_receipt(body)
        if operation == evaluation.HOST_RUN_INSPECT_OPERATION:
            return self._inspect(body)
        raise evaluation.EvalError(f"unexpected operation {operation}")

    def seed_completed_sibling(self, *, dispatch_key_digest, manifest_digest,
                               evaluator_task_id, arm_id, task_group,
                               attempt_id="attempt-seed", owner_receipt=None):
        """Model a sibling process that already completed append + post-commit.

        Used only to give the fake host a bound key so it can answer with a
        terminal status; it records no RPC operation, because no consumer call
        took place.
        """
        self._bind(evaluation.host_run_bind_body(
            goal_id="goal-fixture", attempt_id=attempt_id,
            dispatch_key_digest=dispatch_key_digest,
            manifest_digest=manifest_digest, evaluator_task_id=evaluator_task_id,
            arm_id=arm_id, task_group=task_group))
        if owner_receipt is None:
            owner_receipt = {
                "ownerLogID": f"owner-log-fixture-{len(self.owner_receipts) + 1}",
                "ownerLogSequence": str(len(self.owner_receipts) + 1),
                "ownerLogEventDigest": _b3(f"p8-event-{dispatch_key_digest}"),
            }
        self._bind_receipt({
            "goalID": "goal-fixture",
            "dispatchKeyDigest": dispatch_key_digest,
            "bindingDigest": self.bindings[dispatch_key_digest]["bindingDigest"],
            **owner_receipt,
        })
        return self.bindings[dispatch_key_digest]

    def _bind(self, body):
        if set(body) != set(evaluation.HOST_RUN_BIND_BODY_FIELDS):
            raise evaluation.EvalError("bind body is not the frozen seven-field contract")
        key = body["dispatchKeyDigest"]
        binding = {
            "schemaVersion": 1,
            "dispatchKeyDigest": key,
            "manifestDigest": body["manifestDigest"],
            "evaluatorTaskId": body["evaluatorTaskId"],
            "armId": body["armId"],
            "taskGroup": body["taskGroup"],
            "runId": "run-fixture",
            "managedTaskId": body["evaluatorTaskId"],
            "attemptId": body["attemptID"],
            "evaluationSessionId": "session-fixture",
            "coreProcessGeneration": "4242",
            "ownerId": "owner-fixture",
            "ownerEpoch": "7",
            "workerExecutionId": "worker-fixture",
            "delegationBindingDigest": _b3("delegation-fixture"),
            "acceptedSpecDigest": _b3("spec-fixture"),
            "providerSelectionDigest": _b3("provider-fixture"),
            "workspaceBindingDigest": _b3("workspace-fixture"),
            "admittedWorkspaceRevision": self.verified_revision,
            "attemptScopeDigest": _b3("scope-fixture"),
            "ownerPrincipalBindingDigest": _b3("principal-fixture"),
        }
        binding["bindingDigest"] = "blake3:" + evaluation.blake3.blake3(
            evaluation.canonical_json(binding)).hex()
        existing = self.bindings.get(key)
        if existing is not None and existing != binding:
            raise evaluation.EvalError("conflicting binding for one dispatch key")
        self.bindings[key] = binding
        receipt = {
            "schemaVersion": 1,
            "dispatchKeyDigest": key,
            "bindingDigest": binding["bindingDigest"],
            "ownerLogSequence": str(len(self.p2_receipts) + 1),
            "ownerLogEventDigest": _b3(f"p2-receipt-{key}"),
            "bindingManagedRevision": "11",
        }
        self.p2_receipts[key] = receipt
        return {"schemaVersion": 1, "binding": binding, "receipt": receipt}

    def _bind_receipt(self, body):
        if set(body) != set(evaluation.HOST_RUN_BIND_RECEIPT_BODY_FIELDS):
            raise evaluation.EvalError(
                "bind_receipt body is not the frozen six-field contract")
        key = body["dispatchKeyDigest"]
        if key not in self.bindings:
            raise evaluation.EvalError("post-commit receipt names an unbound key")
        if body["bindingDigest"] != self.bindings[key]["bindingDigest"]:
            raise evaluation.EvalError("post-commit receipt names a foreign binding")
        if any(receipt["ownerLogID"] == body["ownerLogID"]
               for receipt in self.owner_receipts.values()):
            raise evaluation.EvalError("replayed OwnerLog cursor")
        self.owner_receipts[key] = {
            "ownerLogID": body["ownerLogID"],
            "ownerLogSequence": body["ownerLogSequence"],
            "ownerLogEventDigest": body["ownerLogEventDigest"],
            "bindingDigest": body["bindingDigest"],
            "dispatchKeyDigest": key,
        }
        return {
            "schemaVersion": 1,
            "status": "RECORDED",
            "receipt": {
                "schemaVersion": 1,
                "dispatchKeyDigest": key,
                "bindingDigest": body["bindingDigest"],
                "ownerLogID": body["ownerLogID"],
                "ownerLogSequence": body["ownerLogSequence"],
                "ownerLogEventDigest": body["ownerLogEventDigest"],
            },
        }

    def _inspect(self, body):
        if set(body) != set(evaluation.HOST_RUN_INSPECT_BODY_FIELDS):
            raise evaluation.EvalError("inspect body is not the frozen two-field contract")
        key = body["dispatchKeyDigest"]
        count = self.inspect_counts.get(key, 0) + 1
        self.inspect_counts[key] = count
        reason = self.forced_reason
        if count > 1 and self.forced_post_dispatch_reason is not None:
            reason = self.forced_post_dispatch_reason
        if reason is None:
            if key not in self.bindings:
                reason = evaluation.HOST_RUN_BINDING_ABSENT
            elif key not in self.p2_receipts:
                reason = "host_run_binding_receipt_missing"
            elif key not in self.owner_receipts:
                reason = "host_run_p8_owner_receipt_missing"
        if reason is not None:
            response = {"schemaVersion": 1, "dispatchKeyDigest": key,
                        "status": "UNKNOWN", "unknownReason": reason}
            if reason != evaluation.HOST_RUN_BINDING_ABSENT and key in self.bindings:
                response["binding"] = self.bindings[key]
                response["bindingDigest"] = self.bindings[key]["bindingDigest"]
            return response
        binding = self.bindings[key]
        response = {"schemaVersion": 1, "dispatchKeyDigest": key,
                    "status": self.terminal_status, "binding": binding,
                    "bindingDigest": binding["bindingDigest"],
                    "attemptReceiptDigest": f"attempt-receipt-{binding['attemptId']}"}
        if self.terminal_status == "SUCCEEDED":
            response["verifiedRevision"] = self.verified_revision
        return response


class FakeOwnerLog:
    """P8 OwnerLog seam double; returns cursor facts like a real append would."""

    def __init__(self, *, fail=False):
        self.fail = fail
        self.appended = []

    def append_dispatch_bound(self, binding, binding_digest):
        if self.fail:
            raise ConnectionError("simulated OwnerLog append failure")
        if binding_digest != binding["bindingDigest"]:
            raise evaluation.EvalError("OwnerLog mirror names a foreign binding")
        index = len(self.appended) + 1
        self.appended.append(binding["dispatchKeyDigest"])
        return {"ownerLogID": f"owner-log-fixture-{index}",
                "ownerLogSequence": str(index),
                "ownerLogEventDigest": _b3(f"p8-event-{index}")}


class HostRunControlPlaneTests(unittest.TestCase):
    """P8 consumer: append → post-commit receipt → resolve, fail-closed."""

    def setUp(self):
        self.directory = tempfile.TemporaryDirectory(dir=Path(__file__).resolve().parent)
        self.artifact = Path(self.directory.name) / "host-run-control-plane.jsonl"
        self.manifest = evaluation.selfcheck_manifest()
        self.manifest.pop("fakeSelfcheck")
        self.manifest["runId"] = "hup001-host-control-plane-fixture"
        self.manifest["shared"]["providerRoute"] = "explicit-selected-route"
        self.manifest["shared"]["modelRevision"] = "selected-model-revision"
        self.tasks = {}
        for task in self.manifest["tasks"]:
            local = {"taskId": task["taskId"], "taskGroup": task["taskGroup"],
                     "input": {"prompt": "bounded fixture task"}}
            task["inputDigest"] = evaluation.digest(local)
            self.tasks[task["taskId"]] = local

    def tearDown(self):
        self.directory.cleanup()

    class _Resolver:
        def __init__(self, tasks):
            self.tasks = tasks

        def resolve_task(self, task_id):
            return self.tasks[task_id]

    class _Bridge:
        def __init__(self, manifest):
            self.manifest = manifest
            self.dispatches = 0
            self.handles = 0

        def prepare_dispatch(self, invocation):
            self.handles += 1
            return evaluation.HostRunDispatchHandleV1(
                "goal-fixture", f"attempt-{invocation.call_index}")

        def dispatch_guarded_trial(self, invocation):
            self.dispatches += 1
            return host_outcome(self.manifest, invocation)

    def run_pair(self, artifact, *, control, owner_log, bridge):
        return evaluation.run_host_paired_evaluation(
            self.manifest, bridge, self._Resolver(self.tasks), artifact,
            control_plane=control, owner_log=owner_log)

    def fixture(self, **transport_kwargs):
        transport = FakeHostRunTransport(**transport_kwargs)
        control = evaluation.HostRunControlPlaneClient(transport, "goal-fixture")
        owner_log = FakeOwnerLog()
        bridge = self._Bridge(self.manifest)
        return transport, control, owner_log, bridge

    # --- strict bodies and replies ------------------------------------

    def test_bind_body_is_exactly_the_published_seven_field_contract(self):
        body = evaluation.host_run_bind_body(
            goal_id="goal-1", attempt_id="attempt-1",
            dispatch_key_digest=_b3("key"), manifest_digest=_b3("manifest"),
            evaluator_task_id="task-1", arm_id="minimal", task_group="development")
        self.assertEqual(set(body), set(evaluation.HOST_RUN_BIND_BODY_FIELDS))
        self.assertEqual(len(body), 7)
        self.assertNotIn("ownerEpoch", body)
        self.assertNotIn("workerExecutionId", body)
        with self.assertRaisesRegex(evaluation.EvalError, "blake3"):
            evaluation.host_run_bind_body(
                goal_id="goal-1", attempt_id="attempt-1",
                dispatch_key_digest="sha256:" + "a" * 64,
                manifest_digest=_b3("manifest"), evaluator_task_id="task-1",
                arm_id="minimal", task_group="development")

    def test_bind_receipt_and_inspect_bodies_are_exactly_six_and_two_fields(self):
        receipt_body = evaluation.host_run_bind_receipt_body(
            goal_id="goal-1", dispatch_key_digest=_b3("key"),
            binding_digest=_b3("binding"), owner_log_id="owner-log-1",
            owner_log_sequence="12", owner_log_event_digest=_b3("event"))
        self.assertEqual(len(receipt_body), 6)
        self.assertEqual(set(receipt_body),
                         set(evaluation.HOST_RUN_BIND_RECEIPT_BODY_FIELDS))
        inspect_body = evaluation.host_run_inspect_body(
            goal_id="goal-1", dispatch_key_digest=_b3("key"))
        self.assertEqual(len(inspect_body), 2)
        self.assertEqual(set(inspect_body), set(evaluation.HOST_RUN_INSPECT_BODY_FIELDS))
        with self.assertRaisesRegex(evaluation.EvalError, "decimal"):
            evaluation.host_run_bind_receipt_body(
                goal_id="goal-1", dispatch_key_digest=_b3("key"),
                binding_digest=_b3("binding"), owner_log_id="owner-log-1",
                owner_log_sequence="12x", owner_log_event_digest=_b3("event"))
        with self.assertRaisesRegex(evaluation.EvalError, "OwnerLog event digest"):
            evaluation.host_run_bind_receipt_body(
                goal_id="goal-1", dispatch_key_digest=_b3("key"),
                binding_digest=_b3("binding"), owner_log_id="owner-log-1",
                owner_log_sequence="12", owner_log_event_digest="blake3:" + "A" * 64)

    def test_host_run_decimal_parser_accepts_valid_twenty_digit_u64(self):
        sequence = "10000000000000000000"
        body = evaluation.host_run_bind_receipt_body(
            goal_id="goal-1", dispatch_key_digest=_b3("key"),
            binding_digest=_b3("binding"), owner_log_id="owner-log-1",
            owner_log_sequence=sequence, owner_log_event_digest=_b3("event"))
        self.assertEqual(body["ownerLogSequence"], sequence)

    def test_host_run_decimal_parser_rejects_leading_zero_alias(self):
        with self.assertRaisesRegex(evaluation.EvalError, "canonical decimal"):
            evaluation.host_run_bind_receipt_body(
                goal_id="goal-1", dispatch_key_digest=_b3("key"),
                binding_digest=_b3("binding"), owner_log_id="owner-log-1",
                owner_log_sequence="01", owner_log_event_digest=_b3("event"))

    def test_bind_response_parser_rejects_tampered_and_foreign_records(self):
        transport = FakeHostRunTransport()
        key, manifest_digest = _b3("key"), _b3("manifest")
        response = transport.call(
            evaluation.MANAGED_SERVICE_ID, evaluation.HOST_RUN_BIND_OPERATION,
            evaluation.host_run_bind_body(
                goal_id="goal-1", attempt_id="attempt-1", dispatch_key_digest=key,
                manifest_digest=manifest_digest, evaluator_task_id="task-1",
                arm_id="minimal", task_group="development"))
        binding = response["binding"]
        parsed = evaluation.parse_host_run_bind_response(
            response, dispatch_key_digest=key, manifest_digest=manifest_digest)
        self.assertEqual(parsed[0]["bindingDigest"], binding["bindingDigest"])
        for broken in (
            {**response, "extra": 1},
            {**response, "schemaVersion": 2},
            {**response, "binding": {**binding, "dispatchKeyDigest": _b3("other")}},
            {**response, "binding": {**binding, "ownerEpoch": "0"}},
            {**response, "receipt": {**transport.p2_receipts[key],
                                     "bindingDigest": _b3("other")}},
            {**response, "binding": {k: v for k, v in binding.items()
                                     if k != "attemptScopeDigest"}},
        ):
            with self.assertRaises(evaluation.EvalError):
                evaluation.parse_host_run_bind_response(
                    dict(broken), dispatch_key_digest=key,
                    manifest_digest=manifest_digest)
        with self.assertRaisesRegex(evaluation.EvalError, "different manifest"):
            evaluation.parse_host_run_bind_response(
                response, dispatch_key_digest=key, manifest_digest=_b3("other-manifest"))

    def test_bind_receipt_response_parser_requires_recorded_status_and_exact_pins(self):
        key, binding_digest = _b3("key"), _b3("binding")
        receipt = {"schemaVersion": 1, "dispatchKeyDigest": key,
                   "bindingDigest": binding_digest, "ownerLogID": "owner-log-1",
                   "ownerLogSequence": "4", "ownerLogEventDigest": _b3("event")}
        response = {"schemaVersion": 1, "status": "RECORDED", "receipt": receipt}
        parsed = evaluation.parse_host_run_bind_receipt_response(
            response, dispatch_key_digest=key, binding_digest=binding_digest)
        self.assertEqual(parsed["ownerLogID"], "owner-log-1")
        for broken in (
            {**response, "status": "PENDING"},
            {**response, "receipt": {**receipt, "ownerLogSequence": "0"}},
            {**response, "receipt": {**receipt, "bindingDigest": _b3("other")}},
            {**response, "receipt": {**receipt, "ownerLogEventDigest": "not-a-digest"}},
            {**response, "receipt": {k: v for k, v in receipt.items()
                                     if k != "ownerLogID"}},
        ):
            with self.assertRaises(evaluation.EvalError):
                evaluation.parse_host_run_bind_receipt_response(
                    dict(broken), dispatch_key_digest=key,
                    binding_digest=binding_digest)

    def test_inspect_response_parser_freezes_the_typed_unknown_catalog(self):
        key = _b3("key")
        self.assertEqual(len(evaluation.HOST_RUN_UNKNOWN_REASONS), 15)
        for reason in evaluation.HOST_RUN_UNKNOWN_REASONS:
            with self.subTest(reason=reason):
                parsed = evaluation.parse_host_run_inspect_response(
                    {"schemaVersion": 1, "dispatchKeyDigest": key,
                     "status": "UNKNOWN", "unknownReason": reason},
                    dispatch_key_digest=key)
                self.assertEqual(parsed["unknownReason"], reason)
        for broken in (
            {"schemaVersion": 1, "dispatchKeyDigest": key, "status": "UNKNOWN"},
            {"schemaVersion": 1, "dispatchKeyDigest": key, "status": "UNKNOWN",
             "unknownReason": "host_run_made_up"},
            {"schemaVersion": 1, "dispatchKeyDigest": key, "status": "SUCCEEDED",
             "unknownReason": "host_run_binding_absent"},
            {"schemaVersion": 1, "dispatchKeyDigest": _b3("other"),
             "status": "SUCCEEDED"},
            {"schemaVersion": 1, "dispatchKeyDigest": key, "status": "MAYBE"},
            {"schemaVersion": 1, "dispatchKeyDigest": key, "status": "SUCCEEDED",
             "resourceUse": {"status": "MEASURED"}},
        ):
            with self.assertRaises(evaluation.EvalError):
                evaluation.parse_host_run_inspect_response(dict(broken),
                                                           dispatch_key_digest=key)

    def test_dispatch_and_manifest_digests_are_canonical_blake3(self):
        manifest_digest = evaluation.host_run_manifest_digest(self.manifest)
        self.assertRegex(manifest_digest, r"^blake3:[0-9a-f]{64}$")
        key = evaluation.host_run_dispatch_key(
            evaluation.digest(self.manifest), "task-1", "minimal")
        key_digest = evaluation.host_run_dispatch_key_digest(key)
        self.assertRegex(key_digest, r"^blake3:[0-9a-f]{64}$")
        self.assertEqual(key_digest, evaluation.host_run_dispatch_key_digest(key))
        self.assertNotEqual(key_digest, key)
        # The raw dispatch key is never the digest: only its BLAKE3 travels.
        self.assertNotIn(key, key_digest)

    # --- consumer sequencing ------------------------------------------

    def test_each_pair_runs_inspect_bind_ownerlog_commit_dispatch_resolve(self):
        transport, control, owner_log, bridge = self.fixture()
        result = self.run_pair(self.artifact, control=control, owner_log=owner_log,
                               bridge=bridge)
        operations = [name for name, _ in transport.operations]
        self.assertEqual(operations, [
            "host_run.inspect", "host_run.bind", "host_run.bind_receipt",
            "host_run.inspect"] * 4)
        self.assertEqual(bridge.dispatches, 4)
        self.assertEqual(len(owner_log.appended), 4)
        self.assertEqual([row["status"] for row in result.records], ["PASS_VERIFIED"] * 4)
        for row in result.records:
            self.assertEqual(row["hostRunDispatchKeyDigest"],
                             evaluation.host_run_dispatch_key_digest(
                                 row["dispatchIdempotencyKey"]))
        self.assertFalse(result.official_score_eligible)
        summary = evaluation.summarize_pairs(result.records, self.manifest)
        self.assertEqual(summary["resourceUse"]["status"], "UNKNOWN")

    def test_completed_run_resumes_by_reuse_only_after_exact_terminal_resolution(self):
        transport, control, owner_log, bridge = self.fixture()
        first = self.run_pair(self.artifact, control=control, owner_log=owner_log,
                              bridge=bridge)
        self.assertEqual(bridge.dispatches, 4)
        resumed_transport, resumed_control, resumed_owner_log, resumed_bridge = (
            self.fixture())
        resumed_transport.bindings = transport.bindings
        resumed_transport.p2_receipts = transport.p2_receipts
        resumed_transport.owner_receipts = transport.owner_receipts
        resumed = self.run_pair(self.artifact, control=resumed_control,
                                owner_log=resumed_owner_log, bridge=resumed_bridge)
        self.assertEqual(resumed.records, first.records)
        # Four reconciliations, zero dispatches: the persisted rows were reused.
        self.assertEqual(
            [name for name, _ in resumed_transport.operations],
            ["host_run.inspect"] * 4)
        self.assertEqual(resumed_bridge.dispatches, 0)

    def test_persisted_row_without_a_host_run_binding_stays_blocked(self):
        task_id, arm_id = evaluation.paired_call_plan(self.manifest)[0]
        task = next(item for item in self.manifest["tasks"] if item["taskId"] == task_id)
        frozen_digest = evaluation.digest(self.manifest)
        dispatch_key = evaluation.host_run_dispatch_key(frozen_digest, task_id, arm_id)
        journal = evaluation._ArtifactJournal(
            self.artifact, self.manifest, frozen_digest, mode="HOST_RUN_PAIRED")
        try:
            journal.append({
                "taskId": task_id, "taskGroup": task["taskGroup"], "armId": arm_id,
                "manifestDigest": frozen_digest, "hostRunDispatchIndex": 0,
                "dispatchStarted": True, "status": "PASS_VERIFIED",
                "dispatchIdempotencyKey": dispatch_key,
                "workspaceRevision": "blake3:" + "a" * 64,
                "mode": "HOST_RUN_PAIRED"})
        finally:
            journal.close()
        transport, control, owner_log, bridge = self.fixture()
        with self.assertRaisesRegex(
                evaluation.HostRunReconciliationBlocked,
                "requires authenticated reconciliation"):
            self.run_pair(self.artifact, control=control, owner_log=owner_log,
                          bridge=bridge)
        # A journal PASS without an authenticated HostRun binding cannot be
        # reused, and the ambiguous key is never dispatched again.
        self.assertEqual(bridge.dispatches, 0)

    # --- negative matrix ------------------------------------------------

    def test_every_typed_unknown_reason_blocks_a_persisted_row_without_redispatch(self):
        task_id, arm_id = evaluation.paired_call_plan(self.manifest)[0]
        task = next(item for item in self.manifest["tasks"] if item["taskId"] == task_id)
        frozen_digest = evaluation.digest(self.manifest)
        dispatch_key = evaluation.host_run_dispatch_key(frozen_digest, task_id, arm_id)
        for index, reason in enumerate(evaluation.HOST_RUN_UNKNOWN_REASONS):
            with self.subTest(reason=reason):
                artifact = Path(self.directory.name) / f"blocked-{index}.jsonl"
                journal = evaluation._ArtifactJournal(
                    artifact, self.manifest, frozen_digest, mode="HOST_RUN_PAIRED")
                try:
                    journal.append({
                        "taskId": task_id, "taskGroup": task["taskGroup"],
                        "armId": arm_id, "manifestDigest": frozen_digest,
                        "hostRunDispatchIndex": 0, "dispatchStarted": True,
                        "status": "PASS_VERIFIED",
                        "dispatchIdempotencyKey": dispatch_key,
                        "workspaceRevision": "blake3:" + "a" * 64,
                        "mode": "HOST_RUN_PAIRED"})
                finally:
                    journal.close()
                transport, control, owner_log, bridge = self.fixture()
                transport.forced_reason = reason
                with self.assertRaisesRegex(
                        evaluation.EvalError,
                        "requires authenticated reconciliation"):
                    self.run_pair(artifact, control=control, owner_log=owner_log,
                                  bridge=bridge)
                self.assertEqual(bridge.dispatches, 0)
                self.assertEqual(bridge.handles, 0)

    def test_foreign_or_contradictory_dispatch_key_stays_blocked(self):
        task_id, arm_id = evaluation.paired_call_plan(self.manifest)[0]
        task = next(item for item in self.manifest["tasks"] if item["taskId"] == task_id)
        frozen_digest = evaluation.digest(self.manifest)
        journal = evaluation._ArtifactJournal(
            self.artifact, self.manifest, frozen_digest, mode="HOST_RUN_PAIRED")
        try:
            journal.append({
                "taskId": task_id, "taskGroup": task["taskGroup"], "armId": arm_id,
                "manifestDigest": frozen_digest, "hostRunDispatchIndex": 0,
                "dispatchStarted": True, "status": "PASS_VERIFIED",
                "dispatchIdempotencyKey": "sha256:" + "c" * 64,
                "workspaceRevision": "blake3:" + "a" * 64,
                "mode": "HOST_RUN_PAIRED"})
        finally:
            journal.close()
        transport, control, owner_log, bridge = self.fixture()
        with self.assertRaisesRegex(evaluation.EvalError,
                                    "differs from the frozen pair identity"):
            self.run_pair(self.artifact, control=control, owner_log=owner_log,
                          bridge=bridge)
        self.assertEqual(bridge.dispatches, 0)

    def test_terminal_status_mismatch_or_missing_revision_stays_blocked(self):
        cases = (
            ("FAILED resolves a PASS row", "FAILED", "blake3:" + "a" * 64),
            ("verified revision differs", "SUCCEEDED", "blake3:" + "d" * 64),
        )
        for label, status, revision in cases:
            with self.subTest(case=label):
                artifact = Path(self.directory.name) / f"mismatch-{status}-{revision[-4:]}.jsonl"
                task_id, arm_id = evaluation.paired_call_plan(self.manifest)[0]
                task = next(item for item in self.manifest["tasks"]
                            if item["taskId"] == task_id)
                frozen_digest = evaluation.digest(self.manifest)
                journal = evaluation._ArtifactJournal(
                    artifact, self.manifest, frozen_digest, mode="HOST_RUN_PAIRED")
                try:
                    journal.append({
                        "taskId": task_id, "taskGroup": task["taskGroup"],
                        "armId": arm_id, "manifestDigest": frozen_digest,
                        "hostRunDispatchIndex": 0, "dispatchStarted": True,
                        "status": "PASS_VERIFIED",
                        "dispatchIdempotencyKey": evaluation.host_run_dispatch_key(
                            frozen_digest, task_id, arm_id),
                        "workspaceRevision": "blake3:" + "a" * 64,
                        "mode": "HOST_RUN_PAIRED"})
                finally:
                    journal.close()
                transport, control, owner_log, bridge = self.fixture(
                    verified_revision=revision)
                transport.forced_reason = None
                transport.terminal_status = status
                # Bind the key so the fake host can answer with a terminal status.
                transport.call(evaluation.MANAGED_SERVICE_ID,
                               evaluation.HOST_RUN_BIND_OPERATION,
                               evaluation.host_run_bind_body(
                                   goal_id="goal-fixture", attempt_id="attempt-0",
                                   dispatch_key_digest=evaluation.host_run_dispatch_key_digest(
                                       evaluation.host_run_dispatch_key(
                                           frozen_digest, task_id, arm_id)),
                                   manifest_digest=evaluation.host_run_manifest_digest(
                                       self.manifest),
                                   evaluator_task_id=task_id, arm_id=arm_id,
                                   task_group=task["taskGroup"]))
                transport.owner_receipts[
                    evaluation.host_run_dispatch_key_digest(
                        evaluation.host_run_dispatch_key(
                            frozen_digest, task_id, arm_id))] = "owner-log-fixture"
                with self.assertRaisesRegex(evaluation.EvalError,
                                            "requires authenticated reconciliation"):
                    self.run_pair(artifact, control=control, owner_log=owner_log,
                                  bridge=bridge)
                self.assertEqual(bridge.dispatches, 0)

    def test_pre_dispatch_binding_from_a_sibling_blocks_and_never_redispatches(self):
        transport, control, owner_log, bridge = self.fixture()
        task_id, arm_id = evaluation.paired_call_plan(self.manifest)[0]
        key_digest = evaluation.host_run_dispatch_key_digest(
            evaluation.host_run_dispatch_key(evaluation.digest(self.manifest),
                                             task_id, arm_id))
        transport.bindings[key_digest] = {
            "schemaVersion": 1, "dispatchKeyDigest": key_digest,
            "manifestDigest": evaluation.host_run_manifest_digest(self.manifest),
            "evaluatorTaskId": task_id, "armId": arm_id,
            "taskGroup": next(t["taskGroup"] for t in self.manifest["tasks"]
                              if t["taskId"] == task_id),
            "runId": "run-fixture", "managedTaskId": task_id,
            "attemptId": "attempt-sibling", "evaluationSessionId": "session-fixture",
            "coreProcessGeneration": "4242", "ownerId": "owner-fixture",
            "ownerEpoch": "7", "workerExecutionId": "worker-fixture",
            "delegationBindingDigest": _b3("delegation-fixture"),
            "acceptedSpecDigest": _b3("spec-fixture"),
            "providerSelectionDigest": _b3("provider-fixture"),
            "workspaceBindingDigest": _b3("workspace-fixture"),
            "admittedWorkspaceRevision": "blake3:" + "a" * 64,
            "attemptScopeDigest": _b3("scope-fixture"),
            "ownerPrincipalBindingDigest": _b3("principal-fixture"),
        }
        transport.bindings[key_digest]["bindingDigest"] = _b3("sibling-binding")
        transport.p2_receipts[key_digest] = {
            "schemaVersion": 1,
            "dispatchKeyDigest": key_digest,
            "bindingDigest": transport.bindings[key_digest]["bindingDigest"],
            "ownerLogSequence": "1",
            "ownerLogEventDigest": _b3("sibling-p2-receipt"),
            "bindingManagedRevision": "11",
        }
        result = self.run_pair(self.artifact, control=control, owner_log=owner_log,
                               bridge=bridge)
        self.assertEqual(bridge.dispatches, 0)
        self.assertEqual(result.records[0]["status"], "UNKNOWN")
        self.assertTrue(result.records[0]["dispatchStarted"])
        self.assertEqual(result.records[0].get("hostRunUnknownReason"),
                         "host_run_p8_owner_receipt_missing")
        self.assertTrue(all(row["status"] == "NOT_RUN" for row in result.records[1:]))
        resumed_transport, resumed_control, resumed_owner_log, resumed_bridge = (
            self.fixture())
        resumed = self.run_pair(self.artifact, control=resumed_control,
                                owner_log=resumed_owner_log, bridge=resumed_bridge)
        self.assertEqual(resumed_bridge.dispatches, 0)
        self.assertEqual(resumed.records, result.records)

    def test_ownerlog_or_receipt_failure_is_unknown_and_never_replayed(self):
        for label, kwargs in (("OwnerLog append failed", {"owner_log_fail": True}),
                              ("bind_receipt transport failed",
                               {"fail_operation": evaluation.HOST_RUN_BIND_RECEIPT_OPERATION}),
                              ("bind transport failed",
                               {"fail_operation": evaluation.HOST_RUN_BIND_OPERATION})):
            with self.subTest(case=label):
                artifact = Path(self.directory.name) / f"preflight-{label[:6]}.jsonl"
                transport, control, owner_log, bridge = self.fixture()
                if kwargs.get("owner_log_fail"):
                    owner_log = FakeOwnerLog(fail=True)
                if kwargs.get("fail_operation"):
                    transport.fail_operation = kwargs["fail_operation"]
                result = self.run_pair(artifact, control=control, owner_log=owner_log,
                                       bridge=bridge)
                self.assertEqual(bridge.dispatches, 0)
                self.assertEqual(result.records[0]["status"], "UNKNOWN")
                self.assertTrue(result.records[0]["dispatchStarted"])
                resumed_transport, resumed_control, resumed_owner_log, resumed_bridge = (
                    self.fixture())
                resumed = self.run_pair(artifact, control=resumed_control,
                                        owner_log=resumed_owner_log,
                                        bridge=resumed_bridge)
                self.assertEqual(resumed_bridge.dispatches, 0)
                self.assertEqual(resumed.records, result.records)

    def test_non_terminal_post_dispatch_resolution_demotes_the_row_to_unknown(self):
        transport, control, owner_log, bridge = self.fixture(
            # Today's real answer until P1 installs its projection source.
        )
        transport.forced_post_dispatch_reason = "host_run_effect_projection_unavailable"
        result = self.run_pair(self.artifact, control=control, owner_log=owner_log,
                               bridge=bridge)
        self.assertEqual(bridge.dispatches, 1)
        self.assertEqual(result.records[0]["status"], "UNKNOWN")
        self.assertEqual(result.records[0]["hostRunUnknownReason"],
                         "host_run_effect_projection_unavailable")
        self.assertTrue(all(row["status"] == "NOT_RUN" for row in result.records[1:]))
        resumed_transport, resumed_control, resumed_owner_log, resumed_bridge = (
            self.fixture())
        resumed = self.run_pair(self.artifact, control=resumed_control,
                                owner_log=resumed_owner_log, bridge=resumed_bridge)
        self.assertEqual(resumed_bridge.dispatches, 0)
        self.assertEqual(resumed.records, result.records)

    def test_control_plane_without_owner_log_seam_fails_before_any_dispatch(self):
        transport, control, owner_log, bridge = self.fixture()
        with self.assertRaisesRegex(evaluation.EvalError,
                                    "OwnerLog append seam.*unavailable"):
            evaluation.run_host_paired_evaluation(
                self.manifest, bridge, self._Resolver(self.tasks), self.artifact,
                control_plane=control, owner_log=None)
        self.assertEqual(bridge.dispatches, 0)

    def test_control_plane_without_dispatch_handle_fails_before_any_dispatch(self):
        transport, control, owner_log, bridge = self.fixture()
        bridge.prepare_dispatch = None
        with self.assertRaisesRegex(evaluation.EvalError, "dispatch handle"):
            evaluation.run_host_paired_evaluation(
                self.manifest, bridge, self._Resolver(self.tasks), self.artifact,
                control_plane=control, owner_log=owner_log)
        self.assertEqual(bridge.dispatches, 0)

    def test_unrecognised_inspect_reason_is_ambiguous_not_trusted(self):
        transport, control, owner_log, bridge = self.fixture()
        transport.forced_reason = "host_run_totally_new_reason"
        result = self.run_pair(self.artifact, control=control, owner_log=owner_log,
                               bridge=bridge)
        self.assertEqual(bridge.dispatches, 0)
        self.assertEqual(result.records[0]["status"], "UNKNOWN")
        self.assertEqual(result.records[0]["errorType"], "EvalError")


class AuthenticHostRunPositiveFixtureTests(unittest.TestCase):
    """The authentic positive fixture: Stage-A/B + Guarded Create/Inspect facts.

    These assertions are *not* fabricated. Each one depends on evidence this
    repository cannot currently produce offline, so it is marked BLOCKED with
    the exact reason instead of being asserted against a double. The offline
    doubles in `HostRunControlPlaneTests` exercise only P8's local consumer
    logic and are never counted as admission or reconciliation evidence.
    """

    def test_stage_ab_and_guarded_create_inspect_admission_facts(self):
        self.skipTest(
            "BLOCKED_P2: the authentic `host_run.bind` positive needs P2's managed "
            "admission fixture built from a verified Core peer/fence, actual Guarded "
            "Create+Inspect journal receipts, persisted Stage-A reservation + Stage-B "
            "ContextSelection bind, and the real ContextSelection digest. P2's managed "
            "admission positives are still 1/3 and P8 may not edit P2-owned "
            "managed_control.rs/host_kernel.rs, so no authentic Stage-A/B fact exists "
            "for this fixture yet.")

    def test_full_inspect_terminal_resolution(self):
        self.skipTest(
            "BLOCKED_P1: `host_run.inspect` cannot resolve a terminal status because "
            "P1 has not installed `HostRunEffectProjectionSourceV1` "
            "(HostKernel::install_host_run_effect_projection_source). The route "
            "currently answers `host_run_effect_projection_unavailable` for every "
            "bound key, so a full SUCCEEDED/FAILED resolution — and therefore the "
            "authentic release of a persisted row — cannot be asserted here.")

    def test_p8_owner_log_mirrored_append(self):
        self.skipTest(
            "BLOCKED_P8_RUST: P8's mirrored `HostRunDispatchBoundV1` OwnerLog event "
            "and its post-commit receipt do not exist in kernel/src/worker_durable.rs "
            "yet, and Cargo is held by P1 for the projection work. Writing that Rust "
            "append unverified would risk breaking the held build, so the seam is "
            "wired behind a protocol here and the Rust append is not claimed.")


if __name__ == "__main__":
    unittest.main()
