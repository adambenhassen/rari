import os
from pathlib import Path
import re
import subprocess
import textwrap
import unittest


WORKFLOW = Path(__file__).resolve().parents[1] / "workflows" / "fork-build.yml"
DEFAULT_REF = "refs/heads/feat/jemalloc-0.14.13-cachefix"


def job_section(workflow, name):
    match = re.search(
        rf"(?ms)^  {re.escape(name)}:\n(.*?)(?=^  [a-zA-Z_][\w-]*:\n|\Z)",
        workflow,
    )
    if not match:
        raise AssertionError(f"workflow is missing job {name!r}")
    return match.group(1)


class ForkBuildGuardTest(unittest.TestCase):
    def test_build_and_release_depend_on_validation(self):
        workflow = WORKFLOW.read_text()
        validate = job_section(workflow, "validate")
        self.assertIn("BUILD_REF: ${{ github.ref }}", validate)
        self.assertIn("VERSION: ${{ inputs.version }}", validate)
        self.assertRegex(job_section(workflow, "build"), r"(?m)^    needs: validate$")
        self.assertRegex(job_section(workflow, "release"), r"(?m)^    needs: build$")

    def test_release_branch_and_version_are_validated(self):
        validate = job_section(WORKFLOW.read_text(), "validate")
        match = re.search(r"(?m)^        run: \|\n((?:(?:          [^\n]*|[ \t]*)\n)+)", validate)
        self.assertIsNotNone(match, "validation script is missing")
        script = textwrap.dedent(match.group(1))
        cases = [
            (DEFAULT_REF, "0.14.13-cachefix.0", True),
            (DEFAULT_REF, "0.14.13-cachefix.25", True),
            (DEFAULT_REF, "0.17.9-fork.1", False),
            (DEFAULT_REF, "0.14.13-cachefix.", False),
            (DEFAULT_REF, "0.14.13-cachefix.25-extra", False),
            ("refs/heads/fork/main", "0.14.13-cachefix.25", False),
            ("refs/tags/build-0.14.13-cachefix.25", "0.14.13-cachefix.25", False),
        ]
        for ref, version, allowed in cases:
            with self.subTest(ref=ref, version=version):
                result = subprocess.run(
                    ["bash", "-s"],
                    input=script,
                    text=True,
                    capture_output=True,
                    env={**os.environ, "BUILD_REF": ref, "VERSION": version},
                )
                self.assertEqual(result.returncode == 0, allowed, result.stderr)


if __name__ == "__main__":
    unittest.main()
