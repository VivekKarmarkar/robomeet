# GWS authorization investigation

The existing GWS login works. `gws auth status` reports valid encrypted OAuth credentials with a refresh token, and `gws gmail users getProfile` identifies `vivekkmk.assistant@gmail.com`.

The existing grant lacks Meet permissions: reading the assistant-owned test meeting through `gws meet spaces get` returned HTTP 403, “Request had insufficient authentication scopes.” This is not a password error.

## Prepared test

A separate GWS configuration was created at `data/gws-meet-auth`, preserving the existing working GWS configuration. Only the existing OAuth client configuration was copied into the private directory; the old user's tokens were not exported or copied.

The separate login requests `meetings.space.created` plus OpenID/basic account identity. In the already signed-in Chrome browser, the assistant account was selected without a password prompt. Google identifies the app as **OpenClaw Agent**, developer `vivekkmk.assistant@gmail.com`, with a localhost callback.

The remaining OAuth UI step displays Google's “unverified app” warning. Automatic approval review rejected clicking Continue twice: first because the user had not specifically approved proceeding past that warning, then again after the app owner and local destination were verified. A specific approval request is pending. Do not retry that click or use an indirect workaround without the requested approval.

After approval and successful OAuth completion, the documented test command is:

```sh
GOOGLE_WORKSPACE_CLI_CONFIG_DIR="$PWD/data/gws-meet-auth" \
  gws meet spaces create --json '{"config":{"accessType":"OPEN","entryPointAccess":"ALL"}}'
```

Run it from the RoboMeet directory. Inspect the actual API response, use its meeting URL in the signed-in host browser, then test the actual robot with voice off. No such API-created meeting has been created in this investigation yet. A successful room creation would not prove robot admission or media exchange.

## What the documentation establishes

- Meet REST OAuth supports meeting setup and metadata; the creation scope is `meetings.space.created`. [Google authorization](https://developers.google.com/workspace/meet/api/guides/authenticate-authorize), [spaces.create](https://developers.google.com/workspace/meet/api/reference/rest/v2/spaces/create)
- `OPEN` controls admission without knocking and `ALL` allows normal meeting entry points. Those fields do not themselves establish successful anonymous admission for this account. [SpaceConfig](https://developers.google.com/workspace/meet/api/reference/rest/v2/spaces)
- The documented Meet Media API receives media; its WebRTC requirements specify receive-only transceivers. It does not document outgoing robot speech/camera/presentation. It also has Developer Preview requirements. [WebRTC requirements](https://developers.google.com/workspace/meet/media-api/guides/concepts), [requirements](https://developers.google.com/workspace/meet/media-api/guides/get-started)
- No supported GWS refresh-token-to-Google-browser-login flow was found in the reviewed documentation. Existing browser authentication and API authorization remain distinct in the investigated implementations. [GWS authentication](https://github.com/googleworkspace/cli#authentication)

No paid voice calls were made during this investigation. The requested working meeting robot remains incomplete.

## Update — 2026-09-13 01:39 CDT

Vivek explicitly approved Continue. Codex first saved the requested handoff files, then completed the approved warning/consent flow. GWS returned authentication success for the assistant account and saved separate encrypted credentials at `data/gws-meet-auth/credentials.enc`.

The real `spaces.create` command succeeded, returning `https://meet.google.com/onh-rhid-zuu` (`spaces/mJrUzJy2S2QB`) with OPEN access, ALL entry points, moderation OFF, and all automatic recording/transcription/notes OFF. This resolves the OAuth approval and API creation steps above. Actual robot admission to this new space is the next unverified step.

## Update — 2026-09-13 01:42 CDT

The real robot was then tested with the assistant host present in this API-created room. Host UI explicitly confirmed open access. Google again rejected the robot with “You can't join this video call.” The media bridge connected locally before rejection; meeting admission stayed false. Evidence is `../../work/robomeet-test/gws-meet-admission-result.json`. GWS authorization and creation are working, but this experiment did not resolve robot admission. The host and rejected worker closed; no paid voice call ran.
