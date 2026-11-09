# How open-transcribe works

`open-transcribe` changes speech into text. It uses the ChatGPT credentials that
`codex login` writes to disk. It does not need an OpenAI API key.

## How to read the diagrams

The sequence diagram uses three labels from the sequence-diagram standard.
The text in brackets after each label gives the condition.

| Label | Meaning |
|---|---|
| `alt` and `else` | Alternative routes. Only one route runs. |
| `opt` | An optional step. It runs only if the condition is true. |
| The numbers | The order of the steps. |

## The upload path

The diagram shows one run of the CLI from start to end.
A run takes one of three routes. Routes 2 and 3 do the transcription.

```mermaid
sequenceDiagram
    autonumber
    actor User
    participant CLI as cli.ts
    participant Cap as audio/capture.ts
    participant Proc as audio/processing.ts
    participant Dev as audio/devices.ts
    participant FF as ffmpeg
    participant TX as codex/transcribe.ts
    participant RT as codex/realtime.ts
    participant AUTH as codex/auth.ts
    participant DISK as auth.json
    participant OAUTH as auth.openai.com
    participant API as chatgpt.com backend

    User->>CLI: open-transcribe [file]
    CLI->>CLI: parseArgs(argv)

    alt Route 1 of 3: the user gives --list-devices
        CLI->>Dev: listDevices()
        Dev->>FF: enumerate the input devices
        FF-->>Dev: the device list
        CLI-->>User: print the list, exit 0

    else Route 2 of 3: the user gives --stream
        CLI->>RT: connect() sends the SDP offer to the realtime route
        RT-->>CLI: the data channel is open
        CLI->>Cap: play() starts ffmpeg only now
        Cap->>RT: Opus audio over RTP
        RT-->>User: one transcript each time the speaker pauses
        CLI->>RT: finish() commits only if VAD still hears speech
        CLI-->>User: the full text on stdout

    else Route 3 of 3: transcribe the audio
        alt the user gives no file, so record
            CLI->>Cap: recordMicrophone(device)
            Cap->>Dev: micInputArgs(device)
            Cap->>FF: capture PCM, 24 kHz, mono
            User->>Cap: press Enter
            Cap->>FF: stop the capture
            FF-->>Cap: raw PCM bytes
            Cap->>Proc: wavFromPcm() adds the WAV header
            Proc-->>Cap: WAV bytes
            Cap-->>CLI: WAV bytes
            CLI->>TX: transcribeAudio(bytes)
        else the user gives a file, so read it
            CLI->>TX: transcribeFile(path)
            TX->>TX: read the file, contentTypeFor(path)
        end

        TX->>AUTH: ChatGPTAuth.load()
        AUTH->>DISK: read the tokens
        DISK-->>AUTH: access, refresh and account values
        TX->>AUTH: ensureFresh()

        opt the token expires in less than 60 s
            AUTH->>OAUTH: POST /oauth/token with the refresh token
            OAUTH-->>AUTH: a new access token
            AUTH->>DISK: save() writes the new token
        end

        AUTH-->>TX: transcriptionHeaders()
        TX->>API: POST /transcribe, multipart file and language
        API-->>TX: JSON with a text field
        TX-->>CLI: the transcript
        CLI-->>User: text on stdout, or JSON
    end
```

## Module map

Each module does one job.

```mermaid
flowchart TD
    CLI["cli.ts<br/>arguments, renderer, exit codes"]
    CAP["audio/capture.ts<br/>microphone and file sources"]
    PROC["audio/processing.ts<br/>ffmpeg, WAV, RTP"]
    DEV["audio/devices.ts<br/>device names, listing"]
    TX["codex/transcribe.ts<br/>multipart upload"]
    AUTH["codex/auth.ts<br/>tokens, refresh, headers"]
    RT["codex/realtime.ts<br/>WebRTC client for --stream"]
    LIVE(["POST /backend-api/transcribe<br/>this route works"])
    RTAPI(["POST /backend-api/codex/realtime/calls<br/>the --stream route"])

    CLI -->|records the audio| CAP
    CLI -->|lists the devices| DEV
    CAP -->|names the device| DEV
    CAP -->|encodes the audio| PROC
    CLI -->|sends the audio| TX
    CLI -->|streams the audio| RT
    TX -->|gets the headers| AUTH
    TX --> LIVE
    RT -->|gets the headers| AUTH
    RT -->|needs an RTP track| CAP
    RT --> RTAPI
```

## Points to remember

- `cli.ts` never sends audio. `codex/transcribe.ts` or `codex/realtime.ts`
  sends it.
- `cli.ts` imports through `audio/index.ts` and `codex/index.ts`. Each
  folder gives one surface; the files behind it can move.
- `codex/auth.ts` refreshes the token 60 seconds before it expires. This
  prevents a failure in the middle of a session.
- The desktop shortcut uses `desktop/recording.ts` to open a microphone for each
  press. On 64-bit Windows, `desktop/microphone.ts` uses WinMM to capture
  24 kHz mono PCM directly, without starting ffmpeg or a DirectShow graph.
  Recording starts only after the first audio buffer arrives. Releasing the
  shortcut returns the final partial buffer and closes the device.
  If the input buffers fill before they can be drained, the recording is
  rejected instead of uploading audio with gaps.
- Native capture requires a unique, exact device-name match. Truncated names,
  ambiguous names, and devices that fail native initialization use ffmpeg.
  The command line capture paths and device listing also use ffmpeg.
- The microphone in the Codex Desktop composer uses the upload route. It does
  not use WebRTC.
- The realtime route returned 404 for a period. It worked again on
  2026-10-31.
- In `--stream`, start ffmpeg only after the data channel opens. Audio sent
  before that is lost.
- Do not commit a buffer of silence. The model then invents text, for
  example "Lütfen gel."
