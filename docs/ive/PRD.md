# Moved

The desktop-app PRD now lives in its own repository:

- **Repo:** `~/Development/endurance` (product name **Endurance**, an Integrated Vibing Environment)
- **PRD:** `~/Development/endurance/docs/PRD.md`
- **ADRs:** `~/Development/endurance/docs/adr/`
- **Obsidian mirror:** `Projects/CloudCLI/Endurance/PRD.md`

The server prerequisite work the PRD calls Epic E1 (schema export, protocol v2 envelope, send acks, device pairing, header WebSocket auth, loopback bind and CORS allowlist, durable replay, schema versioning, bootstrap channel, packaging, Mission Control → bots migration, Integration Center retirement) is implemented in **this** repo until the server is extracted. See PRD §8.5.
