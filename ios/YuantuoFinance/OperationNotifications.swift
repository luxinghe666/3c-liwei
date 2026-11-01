import SwiftUI
import UserNotifications
import UIKit

struct OperationNotice:Decodable,Identifiable {
    let id:String;let revision:Int;let actor:String;let title:String;let created_at:String;let read:Bool;let detail:NoticeDetail
}
struct NoticeDetail:Decodable {let actionId:String;let type:String;let businessDate:String;let reason:String;let rows:[NoticeChange];let truncated:Bool}
struct NoticeChange:Decodable {let label:String;let before:String;let after:String;let money:Bool
    func display(_ value:String)->String{money ? Int64(value).map{Money.display($0)} ?? value:value}
}
struct NoticesReply:Decodable {let notifications:[OperationNotice];let unread:Int;let nextCursor:Int?;let pushConfigured:Bool}

@MainActor final class RemoteNotices:NSObject,ObservableObject {
    static let shared=RemoteNotices()
    @Published var token:String?
    @Published var openInbox=false
    @Published var status="系统推送尚未注册"
    let installationID:String
    override init(){let key="pushInstallationID";installationID=UserDefaults.standard.string(forKey:key) ?? UUID().uuidString;super.init();UserDefaults.standard.set(installationID,forKey:key)}
    var environment:String {
        #if DEBUG
        return "development"
        #else
        return "production"
        #endif
    }
    func register() async {
        let settings=await UNUserNotificationCenter.current().notificationSettings()
        guard settings.authorizationStatus == .authorized || settings.authorizationStatus == .provisional else{status="请先允许系统通知";return}
        #if targetEnvironment(simulator)
        status="系统远程推送需在已签名的 iPhone 真机验证"
        #else
        UIApplication.shared.registerForRemoteNotifications()
        #endif
    }
    func badge(_ count:Int) async {try? await UNUserNotificationCenter.current().setBadgeCount(count)}
    func clear(){token=nil;openInbox=false;UIApplication.shared.unregisterForRemoteNotifications();Task{await badge(0)}}
}
final class FinanceAppDelegate:NSObject,UIApplicationDelegate,UNUserNotificationCenterDelegate {
    func application(_ application:UIApplication,didFinishLaunchingWithOptions launchOptions:[UIApplication.LaunchOptionsKey:Any]?=nil)->Bool{UNUserNotificationCenter.current().delegate=self;return true}
    func application(_ application:UIApplication,didRegisterForRemoteNotificationsWithDeviceToken deviceToken:Data){let token=deviceToken.map{String(format:"%02x",$0)}.joined();Task{@MainActor in RemoteNotices.shared.token=token;RemoteNotices.shared.status="设备已注册，等待后台确认"}}
    func application(_ application:UIApplication,didFailToRegisterForRemoteNotificationsWithError error:Error){Task{@MainActor in RemoteNotices.shared.status="推送注册未完成，请检查真机签名与推送权限"}}
    func userNotificationCenter(_ center:UNUserNotificationCenter,willPresent notification:UNNotification) async->UNNotificationPresentationOptions{return [.banner,.sound,.badge]}
    func userNotificationCenter(_ center:UNUserNotificationCenter,didReceive response:UNNotificationResponse) async {
        if response.notification.request.content.userInfo["notificationId"] != nil {await MainActor.run{RemoteNotices.shared.openInbox=true}}
    }
}

struct OperationNotificationsView:View {
    @EnvironmentObject var client:FinanceClient
    @ObservedObject private var preferences=AppPreferences.shared
    @ObservedObject private var remote=RemoteNotices.shared
    @State private var selected:OperationNotice?
    var body:some View {List{
        Section {
            Text("财务保存成功后生成通知。可查看新增、更正和撤销记录，确认操作人及修改内容。").font(.footnote)
            if client.workspace?.capabilities?["operationNotifications"] != true {
                Text("请更新并重启后台，启用财务操作通知。").font(.footnote).foregroundStyle(.secondary)
            } else if let notices=client.notices {
                if !notices.pushConfigured {Text("App 内通知已接通；服务器尚未配置苹果推送。").font(.footnote).foregroundStyle(.secondary)}
            } else if client.noticeError == nil {
                ProgressView("正在读取通知")
            }
            Text(remote.status).font(.footnote).foregroundStyle(.secondary)
            Button("启用 iPhone 系统通知"){Task{await FinanceNotifications.shared.request(workspace:client.workspace);await remote.register();await client.syncPushDevice()}}
        }
        if let error=client.noticeError {Text(error).foregroundStyle(.secondary)}
        ForEach(client.notices?.notifications ?? []){n in
            Button{selected=n;Task{await client.markNoticesRead([n.id])}}label:{
                HStack(alignment:.top){
                    Image(systemName:n.read ? "envelope.open":"envelope.badge").foregroundStyle(FinanceStyle.accent)
                    VStack(alignment:.leading,spacing:6){
                        Text(n.title).foregroundStyle(.primary)
                        Text(n.actor+" · "+n.detail.businessDate).font(.subheadline).foregroundStyle(.secondary)
                        Text("账本版本 \(n.revision)").font(.caption).foregroundStyle(.secondary)
                    }
                }
            }
        }
        if client.notices?.notifications.isEmpty == true {Text("暂无财务操作通知").foregroundStyle(.secondary)}
        if client.notices?.nextCursor != nil {Button("加载更早通知"){Task{await client.refreshNotices(more:true)}}}
    }.navigationTitle("财务操作通知").toolbar{Button("本页已读"){Task{await client.markNoticesRead(client.notices?.notifications.map(\.id) ?? [])}}.disabled((client.notices?.unread ?? 0)==0)}
    .task{await client.refreshNotices();await remote.register();await client.syncPushDevice()}.refreshable{await client.refreshNotices()}
    .sheet(item:$selected){n in NavigationStack{NoticeDetailView(notice:n)}}}
}
struct NoticeDetailView:View {
    @ObservedObject private var preferences=AppPreferences.shared
    @Environment(\.dismiss) private var dismiss
    let notice:OperationNotice
    var body:some View{List{
        Section {LabeledContent("操作人",value:notice.actor);LabeledContent("业务日期",value:notice.detail.businessDate);LabeledContent("操作记录",value:notice.detail.actionId);Text("保存时间："+notice.created_at).font(.caption);if !notice.detail.reason.isEmpty{Text(notice.detail.reason)}}
        Section("修改前 → 修改后"){ForEach(Array(notice.detail.rows.enumerated()),id:\.offset){_,row in VStack(alignment:.leading,spacing:8){Text(row.label).font(.subheadline);Text(row.display(row.before)+" → "+row.display(row.after)).monospacedDigit()}}}
        if notice.detail.truncated {Text("本单变动较多，完整记录可在网页端操作审计查看。").font(.footnote)}
    }.navigationTitle(notice.title).toolbar{Button("关闭"){dismiss()}}}
}
