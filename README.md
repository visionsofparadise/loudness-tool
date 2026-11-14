# loudness-tool

loudness-tool measures true peak, integrated loudness and loudness range per ITU-R BS.1770 and EBU Tech 3342, and adjusts audio to true-peak and loudness targets. It reads and writes WAV and raw PCM, from files or pipes, and runs offline on your own machine.

## Install

```sh
npm install -g loudness-tool
```

## Commands

An input path of `-` reads stdin. Every command but `stats` writes to `-o, --output <path>`, a file or `-` for stdout, and takes the input's own path for in-place processing.

### stats

Reports the sample rate, channels, bit depth, duration, true peak, integrated loudness and loudness range of one or more inputs.

```sh
loudness-tool stats input.wav
loudness-tool stats --json a.wav b.wav
```

- `--json`: prints the figures as a JSON array.

### tp-norm

Applies one uniform gain so the true peak lands on a target.

```sh
loudness-tool tp-norm input.wav -o output.wav --tp -1
```

- `--tp <dBTP>`: target true peak in dBTP (default: -1).

### lufs-norm

Applies one uniform gain so the integrated loudness lands on a target, and warns when the written file's true peak sits above 0 dBTP.

```sh
loudness-tool lufs-norm input.wav -o output.wav --lufs -16
```

- `--lufs <LUFS>`: target integrated loudness in LUFS (default: -16).

### crest

Lowers true peak by blending peaks with copies whose phase is spread a few milliseconds earlier and later; loudness drops where it acts.

```sh
loudness-tool crest input.wav -o output.wav
loudness-tool crest input.wav -o output.wav --spread 8 --steps 2 --smoothing 100
```

- `--spread <ms>`: widest spread in milliseconds (default: 8).
- `--steps <n>`: number of spreads, each a quarter of the last, each used earlier and later (default: 2).
- `--smoothing <ms>`: milliseconds the blend takes to fade in or out (default: 100).

### target

Brings audio to a loudness target, a true-peak target, or both; quiet passages, the body and the peaks each get their own gain. At least one of `--lufs` and `--tp` is required. The output's true peak stays at or under the ceiling, which is `--tp` when given and 0 dBTP otherwise.

```sh
loudness-tool target input.wav -o output.wav --lufs -16
loudness-tool target input.wav -o output.wav --lufs -16 --tp -1
```

- `--lufs <n>`: target integrated loudness in LUFS.
- `--tp <dBTP>`: target true peak in dBTP, also the ceiling.
- `--floor <dB>`: loudness below which audio is never raised, in LUFS (default: the quietest short-term loudness, at least 6 LU under the pivot).
- `--pivot <dB>`: loudness at which audio takes the full body gain, in LUFS (default: the median short-term loudness, or -40 when the audio has none).
- `--limit-percentile <p>`: share of the audio's true-peak levels below the limit (default: 0.995).
- `--limit-db <dB>`: true-peak level from which the peaks take the peak gain, in dBTP (default: the level `--limit-percentile` sets).
- `--never-expand`: peaks never get more gain than the body.
- `--smoothing <ms>`: how gradually the gain changes, in milliseconds (default: 40).
- `--tolerance <dB>`: how close the loudness lands to `--lufs`, or the true peak to `--tp` without `--lufs`, in dB (default: 0.5).

`--limit-percentile`, `--limit-db` and `--never-expand` shape the peaks and take `--tp`, and `--never-expand` also takes `--lufs`.

## Pipes

```sh
ffmpeg -i input.mp3 -f wav - | loudness-tool lufs-norm - -o - | ffmpeg -f wav -i - output.flac
```

A piped WAV ends where its header's data size says. Raw PCM takes ffmpeg's `-f <format>` (`u8`, `s16le`, `s24le`, `s32le`, `f32le` or `f64le`; default: wav), `-ar <rate>` (default: 44100) and `-ac <channels>` (default: 1) in front of the input or `-o` they describe. Every command but `stats` copies a piped or raw input to a temporary file in the folder `--scratch-dir <path>` sets (default: the system temporary directory).

## License

[MIT](LICENSE)
