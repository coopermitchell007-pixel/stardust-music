# YTM+ ✦

**Spicetify-style theming for YouTube Music** — a desktop app that wraps
[music.youtube.com](https://music.youtube.com) and lets you drop in customizable
**space themes** with animated starfields, a music-reactive visualizer,
glassmorphism, a live accent picker, Discord Rich Presence, global media
hotkeys, and a mini player.

![themes: Nebula · Galaxy · Event Horizon · Aurora](#)

## Features

- **Built-in space themes** — Nebula Drift, Spiral Galaxy, Event Horizon (black hole), Aurora Veil.
- **Full theme SDK** — drop your own theme folders into the themes directory; they load live, no restart, exactly like Spicetify.
- **Animated starfield** — parallax stars, twinkle, and shooting stars, all configurable per theme.
- **Visualizer** — playback-reactive bars in your accent color (see note below).
- **Live customizer** — accent color picker, star density, glass blur, and toggles for every effect, in an in-app panel.
- **Glassmorphism** — frosted nav and player bars.
- **Discord Rich Presence** — show what you're listening to (optional).
- **Global hotkeys** — system-wide play/pause/next/previous + media keys.
- **Mini player** — frameless, always-on-top compact player.

## Run it

```bash
npm install      # installs Electron (+ optional discord-rpc)
npm start
```

The floating **✦** button (bottom-right) opens the control panel.

## Building installers

YTM+ packages for **Windows**, **macOS**, and **Linux** via
[electron-builder](https://www.electron.build/).

```bash
npm install
npm run dist:win     # Windows  → dist/*.exe  (NSIS installer + portable)
npm run dist:mac     # macOS    → dist/*.dmg, dist/*.zip
npm run dist:linux   # Linux    → dist/*.AppImage
npm run dist         # current platform's default targets
```

> **Cross-building note:** build Windows artifacts on Windows and macOS
> artifacts on macOS. The included **GitHub Actions** workflow
> (`.github/workflows/build.yml`) does this automatically — push a tag like
> `v0.1.0` to produce a GitHub Release with the Windows `.exe` and macOS `.dmg`
> attached, or run it manually from the **Actions** tab to get artifacts.

### Windows

The app is fully cross-platform — the same Electron/preload/theme code runs on
Windows. The NSIS installer creates Start-menu and desktop shortcuts named
**YTM+**, global **media-key** hotkeys work system-wide, and the Windows icon is
generated automatically from `build/icon.png`.

## Creating a theme

A theme is a folder containing `theme.json` and `theme.css`. Put it in the
user themes folder (Panel → **Open themes folder**) and hit **Reload**.

```json
{
  "id": "my-theme",
  "name": "My Theme",
  "author": "you",
  "accent": "#ff5ca8",
  "background": "linear-gradient(180deg, #1a0820, #05060f)",
  "glass": { "blur": 20, "opacity": 0.5 },
  "starfield": { "enabled": true, "count": 240, "color": "#ffd6f0", "speed": 0.25, "size": 1.6, "twinkle": true, "shootingStars": true },
  "visualizer": { "enabled": true, "color": "#ff5ca8", "style": "bars" }
}
```

`theme.css` is injected on top of the base layer — target any YouTube Music
element and use `var(--ytmplus-accent)` for the active accent color.

## Notes & limitations

- **Visualizer is simulated, not sampled.** YouTube Music streams audio from a
  cross-origin host, so the Web Audio `AnalyserNode` can't legally read the
  samples (and tapping the element risks muting playback). The visualizer is a
  smooth, beat-feel animation driven by real playback state instead.
- **Discord Rich Presence** needs the optional `discord-rpc` package (installed
  automatically) and a Discord application **Client ID** — create one at
  <https://discord.com/developers/applications> and paste it into the panel.
- This is an unofficial client and is not affiliated with YouTube or Google.

## How it works

| Piece | File |
|-------|------|
| Electron main / windows / IPC / hotkeys | `src/main.js` |
| Page injection (panel, starfield, visualizer, scraping) | `src/preload.js` |
| Base CSS (YTM transparency, glass, accent, panel) | `src/overlay/overlay.css` |
| Theme discovery (built-in + user) | `src/themes.js` |
| Settings persistence | `src/config.js` |
| Discord Rich Presence (guarded) | `src/discord.js` |
| Mini player window | `src/miniplayer/` |
| Built-in themes | `src/themes/<id>/` |
