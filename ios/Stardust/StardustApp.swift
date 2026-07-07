import SwiftUI
import AVFoundation

@main
struct StardustApp: App {
    init() {
        // A music app that goes silent when the phone locks is broken — claim
        // the playback audio session so YTM keeps playing in the background.
        try? AVAudioSession.sharedInstance().setCategory(.playback, mode: .default)
        try? AVAudioSession.sharedInstance().setActive(true)
    }
    var body: some Scene {
        WindowGroup {
            ContentView()
                .ignoresSafeArea()
                .preferredColorScheme(.dark)
        }
    }
}

struct ContentView: View {
    var body: some View {
        WebView(url: URL(string: "https://music.youtube.com")!)
            .background(Color.black)
    }
}
