import json
import os
import tempfile
import unittest

import candidates_io


class TestCandidatesIO(unittest.TestCase):
    def test_load_candidates_returns_empty_when_missing(self):
        with tempfile.TemporaryDirectory() as d:
            self.assertEqual(candidates_io.load_candidates(os.path.join(d, "nope.json")), [])

    def test_load_candidates_reads_list(self):
        with tempfile.TemporaryDirectory() as d:
            path = os.path.join(d, "candidates.json")
            with open(path, "w") as f:
                json.dump([{"fingerprint": "eh:gpt-4o:ab", "model": "gpt-4o", "count": 3,
                            "estPredictedSavingsUsd": 0.1, "status": "observed", "simhash": "00000000000000ab"}], f)
            rows = candidates_io.load_candidates(path)
            self.assertEqual(len(rows), 1)
            self.assertEqual(rows[0]["model"], "gpt-4o")

    def test_write_optimized_appends_and_dedupes_by_fingerprint(self):
        with tempfile.TemporaryDirectory() as d:
            path = os.path.join(d, "optimized-prompts.json")
            e1 = {"fingerprint": "fp1", "simhash": "1", "template": "A", "qualityScore": 0.9,
                  "predictedSavingsUsd": 0.1, "targetModel": "gpt-4o-mini", "optimizedAt": 1}
            candidates_io.write_optimized(path, e1)
            e1b = {**e1, "template": "B"}
            candidates_io.write_optimized(path, e1b)
            with open(path) as f:
                data = json.load(f)
            self.assertEqual(len(data), 1)
            self.assertEqual(data[0]["template"], "B")

    def test_update_candidate_status(self):
        with tempfile.TemporaryDirectory() as d:
            path = os.path.join(d, "candidates.json")
            with open(path, "w") as f:
                json.dump([{"fingerprint": "fp1", "status": "observed"}], f)
            candidates_io.update_status(path, "fp1", "optimized")
            with open(path) as f:
                data = json.load(f)
            self.assertEqual(data[0]["status"], "optimized")


if __name__ == "__main__":
    unittest.main()
