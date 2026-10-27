#!/usr/bin/env bash
# Cursor Hook: Guards use_figma scripts against >50,000 char payloads and unresolved CSS variables.
set -euo pipefail

INPUT="$(cat || true)"

TARGET_FILE=""
if [ -n "$INPUT" ]; then
  TARGET_FILE="$(printf '%s' "$INPUT" | node -e '
    let raw = "";
    process.stdin.on("data", d => raw += d);
    process.stdin.on("end", () => {
      try {
        const j = JSON.parse(raw);
        if (j.file_path) { console.log(j.file_path); return; }
        if (j.command) {
          const m = j.command.match(/([\w./-]+\.js)\b/);
          if (m) console.log(m[1]);
        }
      } catch {}
    });
  ')"
fi

if [ -z "$TARGET_FILE" ] || [ ! -f "$TARGET_FILE" ]; then
  exit 0
fi

case "$TARGET_FILE" in
  *build*.js|*step*.js)
    CHAR_COUNT="$(wc -c < "$TARGET_FILE" | tr -d ' ')"
    if [ "$CHAR_COUNT" -gt 50000 ]; then
      echo "BLOCKED: Figma payload $TARGET_FILE is $CHAR_COUNT bytes (> 50,000 limit). Run compile-to-figma.mjs to split into .partN.js chunks." >&2
      exit 2
    fi
    if grep -q "var(--" "$TARGET_FILE"; then
      echo "BLOCKED: Figma payload $TARGET_FILE contains unresolved CSS variable var(--...). Resolve computed styles in headless Chromium first." >&2
      exit 2
    fi
    ;;
esac

exit 0
