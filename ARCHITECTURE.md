# How codex-audio works

`codex-audio` changes speech into text. It uses the ChatGPT credentials that
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

This is the path the CLI uses. The diagram shows one run from start to end.
A run takes one of three routes. The third route does the transcription.

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
    participant AUTH as codex/auth.ts
    participant DISK as auth.json
    participant OAUTH as auth.openai.com
    participant API as chatgpt.com backend

    User->>CLI: codex-audio [file]
    CLI->>CLI: parseArgs(argv)

    alt Route 1 of 3: the user gives --list-devices
        CLI->>Dev: listDevices()
        Dev->>FF: enumerate the input devices
        FF-->>Dev: the device list
        CLI-->>User: print the list, exit 0

    else Route 2 of 3: the user gives --stream
        CLI-->>User: refuse the option, exit 2

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

Each module does one job. The realtime module is legacy code.

```mermaid
flowchart TD
    CLI["cli.ts<br/>arguments, renderer, exit codes"]
    CAP["audio/capture.ts<br/>microphone and file sources"]
    PROC["audio/processing.ts<br/>ffmpeg, WAV, RTP"]
    DEV["audio/devices.ts<br/>device names, listing"]
    TX["codex/transcribe.ts<br/>multipart upload"]
    AUTH["codex/auth.ts<br/>tokens, refresh, headers"]
    RT["codex/realtime.ts<br/>legacy WebRTC client"]
    LIVE(["POST /backend-api/transcribe<br/>this route works"])
    DEAD(["POST /backend-api/codex/realtime/calls<br/>this route returns 404"])

    CLI -->|records the audio| CAP
    CLI -->|lists the devices| DEV
    CAP -->|names the device| DEV
    CAP -->|encodes the audio| PROC
    CLI -->|sends the audio| TX
    TX -->|gets the headers| AUTH
    TX --> LIVE
    RT -->|gets the headers| AUTH
    RT -.->|needs an RTP track| CAP
    RT --> DEAD

    classDef legacy stroke-dasharray: 5 5
    class RT,DEAD legacy
```

## Points to remember

- `cli.ts` never sends audio. `codex/transcribe.ts` sends it.
- `cli.ts` imports through `audio/index.ts` and `codex/index.ts`. Each
  folder gives one surface; the files behind it can move.
- `codex/auth.ts` refreshes the token 60 seconds before it expires. This
  prevents a failure in the middle of a session.
- ffmpeg does all the audio work: capture, WAV, Opus and the device listing.
  Nothing else touches the sound hardware.
- The microphone in the Codex Desktop composer uses the upload route. It does
  not use WebRTC.
- The realtime route returns 404. Keep `codex/realtime.ts` as a record of the
  older protocol.
