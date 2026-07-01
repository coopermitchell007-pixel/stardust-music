import SwiftUI

@main
struct StardustApp: App {
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
