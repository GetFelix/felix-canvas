# Performance

Each row of the design's [performance targets](design.md#performance-targets),
measured, with the conditions it was measured under.
[development.md](development.md#measuring-the-performance-targets) has the
commands and how each target is timed.

## Conditions

Measured on a 4-core GitHub Codespace (16 GB) on 2026-10-03, with Felix
0.6.0-preview from the published images, the gateway as a release build,
headless Chromium, the snapshotter and the page server all on that one host.
That host is shared, so these are what the design looks like on a laptop-class
machine, not Felix's ceiling.

## Results

| Path | Target | Codespace, one host |
|---|---|---|
| Local echo, input to own pixel | < 16 ms | p50 0.7 ms, p99 24.6 ms. Headless Chromium draws without waiting for the display; a 60 Hz screen adds up to one frame |
| Edit visible to another client | < 50 ms p50, < 150 ms p99 | p50 6.0 ms, p99 19.0 ms |
| Keystroke to own character in the editor | < 16 ms | p50 10.9 ms, p99 13.5 ms |
| Typed text visible to another client | < 250 ms p50, < 400 ms p99 | p50 160 ms, p99 166 ms, from the first keystroke each change carries; 150 ms of that is the editor collecting keystrokes |
| Text ops per typing person | 7 a second at most | 5.0 a second, typing 10 keys a second for 30 s |
| Cursor visible to another client | < 40 ms p50 | p50 8.2 ms |
| Join a 10,000-change room | < 500 ms to first correct frame | 135 ms; 96 ms when half the changes are typing into 50 text boxes |
| Load a 10,000-change history, half of it typing | < 0.5 ms per change | 1.68 s, 0.17 ms per change, with the debug gateway CI uses |
| Seek in that history | < 50 ms, slowest seek | 12.4 ms over 24 stops |
| Lay out a 2,000-character body | < 4 ms | 1.6 to 1.9 ms median |
| Fanout, 1 to 500 viewers | Publish p50 within 15% | 13.7 ms with 1, 15.2 ms with 500: within 10.9%. Each of the 499 extra viewers received all 900 edits, none dropped |
| Snapshot lag | < 1,000 changes behind | p50 257, max 500, while a writer adds 300 changes a second |
| Owning broker killed | Editing resumes, nothing acknowledged is lost | 5 of 5 runs on the three-broker dev stack: every acknowledged edit kept, all editors on one state hash. The longest wait between acknowledged edits was 5.7 to 12.8 s, median 6.0 s, with the dev stack's 3 s liveness window; 130 to 400 edits a run landed twice and were absorbed |

The fanout run alternates 1 viewer and 500 three times, 300 edits each, one
every 20 ms. Most of the 13 ms publish time is the broker writing each change
to disk before it acknowledges, on the Codespace's disk. The 499 viewers share
one Felix client and one connection, which is how `felix-loadgen` holds them
too.

## Still to run

These need dedicated hardware, with Felix on its own machines and the browsers
elsewhere in the same region:

| Path | Why it needs that run |
|---|---|
| Fanout, 1 to 500 viewers | The viewers should be separate clients on their own connections, from more than one host, so the broker's fanout is measured rather than this host's CPU |
| Edit and cursor visible to another client | Over a real network hop between browser, gateway and broker |
| Local echo | In a headed browser on a real display |
| Owning broker killed | With Felix's default liveness settings and brokers on separate machines |

