# Audio Mixer

Desktop Electron app for low-latency audio routing and monitoring with per-input mixing controls.

## Features

- Up to 3 input sources with independent controls per input:
	- Enable/disable input
	- Monitor 1 send volume + mute
	- Monitor 2 send volume + mute
	- Mixed output send volume + mute
	- Force mono
- 3 independent output buses:
	- Monitor Output
	- Monitor 2 Output
	- Mixed Output
- Master controls and live meters for each bus.
- EQ (low/mid/high), overload gain, and limiter stages.
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

## Troubleshooting

- If no output is heard, verify output bus selectors are not set to `(None)`.
- If an option is disabled, hover to see the reason (duplicate selection or cable-loop guard).
- If devices change while the app is running, routing auto-refreshes and may rebind.
- If packaged build behavior differs from dev, re-check `config.json` migration/version and rebuild.

