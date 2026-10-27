#!/usr/bin/env bash
set -euo pipefail
export LC_ALL=C

# Native audio tests need an actual output backend on a hosted Linux runner.
# This virtual sink replaces absent speaker hardware, not Web Audio or events.
pulseaudio --start --exit-idle-time=-1 --log-target=stderr
pactl load-module module-null-sink sink_name=bd_e2e_audio sink_properties=device.description=BlockDistractionE2E
pactl set-default-sink bd_e2e_audio
pactl set-sink-volume bd_e2e_audio 100%
pactl set-sink-mute bd_e2e_audio 0
test "$(pactl get-default-sink)" = bd_e2e_audio
test "$(pactl get-sink-mute bd_e2e_audio)" = 'Mute: no'
pactl info

if [[ -n ${GITHUB_ENV:-} ]]; then
  echo 'PULSE_SINK=bd_e2e_audio' >> "$GITHUB_ENV"
fi
