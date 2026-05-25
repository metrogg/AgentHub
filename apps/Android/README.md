# AgentHub Android

AgentHub Android is the lightweight mobile client for AgentHub. The first milestone is an IM-style companion app:

- connect to a desktop/web AgentHub instance
- browse sessions
- open a conversation
- send commands/messages to the desktop runtime
- receive streaming agent output over WebSocket

The mobile app does not run code agents locally. Code execution, workspace access, model keys, and sandboxing stay on the desktop/server side.

## Current Status

This folder contains the first Android skeleton:

- Kotlin + Jetpack Compose app shell
- connection screen with manual server URL entry
- session list and chat thread shell
- REST client for sessions/messages
- WebSocket client for `session:join`, `message:stream`, `message:completed`, and typing events
- technical route document in [docs/mobile-technical-route.md](docs/mobile-technical-route.md)

QR pairing, device tokens, push notifications, and artifact preview are planned next steps.

## Open In Android Studio

1. Open `apps/Android` as a standalone Android project.
2. Let Android Studio sync Gradle dependencies.
3. Use JDK 17 or newer.
4. Run the `app` configuration on an emulator or device.

Default connection target for Android emulator:

```text
http://10.0.2.2:8000
```

For a physical phone, use the computer LAN IP, for example:

```text
http://192.168.1.20:8000
```

The existing server must be running:

```bash
bun run dev:server
```

## Notes

The local machine used to generate this skeleton does not currently have Gradle installed and has Java 8 on PATH, so build verification should be done in Android Studio with JDK 17+.
