# Stardust for iOS (WKWebView wrapper)

This is a **starter** iOS app that wraps `music.youtube.com` in a `WKWebView` and
injects a slim Stardust theme (dark space look, hidden upsells) plus a basic ad
content-blocker. It is **not** the Electron app — iOS can't run Electron — so it
re-implements only the web-injection part.

## Honest limitations (read first)
- **Ad-blocking is limited.** iOS `WKWebView` can't intercept requests like the
  desktop app; it uses `WKContentRuleList` (declarative rules), which is weaker.
  Server-stitched ads may still slip through.
- **App Store: unlikely.** Apple routinely rejects website wrappers (Guideline
  4.2) and wrapping YouTube Music adds trademark/ToS risk. Treat this as a
  **personal / sideload** app.
- **Sideloading** needs a Mac + Xcode + an Apple ID. On a free account the app
  must be re-signed every 7 days; a paid Developer account ($99/yr) lasts a year.
- The mobile YTM DOM differs from desktop, so the marketplace / visualizer /
  lyrics engine from the desktop app are **not** included here.

## Build it
1. Install **Xcode** (Mac App Store).
2. Create a new project → **App** → SwiftUI → name it `Stardust`.
3. Replace the generated `StardustApp.swift` and `ContentView.swift` with the
   files in `ios/Stardust/` here, and add `WebView.swift` + `theme.css`.
4. Add `theme.css` and `blockrules.json` to the target (drag into Xcode, tick
   "Copy items" + your app target).
5. Select your iPhone (or a simulator) and press **Run** (⌘R). For a real device,
   set your Team under Signing & Capabilities.

That's it — it loads YouTube Music with the Stardust theme injected.
