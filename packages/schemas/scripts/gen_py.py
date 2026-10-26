"""Generates pydantic models from the JSON Schema sources (one module per schema).

Run through `pnpm --filter @anr/schemas gen`. Never edit the generated modules by hand.
"""

import shutil
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
FORMATS = ROOT.parent.parent / "config" / "formats"
OUT = ROOT / "python" / "anr_schemas"

jobs: list[tuple[Path, Path]] = [
    (f, OUT / "config" / f"{f.name.removesuffix('.schema.json').replace('-', '_')}.py")
    for f in sorted((ROOT / "json").glob("*.schema.json"))
] + [
    (d / "schema.json", OUT / "formats" / f"{d.name.replace('-', '_')}.py")
    for d in sorted(FORMATS.iterdir())
    if d.is_dir() and not d.name.startswith("_")
]

for package in ("config", "formats"):
    shutil.rmtree(OUT / package, ignore_errors=True)
    (OUT / package).mkdir(parents=True)
    (OUT / package / "__init__.py").write_text('"""Generated. Do not edit."""\n')

for source, target in jobs:
    subprocess.run(
        [
            sys.executable,
            "-m",
            "datamodel_code_generator",
            "--input",
            str(source),
            "--input-file-type",
            "jsonschema",
            "--output",
            str(target),
            "--output-model-type",
            "pydantic_v2.BaseModel",
            "--use-title-as-name",
            "--disable-timestamp",
            "--target-python-version",
            "3.13",
            "--formatters",
            "ruff-format",
        ],
        check=True,
    )
print(f"generated {len(jobs)} pydantic modules")
