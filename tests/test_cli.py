from __future__ import annotations

import io
import tempfile
import unittest
from contextlib import redirect_stdout
from pathlib import Path

from pyforge.emltpl_to_oft.cli import main


class EmltplToOftCliTests(unittest.TestCase):
    def test_main_returns_zero_for_single_file(self) -> None:
        message = (
            b"Subject: CLI check\n"
            b"MIME-Version: 1.0\n"
            b"Content-Type: text/plain; charset=utf-8\n"
            b"\n"
            b"hello\n"
        )

        with tempfile.TemporaryDirectory() as tmpdir:
            tempdir = Path(tmpdir)
            emltpl_path = tempdir / "sample.emltpl"
            output_dir = tempdir / "out"
            emltpl_path.write_bytes(message)

            stdout = io.StringIO()
            with redirect_stdout(stdout):
                exit_code = main([str(emltpl_path), str(output_dir)])

            self.assertEqual(exit_code, 0)
            self.assertTrue((output_dir / "sample.oft").exists())
            self.assertIn("Done: 1 converted, 0 failed", stdout.getvalue())

    def test_main_returns_one_for_missing_input(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            missing_path = Path(tmpdir) / "missing.emltpl"
            stdout = io.StringIO()
            with redirect_stdout(stdout):
                exit_code = main([str(missing_path)])

            self.assertEqual(exit_code, 1)
            self.assertIn("Not found:", stdout.getvalue())


if __name__ == "__main__":
    unittest.main()
