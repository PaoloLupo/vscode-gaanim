"""Write src/core/typstSymbols.json from codex's sym.txt.

Typst names its math symbols in the `codex` crate. Gaanim compiles math with
Typst 0.15.1, which uses codex 0.3.0, so completion offers exactly the names
that compile. Run it again when Gaanim moves to another codex:

    python scripts/gen_typst_symbols.py [path/to/codex-X.Y.Z/src/modules/sym.txt]

Without a path it looks for the newest codex in the Cargo registry. It follows
codex's own parser (build.rs): `//` comments, `name value` lines, `.modifier
value` variants, `name {` ... `}` modules, `@deprecated:` notes (those names
are left out) and `\\u{...}` / `\\vs{...}` escapes.
"""

import glob
import json
import os
import re
import sys

VS = {str(n): chr(0xFE00 + n - 1) for n in range(1, 17)}
VS["text"] = "︎"
VS["emoji"] = "️"


def decode(text):
    out = []
    while text:
        if text.startswith("\\u{"):
            code, _, text = text[3:].partition("}")
            out.append(chr(int(code, 16)))
        elif text.startswith("\\vs{"):
            code, _, text = text[4:].partition("}")
            out.append(VS[code])
        elif "\\" in text:
            index = text.index("\\")
            out.append(text[:index])
            text = text[index:]
        else:
            out.append(text)
            text = ""
    return "".join(out)


def parse(path):
    symbols = []
    modules = []
    deprecated = False
    base = None
    with open(path, encoding="utf-8") as handle:
        for raw in handle:
            line = raw.split("//", 1)[0].strip()
            if not line:
                continue
            head, _, tail = line.partition(" ")
            tail = tail.strip() or None
            if head == "@deprecated:":
                deprecated = True
                continue
            if tail == "{":
                modules.append(head)
                base = None
                deprecated = False
                continue
            if head == "}" and tail is None:
                modules.pop()
                base = None
                continue
            if head.startswith("."):
                if base is not None and tail is not None and not deprecated:
                    symbols.append((base + head, decode(tail)))
                deprecated = False
                continue
            base = ".".join(modules + [head])
            if tail is not None and not deprecated:
                symbols.append((base, decode(tail)))
            deprecated = False
    return symbols


def find_default():
    pattern = os.path.join(os.path.expanduser("~"), ".cargo", "registry", "src", "*", "codex-*", "src", "modules", "sym.txt")

    def version(path):
        match = re.search(r"codex-(\d+)\.(\d+)\.(\d+)", path)
        return tuple(int(part) for part in match.groups()) if match else (0, 0, 0)

    found = glob.glob(pattern)
    return max(found, key=version) if found else None


def main():
    path = sys.argv[1] if len(sys.argv) > 1 else find_default()
    if not path:
        sys.exit("codex sym.txt not found; pass its path")
    match = re.search(r"codex-(\d+\.\d+\.\d+)", path.replace("\\", "/"))
    version = match.group(1) if match else "unknown"
    symbols = parse(path)
    root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    target = os.path.join(root, "src", "core", "typstSymbols.json")
    with open(target, "w", encoding="utf-8", newline="\n") as handle:
        json.dump({"version": version, "symbols": symbols}, handle, ensure_ascii=False, separators=(",", ":"))
    print("%d symbols from codex %s -> %s" % (len(symbols), version, target))


if __name__ == "__main__":
    main()
