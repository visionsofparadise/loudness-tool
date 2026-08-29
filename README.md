# loudness-tool

WAV loudness cli.

## Install

```sh
npm install -g loudness-tool
```

```sh
loudness-tool --version
```

## Commands

### stats

Report the true-peak level, integrated loudness, and loudness range of one or more WAV files.

```sh
loudness-tool stats input.wav
loudness-tool stats --json a.wav b.wav
```

Prints the path, sample rate, channels, bit depth, duration, true peak, integrated loudness, and loudness range for each file. `--json` writes an array of those fields to stdout.

### tp-norm

Apply one uniform gain so the file's true peak lands on a target (default -1 dBTP).

```sh
loudness-tool tp-norm input.wav -o output.wav
loudness-tool tp-norm input.wav -o output.wav --tp -1
```

`--tp` must be below 0. `-o` is an alias for `--output`. In-place processing is supported by passing the input path as the output.

On success it prints the source true peak, the target, the applied gain, and the output path.

### lufs-norm

Apply one uniform gain so the file's integrated loudness lands on a target (default -16 LUFS).

```sh
loudness-tool lufs-norm input.wav -o output.wav
loudness-tool lufs-norm input.wav -o output.wav --lufs -16
```

`--lufs` is any finite LUFS value. `-o` is an alias for `--output`. In-place processing is supported by passing the input path as the output.

A source with no measurable loudness is copied to the output unchanged, and the reason is printed on stderr.

On success it prints the source integrated loudness, the target, the applied gain, and the output path.

### crest

Rearrange phase so the magnitude spectrum is preserved and tall true-peak excursions flatten.

```sh
loudness-tool crest input.wav -o output.wav
loudness-tool crest input.wav -o output.wav --smoothing 100 --frame-size 2048
```

`--smoothing` is the bidirectional control-trajectory time constant in milliseconds (default 100). `--frame-size` is the analysis frame length, a power of two (default 2048). `-o` is an alias for `--output`. In-place processing is supported by passing the input path as the output.

### target

Fit a file to a joint integrated-loudness and true-peak pair with a content-adaptive gain curve.

```sh
loudness-tool target input.wav -o output.wav
loudness-tool target input.wav -o output.wav --lufs -16 --tp -1
loudness-tool target input.wav -o output.wav --never-expand --scratch-dir /tmp/lt
```

`--lufs` defaults to -16 and must be in [-50, 0]. `--tp` defaults to the source true peak and must be below 0 when supplied. `--pivot` and `--floor` default to the Tech 3342 considered-set median and minimum; when both are supplied, floor must be below pivot. `--limit-percentile` defaults to 0.995; `--limit-db` overrides that derivation. `--smoothing` defaults to 1 ms. `--tolerance` defaults to 0.5 dB.

Output never exceeds either target on a 0.01 dB grain. When the pair is infeasible the ceiling wins and the solve reports non-convergence.

A source with no measurable loudness is copied to the output unchanged.

## License

MIT
