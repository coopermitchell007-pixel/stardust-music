import SwiftUI
import WebKit

/// A WKWebView that loads YouTube Music, injects the Stardust theme, and applies
/// a declarative ad content-blocker (best-effort on iOS).
struct WebView: UIViewRepresentable {
    let url: URL

    func makeUIView(context: Context) -> WKWebView {
        let controller = WKUserContentController()

        // Inject theme.css at document end.
        if let cssURL = Bundle.main.url(forResource: "theme", withExtension: "css"),
           let css = try? String(contentsOf: cssURL, encoding: .utf8) {
            let js = """
            (function(){var s=document.createElement('style');s.id='stardust';\
            s.textContent=`\(css.replacingOccurrences(of: "`", with: "\\`"))`;\
            (document.head||document.documentElement).appendChild(s);})();
            """
            controller.addUserScript(WKUserScript(source: js,
                injectionTime: .atDocumentEnd, forMainFrameOnly: false))
        }

        let config = WKWebViewConfiguration()
        config.userContentController = controller
        config.allowsInlineMediaPlayback = true

        let webView = WKWebView(frame: .zero, configuration: config)
        webView.isOpaque = false
        webView.backgroundColor = .black
        webView.scrollView.backgroundColor = .black
        webView.customUserAgent =
            "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1"

        // Best-effort declarative ad blocking.
        if let rulesURL = Bundle.main.url(forResource: "blockrules", withExtension: "json"),
           let rules = try? String(contentsOf: rulesURL, encoding: .utf8) {
            WKContentRuleListStore.default()?.compileContentRuleList(
                forIdentifier: "stardust-ads", encodedContentRuleList: rules) { list, _ in
                if let list = list { controller.add(list) }
                webView.load(URLRequest(url: url))
            }
        } else {
            webView.load(URLRequest(url: url))
        }

        return webView
    }

    func updateUIView(_ webView: WKWebView, context: Context) {}
}
