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

Prints the path, sample rate, channels, bit depth, duration, true peak, integrated loudness, and loudness range for each file. `--json` writes an array of those fields to stdout. Files with more than two channels are refused; loudness measurement beyond stereo needs BS.1770 Table 3 channel weighting.

### tp-norm

Apply one uniform gain so the file's true peak lands on a target (default -1 dBTP).

```sh
loudness-tool tp-norm input.wav -o output.wav
loudness-tool tp-norm input.wav -o output.wav --tp -1
```

`--tp` must be in [-24, 0). `-o` is an alias for `--output`. In-place processing is supported by passing the input path as the output.

A source with no measurable true peak is copied to the output unchanged, and the reason is printed on stderr.

On success it prints the source true peak, the target, the applied gain, and the output path.

### lufs-norm

Apply one uniform gain so the file's integrated loudness lands on a target (default -16 LUFS).

```sh
loudness-tool lufs-norm input.wav -o output.wav
loudness-tool lufs-norm input.wav -o output.wav --lufs -16
```

`--lufs` must be in [-50, 0] in steps of 0.1. `-o` is an alias for `--output`. In-place processing is supported by passing the input path as the output.

A source with no measurable loudness is copied to the output unchanged, and the reason is printed on stderr. Files with more than two channels are refused; loudness measurement beyond stereo needs BS.1770 Table 3 channel weighting.

On success it prints the source integrated loudness, the target, the applied gain, the predicted output true peak, and the output path. A predicted peak above 0 dBTP is also written as a warning on stderr.

### crest

Rearrange phase so the magnitude spectrum is preserved and tall true-peak excursions flatten.

```sh
loudness-tool crest input.wav -o output.wav
loudness-tool crest input.wav -o output.wav --smoothing 100 --frame-size 2048
```

`--smoothing` is the bidirectional control-trajectory time constant in milliseconds (default 100). `--frame-size` is the analysis frame length, a power of two of at least 4 (default 2048). `-o` is an alias for `--output`. In-place processing is supported by passing the input path as the output.

### target

Fit a file to a joint integrated-loudness and true-peak pair with a content-adaptive gain curve.

```sh
loudness-tool target input.wav -o output.wav --lufs -16
loudness-tool target input.wav -o output.wav --lufs -16 --tp -1
loudness-tool target input.wav -o output.wav --tp -1 --never-expand --scratch-dir /tmp/lt
```

`--lufs` and `--tp` are each optional with no default, and at least one is required; `--lufs` must be in [-50, 0] in steps of 0.1 and `--tp` in [-24, 0). Without `--tp` the true peak is not targeted: the limit gain follows the body gain, and content above the limit is still brick-walled at the limit level plus that gain. Without `--lufs` only the true peak is targeted: the body gain follows the limit gain, both set so the output true peak lands on `--tp`. `--pivot` and `--floor` default to the Tech 3342 considered-set median and minimum and must be in [-80, 0) and [-100, 0) when supplied; when both are supplied, floor must be below pivot. `--limit-percentile` defaults to 0.995 and must be in [0.5, 1.0]; `--limit-db` overrides that derivation and must be in [-60, 0). `--smoothing` defaults to 1 ms and must be in [0.01, 200]. `--tolerance` defaults to 0.5 dB and must be in (0, 6]. A source that yields no considered LRA blocks falls back to a -40 dB pivot, and the reason is printed on stderr. Files with more than two channels are refused; loudness measurement beyond stereo needs BS.1770 Table 3 channel weighting.

Output never exceeds either target on a 0.01 dB grain.

A source with no measurable loudness is copied to the output unchanged.

## License

MIT
