import SwiftUI

@main struct YuantuoFinanceApp: App {
    @StateObject private var client = FinanceClient()
    @Environment(\.scenePhase) private var scenePhase
    var body: some Scene {
        WindowGroup {
            RootView().environmentObject(client)
                .tint(Color(red: 0.08, green: 0.38, blue: 0.70))
                .overlay {
                    if scenePhase != .active {
                        ZStack { Color(red: 0.06, green: 0.15, blue: 0.24).ignoresSafeArea(); Label("原拓财务", systemImage: "lock.shield").font(.title).foregroundStyle(.white) }
                    }
                }
                .task { await client.resume() }
                .onChange(of: scenePhase) { _, value in if value == .active { Task { await client.refresh() } } }
        }
    }
}
