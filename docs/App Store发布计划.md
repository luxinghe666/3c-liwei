# 原拓财务 App Store 发布进度

2026-10-16。用户已确认：App 名称“原拓财务”，个人开发者发行，支持邮箱 1921344174@qq.com。iPhone 使用 App，电脑继续使用浏览器，公司内部员工登录使用。没有服务器或域名，用户要求先确认部署方案与费用。

## 当前成果

- v0.2 已有 Node / SQLite 共享账本、真实登录、角色权限、服务端业务规则、审计、关账与备份恢复。
- v0.3 增加 SwiftUI iPhone 工程、原生查询与业务表单、钥匙串凭证、持久保存的提交重试记录，以及同版本账本/利润汇总接口。
- 已准备图标、隐私政策和支持页草稿、商店中文文案、Docker/HTTPS 配置及服务器终端初始化。
- 业务与后端 45 项测试通过，Swift 核心 29 项断言通过，SwiftUI 通过本机 macOS SDK 类型检查。iOS 构建与真机尚未验证。详见 [iPhone 开发与构建](iPhone开发与构建.md)。

## 外部条件

| 项目 | 实际状态 | 下一步 |
| --- | --- | --- |
| Apple Developer | 已登录核实，仍显示“加入 Apple Developer Program” | 本人在 Apple Developer App 完成注册、身份、协议和会员购买 |
| Xcode | 官方 27.1 安装包已下载；自动解压受系统执行环境限制 | 用户解压安装，首次打开完成组件安装 |
| 云后台 | 尚未购买、部署 | 用户确认 [部署方案与费用](部署方案与费用.md)，再核对具体订单 |
| 域名 / HTTPS | 尚无正式地址 | 购买域名、解析、证书、外网验证 |
| 发布主体 | 个人 | 商店开发者名称使用本人法定姓名，不能用品牌代替 |
| 发布地区 | 尚未确定 | 确定实际地区及相关备案资料，不自动排除中国大陆 |
| Bundle ID / 签名 | 草稿 com.luxinghe.yuantuofinance，未注册 | 会员开通后核对可用性、Team 与分发证书 |
| 审核资料 | 本地草稿 | 补真实联系姓名/电话、正式政策、隐私标签和原生截图 |

会员费官方为每年 99 美元，付款页按地区显示当地币种。服务器建议年度预算不超过 700 元，另计 Apple 会员，尚未获购买批准。不得把预算估算当作付款结果。

## 接下来执行顺序

1. 完整 Xcode 就绪后进行 iOS SDK 编译、模拟器、真机及断网恢复测试，修复实际发现的问题。
2. 补齐正式试用所需的期初建账、博远导入与去重、完整更正、配件成本等业务，使用数据副本与现有账单核对。
3. 用户批准后部署后台，验证 HTTPS、会话撤销、备份恢复与性能，补齐政策中的运营主体/服务器/保存期限。
4. 实现审核演示账号与真实账本的隔离。当前单账本结构不能仅靠创建另一个账号隔离数据，因此不能交付真实老板账号给审核。
5. 建立 App Store Connect 记录，上传签名构建，TestFlight 内部测试；填写隐私资料、联系资料和实际功能截图。
6. 完整可用后提交 App Review。适合内部使用的 Unlisted 发行可在符合条件后向 Apple 申请；批准前不得宣称只通过链接分发，链接本身也不保护数据。
7. 根据 Apple 返回的实际问题修改并重新提交，审核通过并实际可安装才算上架完成。

## 提交文案

本地草稿位于 `appstore/metadata.zh-Hans.json`。支持页面为 `/support.html`，政策页面为 `/privacy.html`。它们还没有公开 HTTPS URL。当前没有真实 iPhone 截图，不以网页截图冒充原生 App 截图。App 当前无公开注册、广告、统计 SDK 或内购，隐私声明必须随实际实现继续核对。

## 官方依据

- [Apple 个人注册与会员费](https://developer.apple.com/cn/programs/enroll/)
- [2026 年 4 月起上传要求：Xcode 26 / iOS 26 SDK 或更新](https://developer.apple.com/news/upcoming-requirements/?id=02032026a)
- [审核指南：功能完整、审核账号及后端可访问](https://developer.apple.com/app-store/review/guidelines/)
- [TestFlight](https://developer.apple.com/testflight/)
- [Unlisted 发行要求](https://developer.apple.com/support/unlisted-app-distribution/)
- [App 信息及中国大陆所需资料](https://developer.apple.com/cn/help/app-store-connect/reference/app-information/app-information/)

**没有上传安装包、没有提交审核、没有上架。** 以上是当前真实进度，不是已完成发行的声明。
