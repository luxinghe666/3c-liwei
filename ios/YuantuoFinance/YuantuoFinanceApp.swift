import SwiftUI

@main struct YuantuoFinanceApp: App {
    @UIApplicationDelegateAdaptor(FinanceAppDelegate.self) private var appDelegate
    @StateObject private var remote=RemoteNotices.shared
    @StateObject private var client = FinanceClient()
    @StateObject private var preferences=AppPreferences.shared
    @StateObject private var lock=AppLock()
    @AppStorage("privacySetupOffered") private var privacySetupOffered=false
    @Environment(\.scenePhase) private var scenePhase
    var body: some Scene {
        WindowGroup {
            Group {if lock.locked{AppLockView()}else{RootView()}}
                .environmentObject(client).environmentObject(lock)
                .preferredColorScheme(preferences.scheme)
                .tint(FinanceStyle.accent)
                .overlay {
                    if scenePhase != .active {
                        ZStack { Color(red: 0.06, green: 0.15, blue: 0.24).ignoresSafeArea(); Label("龍成ERP", systemImage: "lock.shield").font(.title).foregroundStyle(.white) }
                    }
                }
                .task {if !lock.locked{await client.resume()}}
                .task(id:scenePhase == .active && !lock.locked && client.user?.role=="owner"){
                    guard scenePhase == .active && !lock.locked && client.user?.role=="owner" else{return}
                    while !Task.isCancelled{await client.refreshNotices();do{try await Task.sleep(for:.seconds(20))}catch{break}}
                }
                .onChange(of:remote.token){_,_ in Task{await client.syncPushDevice()}}
                .onChange(of: scenePhase) { _, value in
                    if value == .background{lock.lock()}
                    if value == .active && !lock.locked{Task{await client.refresh()}}
                }
                .onChange(of:client.user?.id){_,id in
                    if id != nil && !privacySetupOffered {privacySetupOffered=true;Task{_ = await lock.authenticate(enabling:true);if client.user?.isStockRole != true {await FinanceNotifications.shared.request(workspace:client.workspace)};if client.user?.role=="owner"{await remote.register()}}}
                }
        }
    }
}
