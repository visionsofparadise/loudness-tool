# loudness-tool

WAV and raw PCM loudness cli.

## Install

```sh
npm install -g loudness-tool
```

```sh
loudness-tool --version
```

## Commands

### stats

Report the true-peak level, integrated loudness, and loudness range of one or more audio inputs.

```sh
loudness-tool stats input.wav
loudness-tool stats --json a.wav b.wav
loudness-tool stats - < input.wav
```

Prints the path, sample rate, channels, bit depth, duration, true peak, integrated loudness, and loudness range for each input. `--json` writes an array of those fields to stdout. An input of `-` reads stdin, once per run, and prints its path as `-`.

### tp-norm

Apply one uniform gain so the audio's true peak lands on a target (default -1 dBTP).

```sh
loudness-tool tp-norm input.wav -o output.wav
loudness-tool tp-norm input.wav -o output.wav --tp -1
loudness-tool tp-norm - -o - < input.wav > output.wav
```

`--tp` must be in [-24, 0). `-o` is an alias for `--output`. In-place processing is supported by passing the input path as the output. An input of `-` reads stdin, and `-o -` writes stdout.

A source with no measurable true peak is passed through to the output at unity gain ([Output files](#output-files)), and the reason is printed on stderr.

On success it prints the source true peak, the target, the applied gain, and the output path, on stderr when the output is stdout.

### lufs-norm

Apply one uniform gain so the audio's integrated loudness lands on a target (default -16 LUFS).

```sh
loudness-tool lufs-norm input.wav -o output.wav
loudness-tool lufs-norm input.wav -o output.wav --lufs -16
loudness-tool lufs-norm - -o - < input.wav > output.wav
```

`--lufs` must be in [-50, 0] in steps of 0.1. `-o` is an alias for `--output`. In-place processing is supported by passing the input path as the output. An input of `-` reads stdin, and `-o -` writes stdout.

A source with no measurable loudness is passed through to the output at unity gain ([Output files](#output-files)), and the reason is printed on stderr.

On success it prints the source integrated loudness, the target, the applied gain, the output true peak, and the output path, on stderr when the output is stdout. An output true peak above 0 dBTP is also written as a warning on stderr.

### crest

Lower the audio's true peak while keeping its loudness and tonal balance. Each peak's energy is spread a few milliseconds earlier and later, so the peak flattens, and passages that gain nothing from it are left untouched.

```sh
loudness-tool crest input.wav -o output.wav
loudness-tool crest input.wav -o output.wav --spread 4 --smoothing 100
loudness-tool crest - -o - < input.wav > output.wav
```

`--spread` is the widest spread crest tries, in milliseconds (default 4, in (0, 50]). A wider setting gives it more spreads to try for a lower peak, and the run takes longer. `--smoothing` is how long the effect takes to fade in or out, in milliseconds (default 100, above zero). A longer fade is less audible, and a shorter one keeps the effect closer to each peak. `-o` is an alias for `--output`. In-place processing is supported by passing the input path as the output. An input of `-` reads stdin, and `-o -` writes stdout.

The output has the lowest true peak those settings can reach, with as much of the audio left as it was as that peak allows.

On success it prints the source true peak, the output true peak, their delta, and the output path, on stderr when the output is stdout.

### target

Bring audio to a target integrated loudness, a target true peak, or both. The gain follows the audio's level: quiet passages, the body, and the loudest moments each get their own, so the audio can get louder without its peaks rising with it.

```sh
loudness-tool target input.wav -o output.wav --lufs -16
loudness-tool target input.wav -o output.wav --lufs -16 --tp -1
loudness-tool target input.wav -o output.wav --tp -1 --never-expand
loudness-tool target - -o - --lufs -16 < input.wav > output.wav
```

`--lufs` is the target integrated loudness, in [-50, 0] in steps of 0.1, and `--tp` the target true peak, in [-24, 0). Neither has a default and at least one is required. The output never exceeds either target. With only `--lufs`, the loudest moments take the body's gain and are held to a ceiling. With only `--tp`, the audio is raised or lowered as a whole, its loudest moments held to a ceiling, until its true peak lands on the target. An input of `-` reads stdin, and `-o -` writes stdout.

- `--floor <dB>`: audio quieter than this, such as background noise between phrases, keeps its level. Defaults to the level of the audio's quietest passages; in [-100, 0).
- `--pivot <dB>`: audio from the floor up to this level is raised gradually, reaching the body's full gain here. Defaults to the audio's typical level; in [-80, 0), and above `--floor` when both are given. Audio too short or quiet to have a typical level uses -40 dB, and says so on stderr.
- `--limit-percentile <p>`: the share of the audio below the limit level (default 0.995, in [0.5, 1.0]), so by default the loudest 0.5% is held to the ceiling. Audio between the pivot and the limit level moves gradually from the body's gain to the peaks'.
- `--limit-db <dB>`: sets the limit level directly, in place of `--limit-percentile`; in [-60, 0).
- `--never-expand`: the loudest moments never get more gain than the body, so the dynamic range never widens.
- `--smoothing <ms>`: how gradually the gain changes, in milliseconds (default 1, in [0.01, 200]). A sudden gain change adds audible distortion, so a longer setting sounds cleaner, and a shorter one follows each peak more closely.
- `--tolerance <dB>`: how close the loudness must land to its target, or the true peak when only `--tp` is given (default 0.5, in (0, 6]).

A source with no measurable loudness is passed through to the output at unity gain ([Output files](#output-files)).

On success it prints the output integrated loudness, true peak, and loudness range, the body and peak gains, whether the run landed within tolerance, and the output path, on stderr when the output is stdout.

## Pipes

`-` and `-o -` combine with file paths in any mix:

```sh
ffmpeg -i input.mp3 -f wav - | loudness-tool lufs-norm - -o - | ffmpeg -f wav -i - output.flac
```

loudness-tool reads a pipe to its end, so the program writing it must close the pipe after the audio; a length declared in a WAV header does not end the read. Every command but `stats` reads its input more than once, so an input from a pipe, or a raw input file, is also written to a temporary file as it is first read, which takes as much disk space as the input.

## Raw PCM

`-f`, `-ar`, `-ac` and `-ch_layout` describe raw PCM as ffmpeg's options of those names do. Every spelling and value ffmpeg accepts for them means what it means in ffmpeg, which brings the aliases `-channel_layout` for `-ch_layout` and `-sample_rate` for an input's `-ar`, stream specifiers such as `-ar:a`, format names in any letter case, and ffmpeg's number forms for `-ar` and `-ac`, such as `48k` and `0xBB80`. A value ffmpeg itself rejects, or silently ignores as nonsense, such as an output `-ac -1`, is an error. The [deviations](#deviations-from-ffmpeg) below are the only other departures from ffmpeg.

```sh
ffmpeg -i input.mp3 -f f32le -ar 48000 -ac 2 pipe:1 | loudness-tool lufs-norm -f f32le -ar 48000 -ac 2 pipe:0 -f f32le -ar 48000 -ac 2 -o pipe:1 | ffmpeg -f f32le -ar 48000 -ac 2 -i pipe:0 output.flac
loudness-tool tp-norm -f s24le -ar 48000 -ch_layout 5.1 surround.raw -o output.wav
loudness-tool stats -f f32le -ar 48000 -ac 2 - input.wav < stereo.raw
```

Each option applies to the input or `-o` output that follows it: options in front of an input path describe that input, and options in front of `-o` describe the output. Each `stats` input takes the options in front of it. A repeated option takes its last value, with a warning where ffmpeg warns of the repeat. Options after the last file are ignored with a warning.

`-f` takes `wav` and the raw formats `u8`, `s16le`, `s24le`, `s32le`, `f32le` and `f64le`: unsigned 8-bit, signed 16-, 24- and 32-bit, and 32- and 64-bit float samples, little-endian and interleaved. Raw output has no header and is written at the depth `-f` names.

A raw input is 44100 Hz with one channel unless `-ar` and `-ac` state otherwise. The options describe the stream as given, so a stream read with the wrong format, rate or channel count reads as noise, without an error.

`-ch_layout` takes a layout name such as `5.1` or `7.1.4`, channel names joined by `+` such as `FL+FR+LFE`, a channel mask such as `0x3f`, or a channel count such as `6C` or `6 channels`. It outranks `-ac` in either order. Channel positions come only from what the input and its options state, so a raw input without `-ch_layout`, or with a channel count, has none ([Channels](#channels)). On a WAV input, `-ch_layout` replaces the file's channel mask and must have the file's channel count, `-ar` is an error, and `-ac` is ignored.

`-sample_rate` takes one number in `-ar`'s forms, or `default` (44100), `min` (0) or `max` (2147483647), rounded to the nearest whole number with ties to even, so `48000.4` reads 48000 and `48001.5` reads 48002. `-ar` outranks it in either order. On an output it is ignored with a warning, as ffmpeg ignores it there.

An output keeps its input's sample rate and channels:

- `-ar` is accepted at the input's rate, and 0 keeps the input's.
- `-ac` is accepted at the input's channel count over an input with no channel positions, over the count's default layout (such as 5.1 for 6), or for a count with no default layout (such as 9), and 0 keeps the input's. A `-ch_layout` count such as `6C` reads as `-ac 6`.
- `-ch_layout` is accepted at the input's layout. Over an input with no channel positions and the same channel count, it relabels the output: the output carries that layout, and the measurement weighs the channels by it.

`-` and ffmpeg's pipe names both name a pipe. `pipe:` is stdin as an input and stdout as an output, and `pipe:<n>` is file descriptor `n`, such as `pipe:0` for stdin and `pipe:1` for stdout. Each descriptor is used in the direction it is named in. Audio written to `pipe:2` shares stderr with the warnings, errors and `target`'s attempt lines.

### Deviations from ffmpeg

1. **No resampling or remixing.** Every output `-ar`, `-ac` or `-ch_layout` that would make ffmpeg resample or rematrix is an error. loudness-tool measures and adjusts loudness at the input's rate and channels, and a remix would change the loudness it measured.
2. **No format guessing.** An input without `-f` is WAV, where ffmpeg probes its content. An output without `-f` is WAV, on a file of any extension and on a pipe such as `-o -`, where ffmpeg picks a format from the extension and fails on a pipe. A probe or an extension is a guess at what the bytes are.
3. **No layout guessing.** ffmpeg guesses a layout from a channel count alone, such as 5.1 for 6, on a raw `-ac`, on a WAV without a channel mask, through the `6c` form, and on an output `-ac` or count over an input with no layout. Those streams have no positions here, by the rule [above](#raw-pcm), and `6c` is an error. A guessed 5.1 would weigh two channels at 1.41 and drop one from loudness on the strength of a count. Where ffmpeg would rematrix from its guess to an output `-ch_layout`, loudness-tool relabels the output.
4. **Layouts a WAV channel mask cannot state.** Custom channel orders and repeated channels (`FR+FL`, `FL+FL`), channels outside the mask's 18 positions (`7.2.3`, `9.1.6`, `22.2`, `hexadecagonal`, `binaural`, `downmix`, ambisonic layouts, `USR18` and up, and mask bits from `0x40000` up), labelled channels such as `FL@main`, and `UNK` beside a named channel are errors. loudness-tool carries channel positions only as a WAV channel mask, which states each of 18 positions at most once, in a fixed order, and has no place for a label or for an unknown channel among named ones.
5. **A pipe is read once.** Two `stats` inputs on the same pipe are an error, where ffmpeg reads whatever is left of it for the second, which would measure the empty rest of the stream.
6. **A read error fails the run.** An error while reading the input's audio, such as on an input `pipe:1` open only for writing, exits 1 with the error, where ffmpeg logs it as a demuxing error and exits 0 with an empty output. A measurement over a failed read describes audio it never received.
7. **Formats.** Every format ffmpeg knows beyond those seven is an error, since loudness-tool reads and writes WAV and raw PCM only.
8. **No `-sample_rate` arithmetic.** An expression such as `2*24000` is an error, where ffmpeg reads 48000, since an expression language for a sample rate is beyond the tool.

A WAV or raw input below 5 Hz or above 768000 Hz fails with `Unsupported sample rate: <n>`. Below 5 Hz, BS.1770's 100 ms gating step rounds to no samples. 768000 Hz is the highest PCM rate in standard use, and above it a run's fixed cost outgrows its audio, since the 1.5 s of silence that closes the loudness range measurement and `crest`'s spreads are sized in samples, whatever the input's length.

## Temporary files

`--scratch-dir <path>` sets the directory that holds the copy of a piped or raw input and `target`'s working files (default: the system temporary directory). It goes before or after the command:

```sh
loudness-tool --scratch-dir /tmp/lt target input.wav -o output.wav --lufs -16
loudness-tool target - -o output.wav --tp -1 --scratch-dir /tmp/lt < input.wav
```

A run keeps its files there in subdirectories it makes and removes when it ends. A run also removes any subdirectory left there by a run that is no longer running. A file output is first written to a temporary file beside it, then renamed into place.

## Channels

Loudness weights each channel by its loudspeaker position, per ITU-R BS.1770-5. A WAV file states its positions in the channel mask of a WAVE_FORMAT_EXTENSIBLE header, and `-ch_layout` declares them ([Raw PCM](#raw-pcm)), which weigh as a mask's do. Positions to the side, from 60° to 120° off centre and below 30° elevation, weigh 1.41: the side channels, the back pair when the mask has no side channels, as in 5.1, and a back centre when it is the only surround, with no side channels or back pair. Every other position weighs 1.0. The LFE channel is left out of loudness and included in true peak.

A channel with no stated position weighs 1.0. That is every channel of a plain WAV header or of a mask of 0, every channel past the ones the mask names, and every channel on a mask bit that names no position. Mono and stereo measure the same without a mask as with front positions, as BS.1770 specifies; a mask that states other positions weighs those channels by position. A multichannel file with a plain header measures every channel at 1.0, LFE included, so a 5.1 file reads with its LFE counted and its surrounds under their standard weight; the same file with a channel mask gets the standard weighting.

## Output files

Mono and stereo WAV output without a channel mask is written with a plain WAV header. WAV output with more than two channels, or with a channel mask, is written as WAVE_FORMAT_EXTENSIBLE carrying the mask it was measured by: a relabel's, else the input's, or 0 when the input has none. WAV output larger than 4 GiB is written as RF64 (EBU Tech 3306). WAV output keeps the input's bit depth, except that 8-bit input is written as 16-bit and 64-bit float input as 32-bit float.

A source passed through to a WAV output keeps its own header and bit depth, the header of a piped or raw input being its temporary copy's WAVE_FORMAT_EXTENSIBLE one. When an input or output `-ch_layout` gives it a mask other than its header's, the passed-through samples get a new header carrying that mask. A source passed through to a raw output keeps its samples at the input's depth, and is converted to the depth `-f` names when that differs.

## License

MIT
