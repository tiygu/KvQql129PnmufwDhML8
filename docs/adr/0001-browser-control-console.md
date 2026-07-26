# Replace the Electron application with a browser control console

The project will use a Node-hosted React control console over local REST and WebSocket interfaces instead of an Electron shell. This keeps the automation runtime independent from page lifetime, supports multiple control pages sharing one automation session, reuses either a managed or externally started WMPF/CDP connection route, and removes the installer/runtime weight of Electron; the default listener remains local-only at `127.0.0.1:8787`.
