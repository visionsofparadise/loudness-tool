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
loudness-tool stats - < input.wav
```

Prints the path, sample rate, channels, bit depth, duration, true peak, integrated loudness, and loudness range for each file. `--json` writes an array of those fields to stdout. An input of `-` reads stdin, once per run, and prints its path as `-`.

### tp-norm

Apply one uniform gain so the file's true peak lands on a target (default -1 dBTP).

```sh
loudness-tool tp-norm input.wav -o output.wav
loudness-tool tp-norm input.wav -o output.wav --tp -1
loudness-tool tp-norm - -o - < input.wav > output.wav
```

`--tp` must be in [-24, 0). `-o` is an alias for `--output`. In-place processing is supported by passing the input path as the output. An input of `-` reads stdin, and `-o -` writes stdout.

A source with no measurable true peak is copied to the output unchanged, and the reason is printed on stderr.

On success it prints the source true peak, the target, the applied gain, and the output path, on stderr when the output is stdout.

### lufs-norm

Apply one uniform gain so the file's integrated loudness lands on a target (default -16 LUFS).

```sh
loudness-tool lufs-norm input.wav -o output.wav
loudness-tool lufs-norm input.wav -o output.wav --lufs -16
loudness-tool lufs-norm - -o - < input.wav > output.wav
```

`--lufs` must be in [-50, 0] in steps of 0.1. `-o` is an alias for `--output`. In-place processing is supported by passing the input path as the output. An input of `-` reads stdin, and `-o -` writes stdout.

A source with no measurable loudness is copied to the output unchanged, and the reason is printed on stderr.

On success it prints the source integrated loudness, the target, the applied gain, the output true peak, and the output path, on stderr when the output is stdout. An output true peak above 0 dBTP is also written as a warning on stderr.

### crest

Lower the true peak while keeping the loudness and tonal balance. Each peak's energy is spread a few milliseconds earlier and later, so the peak flattens, and passages that gain nothing from it are left untouched.

```sh
loudness-tool crest input.wav -o output.wav
loudness-tool crest input.wav -o output.wav --spread 4 --smoothing 100
loudness-tool crest - -o - < input.wav > output.wav
```

`--spread` is the widest spread crest tries, in milliseconds (default 4, in (0, 50]). A wider setting gives it more spreads to try for a lower peak, and the run takes longer. `--smoothing` is how long the effect takes to fade in or out, in milliseconds (default 100, above zero). A longer fade is less audible, and a shorter one keeps the effect closer to each peak. `-o` is an alias for `--output`. In-place processing is supported by passing the input path as the output. An input of `-` reads stdin, and `-o -` writes stdout.

The output has the lowest true peak those settings can reach, with as much of the file left as it was as that peak allows.

On success it prints the source true peak, the output true peak, their delta, and the output path, on stderr when the output is stdout.

### target

Bring a file to a target integrated loudness, a target true peak, or both. The gain follows the audio's level: quiet passages, the body, and the loudest moments each get their own, so the file can get louder without its peaks rising with it.

```sh
loudness-tool target input.wav -o output.wav --lufs -16
loudness-tool target input.wav -o output.wav --lufs -16 --tp -1
loudness-tool target input.wav -o output.wav --tp -1 --never-expand
loudness-tool target - -o - --lufs -16 < input.wav > output.wav
```

`--lufs` is the target integrated loudness, in [-50, 0] in steps of 0.1, and `--tp` the target true peak, in [-24, 0). Neither has a default and at least one is required. The output never exceeds either target. With only `--lufs`, the loudest moments take the body's gain and are held to a ceiling. With only `--tp`, the file is raised or lowered as a whole, its loudest moments held to a ceiling, until its true peak lands on the target. An input of `-` reads stdin, and `-o -` writes stdout.

- `--floor <dB>`: audio quieter than this, such as background noise between phrases, keeps its level. Defaults to the level of the file's quietest passages; in [-100, 0).
- `--pivot <dB>`: audio from the floor up to this level is raised gradually, reaching the body's full gain here. Defaults to the file's typical level; in [-80, 0), and above `--floor` when both are given. A file too short or quiet to have a typical level uses -40 dB, and says so on stderr.
- `--limit-percentile <p>`: the share of the audio below the limit level (default 0.995, in [0.5, 1.0]), so by default the loudest 0.5% is held to the ceiling. Audio between the pivot and the limit level moves gradually from the body's gain to the peaks'.
- `--limit-db <dB>`: sets the limit level directly, in place of `--limit-percentile`; in [-60, 0).
- `--never-expand`: the loudest moments never get more gain than the body, so the dynamic range never widens.
- `--smoothing <ms>`: how gradually the gain changes, in milliseconds (default 1, in [0.01, 200]). A sudden gain change adds audible distortion, so a longer setting sounds cleaner, and a shorter one follows each peak more closely.
- `--tolerance <dB>`: how close the loudness must land to its target, or the true peak when only `--tp` is given (default 0.5, in (0, 6]).

A source with no measurable loudness is copied to the output unchanged.

On success it prints the output integrated loudness, true peak, and loudness range, the body and peak gains, whether the run landed within tolerance, and the output path, on stderr when the output is stdout.

## Pipes

`-` and `-o -` combine with file paths in any mix. A stream that declares no length, as ffmpeg writes to a pipe, is read to its end:

```sh
ffmpeg -i input.mp3 -f wav - | loudness-tool lufs-norm - -o - | ffmpeg -f wav -i - output.flac
```

loudness-tool reads stdin to its end, so the program writing it must close stdin after the WAV; a length declared in the WAV header does not end the read. Every command but `stats` reads its input more than once, so input from stdin is also written to a temporary file as it is first read, which takes as much disk space as the input.

## Temporary files

`--scratch-dir <path>` sets the directory that holds the copy of stdin and `target`'s working files (default: the system temporary directory). It goes before or after the command:

```sh
loudness-tool --scratch-dir /tmp/lt target input.wav -o output.wav --lufs -16
loudness-tool target - -o output.wav --tp -1 --scratch-dir /tmp/lt < input.wav
```

A run keeps its files there in subdirectories it makes and removes when it ends. A run also removes any subdirectory left there by a run that is no longer running. A file output is first written to a temporary file beside it, then renamed into place.

## Channels

Loudness weights each channel by its loudspeaker position, per ITU-R BS.1770-5. A WAV file states its positions in the channel mask of a WAVE_FORMAT_EXTENSIBLE header. Positions to the side, from 60° to 120° off centre and below 30° elevation, weigh 1.41: the side channels, the back pair when the mask has no side channels, as in 5.1, and a back centre when it is the only surround, with no side channels or back pair. Every other position weighs 1.0. The LFE channel is left out of loudness and included in true peak.

A channel with no stated position weighs 1.0. That is every channel of a plain WAV header or of a mask of 0, every channel past the ones the mask names, and every channel on a mask bit that names no position. Mono and stereo measure the same without a mask as with front positions, as BS.1770 specifies; a mask that states other positions weighs those channels by position. A multichannel file with a plain header measures every channel at 1.0, LFE included, so a 5.1 file reads with its LFE counted and its surrounds under their standard weight; the same file with a channel mask gets the standard weighting.

## Output files

Mono and stereo output from an input without a channel mask is written with a plain WAV header. Output with more than two channels, or from an input with a channel mask, is written as WAVE_FORMAT_EXTENSIBLE carrying the input's mask, so it measures as the input did. Output larger than 4 GiB is written as RF64 (EBU Tech 3306). Output keeps the input's bit depth, except that 8-bit input is written as 16-bit and 64-bit float input as 32-bit float. A source copied to the output unchanged keeps its own header and bit depth, and from stdin is written as WAVE_FORMAT_EXTENSIBLE.

## License

MIT
