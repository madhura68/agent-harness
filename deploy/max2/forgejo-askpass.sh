#!/bin/sh
# Geeft Forgejo-credentials alleen voor git.jp-visser.nl; elke andere prompt krijgt niets.
case "$1" in
  "Username for 'https://git.jp-visser.nl'"*) echo "agent-harness" ;;
  "Password for 'https://agent-harness@git.jp-visser.nl'"*) printf '%s\n' "$FORGEJO_PUSH_TOKEN" ;;
  *) exit 1 ;;
esac
