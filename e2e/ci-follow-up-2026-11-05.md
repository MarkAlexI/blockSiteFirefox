# Firefox native CI follow-up — November 5, 2026

Inspected [run 41916846967](https://github.com/MarkAlexI/blockSiteFirefox/actions/runs/41916846967),
commit `cdf55abb5bfcd52014e6d00e50b10d15fb02ab57`.

Both native macOS smoke jobs passed **24/24**, including the final report-body
verification. Downloaded reports identify Darwin/arm64 and Darwin/x64, Firefox
158.0, and 24 started/passed bodies with zero blocked or unrun scenarios.
Linux upgrade and overdue also passed. Extension CI passed.

Linux core failed **before packaging or running any scenario**: the two-minute
audio preparation step was still downloading PulseAudio dependencies from
`azure.archive.ubuntu.com` when its step deadline expired. The log does not show
an audio assertion or a product scenario failure.

The Linux setup now uses the official Ubuntu HTTPS mirrors and bounded APT
transport settings already used by the Chromium workflow. PulseAudio is installed
only for core, during dependency setup. `--no-install-recommends` avoids unrelated
recommended codec/video driver packages. The separate two-minute audio step now
only starts and validates the existing real PulseAudio sink.

No audio backend, browser test, scenario deadline, retry, Mac runner, required
aggregate or runtime source changed. Extension version remains 5.5.9. A new Linux
core run must confirm installation and actual native audio scenarios; local
workflow validation does not establish a successful hosted APT download.
