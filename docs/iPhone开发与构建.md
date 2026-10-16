# 原拓财务 iPhone 工程

更新于 2026-10-16，开发版本 0.3.0 / build 3。

## 当前实现

使用 SwiftUI 原生界面，最低系统设为 iOS 17，仅 iPhone。包含登录、月度经营概览、资金账户及流水、客户销售、供应商采购、SN 库存搜索、修改密码和退出。录入表单覆盖客户回款、公司费用、内部转账、老板垫款及还款、供应商预付、采购锁货/发货/整单到货、单台销售、整单客户退货和月度税费。

金额以整数分传输，不在手机重新实现利润分配规则。`GET /api/workspace?month=YYYY-MM` 一次返回同版本账本和服务端汇总。手机提交同样经过会话、来源、CSRF、版本冲突、账期、角色和业务验证。

凭证保存在设备钥匙串，仅解锁可读、不随备份迁移，不保存密码。不持久缓存完整账本。业务请求发出前保存原账号、原服务器、版本、提交标识和内容；丢失响应后只能按原内容确认，重启后也保留。提交使用排序后的 JSON，避免字典顺序改变服务器幂等哈希。HTTP 重定向被拒绝，避免发送凭证或记账内容到跳转地址。切入后台时覆盖账本界面。

## 本机构建

1. 用户已安装并打开 Xcode。已核实完整 Xcode 27.1（27A9275）位于 `~/Downloads/Xcode.app`，包含 iOS / Simulator 27.1 SDK。当前系统默认开发路径可能仍为 Command Line Tools；终端构建应设置 `DEVELOPER_DIR` 为该 App 的 `Contents/Developer`。
2. 打开 `ios/YuantuoFinance.xcodeproj`，选择共享 Scheme `YuantuoFinance` 和 iPhone 模拟器。Debug 默认访问 `http://127.0.0.1:4318`；本地先运行 `npm start` 并在浏览器创建测试账号。真机应连接可访问的 HTTPS 测试服务器，设备的 127.0.0.1 不是电脑地址。
3. 正式构建前，复制 `ios/Release.example.xcconfig` 为 `ios/Release.xcconfig`，填写实际 Apple Team 和 HTTPS 地址。该文件已忽略，不提交账号配置。当前 Bundle ID 是草稿，须在开发者账号核实并注册。
4. 配好签名后运行 `npm run ios:archive`，或在 Xcode 选择 Archive。构建脚本拒绝缺少 Team 或正式 HTTPS 地址。归档后在 Organizer 验证并上传 App Store Connect，不选择仅限内部测试的特殊分发包，以便后续走正式审核。

工程文件可由 `npm run ios:project` 重新生成；修改构建设置时同步修改 `scripts/make-ios-project.mjs`。图标由 `scripts/draw-app-icon.swift` 绘制，成品 PNG 已包含在工程。

## 已执行验证

- 后端与业务测试 45 项通过，新增手机汇总的一致性、参数验证、权限以及幂等重试测试。
- Swift 核心 29 项断言通过：金额精度/上限、非法输入、HTTPS 来源限制、待确认提交序列化、跨重启请求字节一致、服务端完整样本解码。
- 全部 Swift 文件使用本机 Swift 6.4 与 macOS 26.5 SDK、macOS 14 目标通过类型检查。这验证共享 API/模型和 SwiftUI 语法，不代表已完成 iOS SDK 编译、模拟器或真机运行。
- Xcode 工程和 plist 通过格式检查，1024 像素无透明通道图标已生成并查看。
- `Models.swift`、`SecureStore.swift`、`FinanceClient.swift` 已用完整 Xcode 的 iPhone Simulator 27.1 SDK、iOS 17 目标通过类型检查。

完整 Xcode 已尝试模拟器构建：授予临时目录后解决了构建记录写入问题，但构建脚本仍在 `sandbox-exec: sandbox_apply: Operation not permitted` 处失败；单独检查 SwiftUI 时，苹果宏插件也因同一沙盒限制无法启动。CoreSimulator 服务连接失败，尚不能判断运行时是否安装完整。没有关闭 Xcode 的脚本沙盒或 Swift 插件安全机制。已请用户在本机 Xcode 窗口选择 iPhone 模拟器并运行，必要时下载模拟器组件。这些环境错误不代表已成功完成 iOS UI 编译或运行。

## 提交前仍需实际验证

- iOS 编译、签名、真机首次登录、钥匙串持久化和会话过期。
- 保存途中断网、强制结束 App、重新启动确认、同账号与不同账号切换；核对没有重复资金流水。
- 两人同时录入、公司停用员工、关账、跨月退货、回款分摊、手机和电脑金额一致。
- 小屏与大字体、键盘遮挡、VoiceOver、后台切换、各个录入确认框与金额展示。
- 真实服务器性能和备份恢复；当前接口读完整账本，扩展数据前要分页和压测。
- 手机单据为基础单台/整单流程，部分到货、批量销售、导入、期初、配件平均成本和完整更正等业务仍需补齐，不能作为正式替代博远 ERP 的已完成功能。

当前没有 IPA，没有上传 TestFlight，没有提交 App Review，没有上架完成。
