import SwiftUI
import WebKit

/// A WKWebView that loads YouTube Music, injects the Stardust theme, and applies
/// a declarative ad content-blocker (best-effort on iOS).
struct WebView: UIViewRepresentable {
    let url: URL

    func makeCoordinator() -> Coordinator { Coordinator() }

    func makeUIView(context: Context) -> WKWebView {
        let controller = WKUserContentController()

        // Inject theme.css — and KEEP it applied. Mobile YTM is a SPA that
        // rebuilds its DOM; a one-shot <style> tag can get dropped, which
        // showed as "default YTM". A tiny observer re-attaches it.
        if let cssURL = Bundle.main.url(forResource: "theme", withExtension: "css"),
           let css = try? String(contentsOf: cssURL, encoding: .utf8) {
            print("[stardust] theme.css loaded: \(css.count) chars")
            let escaped = css
                .replacingOccurrences(of: "\\", with: "\\\\")
                .replacingOccurrences(of: "`", with: "\\`")
                .replacingOccurrences(of: "$", with: "\\$")
            let js = """
            (function(){
              function apply(){
                if (document.getElementById('stardust')) return;
                var s = document.createElement('style');
                s.id = 'stardust';
                s.textContent = `\(escaped)`;
                (document.head || document.documentElement).appendChild(s);
              }
              apply();
              new MutationObserver(apply).observe(document.documentElement, { childList: true, subtree: false });
              document.addEventListener('DOMContentLoaded', apply);
              setInterval(apply, 3000);
            })();
            """
            controller.addUserScript(WKUserScript(source: js,
                injectionTime: .atDocumentStart, forMainFrameOnly: true))
        }

        let config = WKWebViewConfiguration()
        config.userContentController = controller
        config.allowsInlineMediaPlayback = true
        config.mediaTypesRequiringUserActionForPlayback = []

        let webView = WKWebView(frame: .zero, configuration: config)
        webView.navigationDelegate = context.coordinator
        webView.isOpaque = false
        webView.backgroundColor = .black
        webView.scrollView.backgroundColor = .black
        if #available(iOS 16.4, *) { webView.isInspectable = true }
        webView.customUserAgent =
            "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1"

        // Load FIRST — the page must never wait on the rule compiler (the old
        // code loaded inside its callback; when compilation stalled, the
        // screen stayed black). Rules attach whenever they're ready.
        webView.load(URLRequest(url: url))
        if let rulesURL = Bundle.main.url(forResource: "blockrules", withExtension: "json"),
           let rules = try? String(contentsOf: rulesURL, encoding: .utf8) {
            WKContentRuleListStore.default()?.compileContentRuleList(
                forIdentifier: "stardust-ads", encodedContentRuleList: rules) { list, err in
                if let err = err { print("[stardust] rule compile failed: \(err)") }
                if let list = list { controller.add(list); print("[stardust] ad rules attached") }
            }
        }

        return webView
    }

    func updateUIView(_ webView: WKWebView, context: Context) {}

    /// Prints every navigation step so `devicectl … launch --console` shows
    /// exactly where a blank screen comes from; also revives a dead renderer.
    final class Coordinator: NSObject, WKNavigationDelegate {
        func webView(_ w: WKWebView, didStartProvisionalNavigation n: WKNavigation!) {
            print("[stardust] start: \(w.url?.absoluteString ?? "?")")
        }
        func webView(_ w: WKWebView, didFinish n: WKNavigation!) {
            print("[stardust] finish: \(w.url?.absoluteString ?? "?")")
            w.evaluateJavaScript("JSON.stringify({injected: !!document.getElementById('stardust'), bodyBg: getComputedStyle(document.body).backgroundColor, app: !!document.querySelector('ytmusic-app')})") { r, e in
                print("[stardust] probe: \(r ?? e?.localizedDescription ?? "nil")")
            }
        }
        func webView(_ w: WKWebView, didFailProvisionalNavigation n: WKNavigation!, withError e: Error) {
            print("[stardust] FAIL(provisional): \(e.localizedDescription) — \(w.url?.absoluteString ?? "?")")
        }
        func webView(_ w: WKWebView, didFail n: WKNavigation!, withError e: Error) {
            print("[stardust] FAIL: \(e.localizedDescription)")
        }
        func webViewWebContentProcessDidTerminate(_ w: WKWebView) {
            print("[stardust] web content process terminated — reloading")
            w.reload()
        }
    }
}
