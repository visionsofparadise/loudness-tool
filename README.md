# loudness-tool

loudness-tool measures true peak, integrated loudness and loudness range per ITU-R BS.1770 and EBU Tech 3342, and adjusts audio to true-peak and loudness targets. It reads and writes WAV and raw PCM, from files or pipes, and runs offline on your own machine.

## Install

Download the latest release from [GitHub Releases](https://github.com/visionsofparadise/loudness-tool/releases/latest). `SHA256SUMS` lists every download's checksum.

- **Windows:** run `loudness-tool-<version>-windows-x64-setup.exe`, or the `arm64` one on an Arm PC. It installs for your user and adds `loudness-tool` to your PATH, so a new terminal runs it. Apps & features uninstalls it.
- **macOS and Linux:** download the standalone executable for your platform, such as `loudness-tool-<version>-mac-arm64` or `loudness-tool-<version>-linux-x64` (the Linux builds need glibc), rename it `loudness-tool`, mark it executable with `chmod +x loudness-tool` and move it to a folder on your PATH. On macOS, `xattr -d com.apple.quarantine loudness-tool` lets the unsigned executable run.

## Commands

An input path of `-` or `pipe:` reads stdin. `tp-norm`, `lufs-norm`, `crest` and `target` require `-o, --output <path>`: a file, `-` for stdout, or the input's own path for in-place processing. Each prints its figures to stdout, or to stderr when the audio goes to stdout.

Every command takes `--oversampling <factor>`, the true-peak oversampling factor, 8 or 16 (default: 8). Every true-peak figure, target and ceiling is read at that factor. 16 reads closer to the ideal true peak on content near half the sample rate; 8 runs faster.

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

Applies one uniform gain so the integrated loudness lands on a target, and warns when the written file's true peak sits above 0 dBTP or when samples clip at full scale.

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

Brings audio to a loudness target, a true-peak target, or both; quiet passages, the body and the peaks each get their own gain. At least one of `--lufs` and `--tp` is required. The output's true peak stays at or under the ceiling, which is `--tp` when given and 0 dBTP otherwise. `--floor` and `--pivot` read loudness over 400 ms centred on each moment, so audio within 200 ms of louder audio takes that audio's gain.

```sh
loudness-tool target input.wav -o output.wav --lufs -16
loudness-tool target input.wav -o output.wav --lufs -16 --tp -1
```

- `--lufs <n>`: target integrated loudness in LUFS.
- `--tp <dBTP>`: target true peak in dBTP.
- `--floor <dB>`: loudness at or below which audio keeps its level, in LUFS (default: from the audio's quietest passages).
- `--pivot <dB>`: loudness at which audio takes the full body gain, in LUFS (default: the audio's typical loudness).
- `--limit-percentile <p>`: share of the audio's true-peak levels below the limit (default: 0.995).
- `--limit-db <dB>`: true-peak level from which the peaks take the peak gain, in dBTP (default: the level `--limit-percentile` sets).
- `--never-expand`: peaks never get more gain than the body.
- `--smoothing <ms>`: how gradually the gain changes, in milliseconds (default: 40).
- `--tolerance <dB>`: how close the loudness lands to `--lufs`, or the true peak to `--tp` without `--lufs`, in dB (default: 0.5).

`--limit-percentile`, `--limit-db` and `--never-expand` require `--tp`, and `--never-expand` also requires `--lufs`.

## Pipes

```sh
ffmpeg -i input.mp3 -f wav - | loudness-tool lufs-norm - -o - | ffmpeg -f wav -i - output.flac
```

A piped WAV ends at the data size its header states; ffmpeg writes a streaming header, so its piped WAV reads to the end of the stream. As in ffmpeg, `-f <format>` (default: wav) sets the format of the input or `-o` it precedes, the raw PCM formats being `u8`, `s16le`, `s24le`, `s32le`, `f32le` and `f64le`, and a raw input takes `-ar <rate>` (default: 44100) and `-ac <channels>` (default: 1). Every output keeps the input's sample rate and channels. Temporary files, including the copy of a piped or raw input, go in the folder `--scratch-dir <path>` sets (default: the system temporary directory).

## License

[MIT](LICENSE)
