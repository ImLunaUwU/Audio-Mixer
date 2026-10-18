# Audio Mixer

Desktop Electron app for low-latency audio routing and monitoring with per-input mixing controls.

## Features

- Up to 3 input sources with independent controls per input:
	- Enable/disable input
	- Monitor 1 send volume + mute
	- Monitor 2 send volume + mute
	- Mixed output send volume + mute
	- Force mono
- Per-application audio capture: pick a running app (e.g. Spotify, a browser, a game) as an input source and capture only that app's audio.
- 3 independent output buses:
	- Monitor Output
	- Monitor 2 Output
	- Mixed Output
- Master controls and live meters for each bus.
- EQ (low/mid/high) and overload gain on every output bus.
- Soft clipping (Advanced settings): peaks are smoothly saturated (tanh knee, 4x oversampled) instead of hard-cut at 0 dBFS, with an adjustable knee threshold (default -6 dBFS).
- Presets for full routing snapshots and custom EQ presets.
- Device safety options:
	- Prevent duplicate device selection in input/output groups
	- Cable loop protection (Input/Output cable pair guard)
	- Optional bypass toggle in Advanced settings
- Tray behavior (close to tray), start-on-boot option, compact mode.

## Tech Stack

- Electron
- Vanilla HTML/CSS/JavaScript (no frontend framework)

## Requirements

- Windows audio devices with `setSinkId` support for output device assignment
- Windows 10 2004+ x64 for per-application capture

## Per-Application Audio Capture

Each Input Source dropdown has an **Applications** group listing running apps with a visible window (shown as `App: <exe name>`; hover for the window title). Selecting one captures only that process (and its child processes) into the mixer. It gets the same per-input controls, presets and device-state memory as a hardware input.

- Click **Refresh Applications** (under the routing selectors) to rescan after starting a new app.
- If a captured app is restarted, it is re-bound by its exe name on refresh. If it closed, the input clears.
- How it works: Windows WASAPI *process loopback* (`AUDIOCLIENT_ACTIVATION_TYPE_PROCESS_LOOPBACK`) through the [`application-loopback`](https://github.com/WerdoxDev/application-loopback) package's native helper executables. The main process streams raw PCM (16-bit, stereo, 48 kHz) to the renderer, where an AudioWorklet feeds it into the audio graph. The worklet keeps about 120 ms of buffer at most.
- Requirements: Windows 10 version 2004 (build 19041) or newer, x64. On other platforms the Applications group just stays empty.
- Limitations: only apps with a visible top-level window are listed. Apps that play audio from a separate windowless process are captured through the process tree, but you may need to pick the parent app. Capturing an app does not mute it on its normal output device.

## Routing Model

Each input is split into three send paths:

- Monitor 1 chain
- Monitor 2 chain
- Mixed Output chain

Each chain has its own master gain and meter. Monitor chains are independent.

## Advanced Settings

- Start app on system boot
- Show multichannel devices
- Enforce routing safety restrictions (duplicate/cable-loop guard)
- EQ preset management + EQ controls
- Overload gain
- Soft clipping toggle + knee threshold

Bus chain (identical for device and application inputs): `input -> per-input send gain -> EQ low/mid/high -> overload -> master -> soft clip -> output + meter`.

## Troubleshooting

- If no output is heard, verify output bus selectors are not set to `(None)`.
- If an option is disabled, hover to see the reason (duplicate selection or cable-loop guard).
- If devices change while the app is running, routing auto-refreshes and may rebind.
- If packaged build behavior differs from dev, re-check `config.json` migration/version and rebuild.

