# Deployment

## macOS launchd

1. Build the project:

```bash
npm run build
```

2. Copy and edit the example plist:

```bash
cp examples/launchd/com.example.pi-telegram-bridge.plist ~/Library/LaunchAgents/com.pi-telegram-bridge.plist
plutil -replace ProgramArguments.1 -string "$PWD/dist/index.js" ~/Library/LaunchAgents/com.pi-telegram-bridge.plist
plutil -replace WorkingDirectory -string "$PWD" ~/Library/LaunchAgents/com.pi-telegram-bridge.plist
```

3. Ensure `.env` exists in the project directory.

4. Load it:

```bash
launchctl load ~/Library/LaunchAgents/com.pi-telegram-bridge.plist
launchctl start com.pi-telegram-bridge
```

5. Logs:

```bash
tail -f /tmp/pi-telegram-bridge.out.log /tmp/pi-telegram-bridge.err.log
```

Unload:

```bash
launchctl unload ~/Library/LaunchAgents/com.pi-telegram-bridge.plist
```

## Linux systemd user service

1. Build the project:

```bash
npm run build
```

2. Copy and edit service:

```bash
mkdir -p ~/.config/systemd/user
cp examples/systemd/pi-telegram-bridge.service ~/.config/systemd/user/
$EDITOR ~/.config/systemd/user/pi-telegram-bridge.service
```

3. Enable:

```bash
systemctl --user daemon-reload
systemctl --user enable --now pi-telegram-bridge.service
```

4. Logs:

```bash
journalctl --user -u pi-telegram-bridge -f
```
