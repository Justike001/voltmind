"""Copy the upstream GBrain resolver and adapt it to VoltMind's runtime.

This script intentionally performs the copy before the text adaptation so the
result can be reproduced from the external resolver source.
"""

from __future__ import annotations

import re
import shutil
from pathlib import Path


SOURCE = Path(r"E:\gbrain\gbrain\skills\RESOLVER.md")
TARGET = Path(__file__).resolve().parents[1] / "skills" / "RESOLVER.md"


def read_utf8(path: Path) -> str:
    with path.open("r", encoding="utf-8", newline="") as handle:
        return handle.read()


def write_utf8(path: Path, content: str) -> None:
    with path.open("w", encoding="utf-8", newline="\n") as handle:
        handle.write(content)


def adapt(content: str) -> str:
    # Normalize the external Windows document before regex-based section edits.
    content = content.replace("\r\n", "\n").replace("\r", "\n")

    # Product naming, command namespace, and product-specific skill paths.
    content = content.replace("# GBrain Skill Resolver", "# VoltMind MVP Skill Resolver")
    content = content.replace("GBrain", "VoltMind")
    content = content.replace("gbrain", "voltmind")
    content = content.replace(
        "This is the dispatcher. Skills are the implementation. **Read the skill file before acting.** If two skills could match, read both. They are designed to chain (e.g., ingest then enrich for each entity).",
        "This is the agent-side dispatcher for VoltMind. Skills are the implementation.\n**Read the skill file before acting.** If two skills could match, read both. They\nare designed to chain (e.g., ingest then enrich for each entity).",
    )

    # The VoltMind CLI owns the runtime and does not take the legacy repo flag.
    content = content.replace(
        "voltmind autopilot --install --repo ~/brain",
        "voltmind autopilot --install",
    )

    # VoltMind only runs signal detection on explicit, source-backed write paths.
    content = content.replace(
        "## Always-on (every message)",
        "## Always-on",
    )
    runtime_boundary = (
        "## Runtime Boundary\n\n"
        "VoltMind is a local-first knowledge-base MVP. Route only to skills and commands\n"
        "inside the public VoltMind runtime. Inherited skills remain in the tree for\n"
        "later phases, but are frozen from public agent routing.\n\n"
        "If the user asks for a frozen capability, say it is not included in VoltMind yet\n"
        "and offer the closest safe path. Do not call hidden runtime commands or route\n"
        "through advanced skills just because the file still exists.\n\n"
    )
    content = content.replace("\n## Always-on\n", f"\n{runtime_boundary}## Always-on\n", 1)
    content = content.replace(
        "| Every inbound message (spawn parallel, don't block) | `skills/signal-detector/SKILL.md` |",
        "| Explicit source-backed signal enrichment | `skills/signal-detector/SKILL.md` (controlled write paths only) |",
    )

    # These identity files belong to the GBrain host and are not part of the
    # VoltMind MVP runtime. Keep the resolver focused on VoltMind operations.
    content = re.sub(
        r"\n## Identity & access \(always-on\)\n.*?(?=\n## Disambiguation rules\n)",
        "\n",
        content,
        flags=re.DOTALL,
    )

    # Normalize the source's trailing newline and reject accidental mojibake.
    content = content.rstrip("\r\n") + "\n"
    for marker in ("�", "鏄", "锛"):
        if marker in content:
            raise ValueError(f"Unexpected mojibake marker {marker!r} in adapted resolver")

    if re.search(r"gbrain", content, flags=re.IGNORECASE):
        raise ValueError("GBrain naming remains in the adapted resolver")
    return content


def main() -> None:
    if not SOURCE.is_file():
        raise FileNotFoundError(f"Resolver source not found: {SOURCE}")

    TARGET.parent.mkdir(parents=True, exist_ok=True)
    shutil.copyfile(SOURCE, TARGET)
    copied = read_utf8(TARGET)
    write_utf8(TARGET, adapt(copied))


if __name__ == "__main__":
    main()
