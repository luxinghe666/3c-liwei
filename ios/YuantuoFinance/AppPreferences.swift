import SwiftUI
import LocalAuthentication
import UserNotifications

final class AppPreferences: ObservableObject {
    static let shared = AppPreferences()
    @Published var appearance: String { didSet { save("appearance",appearance) } }
    @Published var accentColor: String { didSet { save("accentColor",accentColor) } }
    @Published var hideSensitiveAmounts: Bool { didSet { save("hideSensitiveAmounts",hideSensitiveAmounts) } }
    @Published var faceIdEnabled: Bool { didSet { save("faceIdEnabled",faceIdEnabled) } }
    @Published var dailyReportNotification: Bool { didSet { save("dailyReportNotification",dailyReportNotification) } }
    @Published var overdueNotification: Bool { didSet { save("overdueNotification",overdueNotification) } }
    @Published var dailyHour: Int { didSet { save("dailyHour",dailyHour) } }
    @Published var homeWidgets: [String] { didSet { save("homeWidgets",homeWidgets) } }
    private func save(_ key:String,_ value:Any){UserDefaults.standard.set(value,forKey:key)}
    init(){
        let d=UserDefaults.standard
        d.register(defaults:["appearance":"system","accentColor":"blue","hideSensitiveAmounts":true,"faceIdEnabled":false,"dailyReportNotification":true,"overdueNotification":true,"dailyHour":20,"homeWidgets":["balance","receivable","payable","profit"]])
        // The archived red/gold theme is inactive. Preserve existing blue/teal choices.
        if d.string(forKey:"accentColor") == "brand" { d.set("blue",forKey:"accentColor") }
        appearance=d.string(forKey:"appearance") ?? "system";accentColor=d.string(forKey:"accentColor") ?? "blue"
        hideSensitiveAmounts=d.bool(forKey:"hideSensitiveAmounts");faceIdEnabled=d.bool(forKey:"faceIdEnabled")
        dailyReportNotification=d.bool(forKey:"dailyReportNotification");overdueNotification=d.bool(forKey:"overdueNotification");dailyHour=d.integer(forKey:"dailyHour")
        homeWidgets=d.stringArray(forKey:"homeWidgets") ?? ["balance","receivable","payable","profit"]
    }
    var scheme:ColorScheme? {appearance=="dark" ? .dark : appearance=="light" ? .light : nil}
}

@MainActor final class AppLock:ObservableObject {
    @Published var locked = AppPreferences.shared.faceIdEnabled
    @Published var authenticating=false
    @Published var error:String?
    private var context:LAContext?
    func lock(){if AppPreferences.shared.faceIdEnabled {locked=true}}
    func authenticate(enabling:Bool=false) async -> Bool {
        guard !authenticating else{return false};authenticating=true;defer{authenticating=false;context=nil}
        let c=LAContext();context=c;c.localizedCancelTitle="取消";c.localizedFallbackTitle=""
        var reason:NSError?
        guard c.canEvaluatePolicy(.deviceOwnerAuthenticationWithBiometrics,error:&reason) else {error="此设备尚未设置或暂时无法使用 Face ID / Touch ID。请在系统设置中完成设置，也可使用公司账号登录。";return false}
        do{let ok=try await c.evaluatePolicy(.deviceOwnerAuthenticationWithBiometrics,localizedReason:enabling ? "开启龍成ERP生物识别解锁" : "解锁龍成ERP，查看公司账本")
            if ok {if enabling{AppPreferences.shared.faceIdEnabled=true};locked=false;error=nil};return ok
        }catch{self.error="未完成生物识别验证，请重试或使用公司账号重新登录。";return false}
    }
    func disable() async {if await authenticate(){AppPreferences.shared.faceIdEnabled=false}}
    func useAccountLogin(){locked=false;error=nil}
}
struct AppLockView:View {
    @EnvironmentObject var lock:AppLock
    @EnvironmentObject var client:FinanceClient
    var body:some View {
        VStack(spacing:24){Image(systemName:"lock.shield").font(.system(size:56)).foregroundStyle(FinanceStyle.accent);Text("龍成ERP已锁定").font(.title2.bold());Text("验证身份后查看公司账本").foregroundStyle(.secondary)
            Button("使用 Face ID / Touch ID 解锁"){Task{if await lock.authenticate(){await client.resume()}}}.buttonStyle(.borderedProminent).disabled(lock.authenticating)
            Button("使用公司账号重新登录"){client.forgetLocalSession();lock.useAccountLogin()}.disabled(lock.authenticating)
            if let error=lock.error{Text(error).font(.footnote).foregroundStyle(.secondary)}
        }.padding(32).frame(maxWidth:.infinity,maxHeight:.infinity).background(.background)
    }
}

@MainActor final class FinanceNotifications:ObservableObject {
    static let shared=FinanceNotifications()
    @Published var status="尚未授权"
    private let center=UNUserNotificationCenter.current()
    private var updateGeneration=0
    func request(workspace:Workspace?) async {
        let generation=updateGeneration
        do{let allowed=try await center.requestAuthorization(options:[.alert,.sound,.badge]);status=allowed ? "已获系统授权":"系统未允许通知";if generation==updateGeneration{await schedule(workspace)}}catch{status="无法启用通知，请检查系统设置"}
    }
    func clear(){updateGeneration+=1;center.removeAllPendingNotificationRequests();center.removeAllDeliveredNotifications()}
    func schedule(_ workspace:Workspace?) async {
        updateGeneration+=1;let generation=updateGeneration
        let settings=await center.notificationSettings()
        guard generation==updateGeneration else{return}
        let allowed=settings.authorizationStatus == .authorized || settings.authorizationStatus == .provisional
        status=allowed ? "已获系统授权" : "尚未获系统授权"
        center.removeAllPendingNotificationRequests()
        guard allowed,let workspace else{return}
        let p=AppPreferences.shared
        if p.dailyReportNotification {
            let content=UNMutableNotificationContent();content.title="龍成ERP · 每日经营日报";content.body="今日经营数据待查看，打开 App 刷新日报。";content.sound = .default
            var parts=DateComponents();parts.calendar=Calendar(identifier:.gregorian);parts.timeZone=TimeZone(identifier:"Asia/Shanghai");parts.hour=p.dailyHour;parts.minute=0
            let identifier="daily-report-\(generation)"
            try? await center.add(UNNotificationRequest(identifier:identifier,content:content,trigger:UNCalendarNotificationTrigger(dateMatching:parts,repeats:true)))
            if generation != updateGeneration{center.removePendingNotificationRequests(withIdentifiers:[identifier]);return}
        }
        guard generation==updateGeneration else{return}
        if p.overdueNotification {
            let grouped=Dictionary(grouping:workspace.insights?.aging ?? [],by:{$0.customerId})
            for (id,rows) in grouped.sorted(by:{$0.key<$1.key}).prefix(50) {
                guard generation==updateGeneration else{return}
                guard let due=rows.map(\.dueDate).min(),let date=BusinessDate.parse(due) else{continue}
                var calendar=Calendar(identifier:.gregorian);calendar.timeZone=TimeZone(identifier:"Asia/Shanghai")!
                let nextDay=calendar.date(byAdding:.day,value:1,to:date)!
                let atNine=calendar.date(bySettingHour:9,minute:0,second:0,of:nextDay)!
                let next=atNine>Date() ? atNine : calendar.nextDate(after:Date(),matching:DateComponents(hour:9),matchingPolicy:.nextTime)!
                var parts=calendar.dateComponents([.year,.month,.day,.hour,.minute],from:next);parts.timeZone=calendar.timeZone
                let content=UNMutableNotificationContent();content.title="龍成ERP · 回款核对提醒";content.body="按最近同步的账期，有客户货款需要核对。打开 App 刷新实际回款状态。";content.sound = .default
                let identifier="overdue-\(generation)-"+id
                try? await center.add(UNNotificationRequest(identifier:identifier,content:content,trigger:UNCalendarNotificationTrigger(dateMatching:parts,repeats:false)))
                if generation != updateGeneration{center.removePendingNotificationRequests(withIdentifiers:[identifier]);return}
            }
        }
    }
}

struct PreferencesView:View {
    @ObservedObject private var preferences=AppPreferences.shared
    @ObservedObject private var notifications=FinanceNotifications.shared
    @EnvironmentObject var lock:AppLock
    @EnvironmentObject var client:FinanceClient
    var body:some View {
        Form {
            Section("外观") {
                Picker("显示模式",selection:$preferences.appearance){Text("跟随系统").tag("system");Text("浅色").tag("light");Text("深色").tag("dark")}
                Picker("强调色",selection:$preferences.accentColor){Text("蓝色").tag("blue");Text("青绿色").tag("teal")}
                Toggle("隐藏敏感金额",isOn:$preferences.hideSensitiveAmounts)
            }
            Section("身份保护") {
                Toggle("Face ID / Touch ID 解锁",isOn:Binding(get:{preferences.faceIdEnabled},set:{enabled in Task{if enabled{_ = await lock.authenticate(enabling:true)}else{await lock.disable()}}})).disabled(lock.authenticating)
                Text("生物识别由苹果系统验证；不保存密码或面容数据。登录会话到期后仍需输入公司账号密码。").font(.footnote).foregroundStyle(.secondary)
                if let error=lock.error{Text(error).foregroundStyle(.secondary)}
            }
            if client.user?.isStockRole != true {
            Section("提醒") {
                Toggle("每日经营日报提醒",isOn:$preferences.dailyReportNotification)
                Picker("日报时间（北京时间）",selection:$preferences.dailyHour){ForEach(0..<24){Text(String(format:"%02d:00",$0)).tag($0)}}
                Toggle("客户逾期提醒",isOn:$preferences.overdueNotification)
                Button("允许系统通知"){Task{await notifications.request(workspace:client.workspace);if client.user?.role=="owner"{await RemoteNotices.shared.register();await client.syncPushDevice()}}}
                Text(notifications.status).font(.footnote).foregroundStyle(.secondary)
                Text("提醒不显示客户姓名或金额。日报与逾期为本地提醒，打开 App 后更新。老板的财务操作通知使用苹果远程推送，需后台完成配置。").font(.footnote).foregroundStyle(.secondary)
            }
            Section("首页卡片 · 拖动排序") {
                ForEach(preferences.homeWidgets,id:\.self){key in Text(["balance":"余额","receivable":"应收","payable":"应付","profit":"利润"][key] ?? key)}.onMove{source,destination in preferences.homeWidgets.move(fromOffsets:source,toOffset:destination)}
            }.environment(\.editMode,.constant(.active))
            }
        }.navigationTitle("外观与隐私")
        .onChange(of:preferences.dailyReportNotification){_,_ in Task{await notifications.schedule(client.workspace)}}
        .onChange(of:preferences.overdueNotification){_,_ in Task{await notifications.schedule(client.workspace)}}
        .onChange(of:preferences.dailyHour){_,_ in Task{await notifications.schedule(client.workspace)}}
    }
}
