"""Unrun HUP-005 fixtures for the offline fake-only paired evaluator."""
import json
import tempfile
import unittest
from pathlib import Path

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
                        "status": "PASS_VERIFIED", "failureClass": "none", "mode": "FAKE_SELF_CHECK"})
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


if __name__ == "__main__":
    unittest.main()
