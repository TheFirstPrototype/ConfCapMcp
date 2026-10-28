# ConfCapMcp

A read-only [MCP](https://modelcontextprotocol.io) server for ConferenceCaptioning. It lets an AI assistant read your stream's live captions and translations, your saved transcripts and your audience questions, using a developer API key you create in the portal.

**Privacy:** everything a tool returns is sent to the AI model you connected. If you promised attendees that captions stay private, check that model provider's terms first.

## Setup

1. In the portal (<https://app.deafassistant.com>), open **Advanced Settings** and choose **Create Developer API Key**. Copy the key (it is shown once). It is read-only, and you can delete it any time.
2. Build: `npm install && npm run build`.
3. Add the server to your client. Claude Desktop (`claude_desktop_config.json`) or any stdio MCP client:

```json
{
  "mcpServers": {
    "confcap": {
      "command": "node",
      "args": ["/path/to/ConfCapMcp/dist/src/index.js"],
      "env": { "CONFCAP_KEY": "cck_...", "CONFCAP_STREAM": "yourstream" }
    }
  }
}
```

Claude Code: `claude mcp add confcap -e CONFCAP_KEY=cck_... -e CONFCAP_STREAM=yourstream -- node /path/to/ConfCapMcp/dist/src/index.js`

| Variable | Meaning |
| --- | --- |
| `CONFCAP_KEY` | Your developer API key. Needed for saved transcripts, questions and your secured streams. Not needed for public streams. |
| `CONFCAP_STREAM` | Default stream name. If unset and the key owns exactly one stream, that stream is used. |
| `CONFCAP_AUTH` | The secure code of a secured stream, to read its captions without being its owner. |
| `CONFCAP_API_URL` | Defaults to `https://api.deafassistant.com`. Must be https (or localhost). |

Keep the key out of source control. See the [Developer API docs](https://conferencecaptioning.com/developers/).

## Tools

| Tool | What it does | Needs a key |
| --- | --- | --- |
| `list_my_streams` | The streams the key can read | yes |
| `get_stream_status` | Live or not, languages, and whether it is readable (`ok`, `authRequired`, `expired`, `unknown`) | no |
| `get_live_captions` | Newest caption text, spoken language or a translation; a `cursor` for new text only | no (yes for your secured streams) |
| `get_stream_context` | Colour, logo and glossary terms | no |
| `list_saved_transcripts` | Saved transcripts with title, note, times and length | yes |
| `get_saved_transcript` | One transcript, paged | yes |
| `list_questions` | Audience questions, oldest first | yes |

Also: resources `confcap://stream/{name}/status` and `confcap://stream/{name}/transcript/{id}`, and prompts `meeting_minutes`, `triage_questions`, `catch_me_up`, `translate_summary`.

Good to know:
- Translations are a window of recent text that is re-translated as people speak. Saved transcripts are in the spoken language only; ask the assistant to translate them.
- Only some streams store history, and only sessions of 100 characters or more.
- Speech and questions come back wrapped in `<untrusted-text>`: other people wrote them, so a model should treat them as data, never as instructions.

## Safety properties (all tested)

- Only `GET` requests. The server has no code path that writes or deletes, and the key is read-only on the server as well.
- Credentials come only from the environment, never from tool arguments. They are redacted from errors and never logged.
- The account `uid` and the admin code are never used or sent.
- Calls to one stream are spaced at one per second and overall at five per second; `429` and `5xx` are retried with backoff.
- Two server instances never share cached text.

## Live smoke test

Runs the built server against the real API with a throwaway key (created and deleted by the script), calls every tool read-only, and checks that neither the key nor the account uid appears in any output.

```bash
npm run build
T_EMAIL='<portal login of an account that owns a stream>' T_PASS='<password>' npm run live-smoke
```
Optional: `SMOKE_STREAM` (default: the account's first stream), `API_BASE_URL`. Exit code 0 means it passed. Never commit the password. The related checks are `ConfCapApi/scripts/live_developer_keys_check.py` (API) and `ConfCapPortal/e2e` (portal UI).

## Development

`npm test` builds and runs the tests (a real local mock API, the protocol through the SDK's in-memory transport, and mutation-style checks described in `test/`). The server uses the v1.x SDK, which supports the 2025-11-25 MCP spec.
