# Hermes Windows Device Agent

Windows-local bridge for camera, microphone, speaker and approved local tools. It is intentionally a separate process from the UI: the desktop application requests capabilities, while this agent owns device permissions and connects to Hermes over an authenticated channel.

The first implementation target is a localhost-only IPC API. Remote device actions must be initiated by an approved Hermes provisioning policy, never by arbitrary chat text.
