"""Render DOCX files with local Microsoft Word, then rasterize the PDF.

This is a Windows-compatible replacement for the LibreOffice-only renderer used
by the paired Word evaluation.  Its command-line contract intentionally matches
the documents skill's render_docx.py script.
"""

from __future__ import annotations

import argparse
import shutil
import subprocess
import tempfile
from pathlib import Path

from pdf2image import convert_from_path


SCRIPT_DIR = Path(__file__).resolve().parent
WORD_CONVERTER = SCRIPT_DIR / "convert-docx-with-word.ps1"


def render(input_path: Path, output_dir: Path, dpi: int, emit_pdf: bool) -> list[Path]:
    output_dir.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix="word_render_") as temporary:
        pdf_path = Path(temporary) / f"{input_path.stem}.pdf"
        process = subprocess.run(
            [
                "powershell.exe",
                "-NoProfile",
                "-NonInteractive",
                "-ExecutionPolicy",
                "Bypass",
                "-File",
                str(WORD_CONVERTER),
                "-InputPath",
                str(input_path),
                "-OutputPath",
                str(pdf_path),
            ],
            check=False,
            capture_output=True,
            text=True,
            timeout=120,
        )
        if process.returncode != 0 or not pdf_path.exists() or pdf_path.stat().st_size == 0:
            raise RuntimeError(
                "Microsoft Word DOCX-to-PDF conversion failed:\n"
                f"stdout: {process.stdout.strip()}\n"
                f"stderr: {process.stderr.strip()}"
            )

        images = convert_from_path(pdf_path, dpi=dpi, fmt="png", thread_count=4)
        pages: list[Path] = []
        for index, page in enumerate(images, start=1):
            page_path = output_dir / f"page-{index}.png"
            page.save(page_path, "PNG")
            pages.append(page_path)

        if emit_pdf:
            shutil.copy2(pdf_path, output_dir / f"{input_path.stem}.pdf")
        return pages


def main() -> None:
    parser = argparse.ArgumentParser(description="Render DOCX to page PNGs with local Microsoft Word")
    parser.add_argument("input_path")
    parser.add_argument("--output_dir")
    parser.add_argument("--width", type=int, default=1600)
    parser.add_argument("--height", type=int, default=2000)
    parser.add_argument("--dpi", type=int, default=180)
    parser.add_argument("--emit_pdf", action="store_true")
    parser.add_argument("--verbose", action="store_true")
    args = parser.parse_args()

    input_path = Path(args.input_path).expanduser().resolve()
    output_dir = Path(args.output_dir).expanduser().resolve() if args.output_dir else input_path.with_suffix("")
    pages = render(input_path, output_dir, args.dpi, args.emit_pdf)
    if args.verbose:
        print(f"Rendered {len(pages)} pages at {args.dpi} DPI")
    print(f"Pages rendered to {output_dir}")


if __name__ == "__main__":
    main()
