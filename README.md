# 原拓 ERP / 龍成 ERP — UI 2.0 开发用源码

本分支保存现有网页版、Node.js 后端及 SwiftUI iPhone App 的源码，供后续独立制作 UI 2.0。原项目中的「龍成 ERP」名称、工程名称及 Bundle ID 保留兼容关系；本次没有重命名应用或修改业务规则。

**这是源码准备分支，不是生产发布版本。** 当前未推送、未部署、未发布 App。数据库、真实业务资料、密钥、签名证书、私有配置和原始联调记录不随源码提供。仓库中的测试夹具仅用于模拟测试。

## 技术与目录

| 路径 | 内容 |
| --- | --- |
| `dist/` | 原生 HTML、CSS、JavaScript ES Modules 网页源码；无需前端打包器，不能当作可删除的构建产物 |
| `server/` | Node.js HTTP 服务、SQLite 存储、业务命令、岗位权限、ERP 及集成适配器 |
| `ios/YuantuoFinance/` | SwiftUI iPhone 页面、模型、网络客户端及资源 |
| `ios/YuantuoFinance.xcodeproj/` | 原生 Xcode 工程与共享 Scheme |
| `ios/Tests/` | Swift 模型及交互数据契约测试 |
| `*.test.mjs` | Node 内置测试运行器使用的测试 |
| `scripts/api-contract/` | API 签名、契约及模拟业务测试 |
| `docs/api/` | 经销商统一 OpenAPI 规范与爱签空白配置示例 |
| `preview/` | 历史交互原型，不代表现行后端能力 |
| `deploy/`、`Dockerfile`、`compose.yaml` | 既有部署源码，保留供阅读；本轮禁止执行部署 |
| `third-party/`、`ios/.../ThirdParty/` | 第三方组件来源和许可，随使用的组件保留 |

当前运行依赖是 **Node.js 24，最低 24.13.0**，使用内置 `node:sqlite`、HTTP、密码学及测试模块。`package.json` 没有第三方 npm 运行依赖，不需要为启动执行 `npm install`。iPhone 的 SwiftUI 编译和模拟器运行需要 macOS、Xcode 及对应 iOS SDK。

## 推荐：隔离本地预览

在本仓库目录运行：

```sh
node --version
npm run dev:cloud
```

默认访问 `http://127.0.0.1:4318/login.html`。该入口每次启动都在 `.local/` 创建新的隔离测试数据库，明确禁用企业微信、爱签、经销商真实接口、APNs 和订单同步工作线程；不加载私有 `.env`。可用 `CLOUD_UI_PORT` 设置其他本机端口。首次使用只建立虚构的测试账号，后续也只录入模拟数据。若环境只有 Node 而没有 npm，可直接执行 `node scripts/start-cloud-dev.mjs`。

该命令运行的是现有 ERP 的隔离预览，**不是已经完成的 UI 2.0**。如果要修改 UI，请遵守 `AGENTS.md`，另建分支及 `ui-demo/` 等独立目录。

不要把生产数据库复制进 `.local/`；不要以生产登录账号或真实密码初始化测试账本。`npm start` 保留原有启动行为，可能读取环境中的外部集成配置，云端 UI 开发不以它作为默认入口。

## 单仓库验证

```sh
npm run check
npm test
node --test dealer-api.test.mjs dealer-multi-api.test.mjs scripts/api-contract/*.test.mjs
npm run test:wecom:orders
```

这些测试使用测试夹具、独立 SQLite 文件及注入的模拟外部接口。部分 HTTP 测试需允许本机端口监听；不要为通过测试开放真实企业微信、爱签或生产系统访问。

本次实际验证与已知的日期相关失败见 [源码准备审计报告](docs/SOURCE_SYNC_AUDIT.md)，不能将上述命令列表理解为全部已通过。

双仓库真实 HTTP 测试另有依赖，不能将本仓库的单独克隆描述为已经具备完整双系统联调环境：`dealer-http.test.mjs`、`dealer-multi-http.test.mjs` 和 `asign-http.test.mjs` 依赖独立小程序源码，部分契约核对仍有原开发机路径。详见 [云端开发说明](docs/CLOUD_DEVELOPMENT.md)。

## iPhone 源码

在 Mac 上用 Xcode 打开 `ios/YuantuoFinance.xcodeproj`，选择 `YuantuoFinance` Scheme 和 iPhone 模拟器，以 Debug 运行。Debug 默认服务器为本机 `http://127.0.0.1:4318`；先启动隔离后台。真机的回环地址不是 Mac，不应通过修改生产配置解决预览问题。

无签名的模拟器编译示例：

```sh
xcodebuild -project ios/YuantuoFinance.xcodeproj \
  -scheme YuantuoFinance -configuration Debug \
  -sdk iphonesimulator -destination 'generic/platform=iOS Simulator' \
  -derivedDataPath .build/ui2-source-simulator \
  CODE_SIGNING_ALLOWED=NO build
```

通用 Linux 容器可读取和修改 Swift 源码，但不能据此声称完成 Apple SDK 编译或 iPhone 模拟器验收；相关验证须回到 Mac/Xcode。发布所需的 `ios/Release.xcconfig`、证书、私钥和导出配置不在源码中，也不需要上传到 UI 开发环境。

## 开发边界

- UI 2.0 使用独立分支、独立页面和模拟数据，不覆盖 `dist/` 或现有 SwiftUI 页面。
- 不改变采购、销售、库存、SN、财务、权限、订单状态、API 或数据库结构。
- 不执行部署脚本、真实同步、真实通知、合同签署、App 归档上传或生产数据迁移。
- 不自动合并主分支；待老板验收后另行授权分模块迁移。

继续阅读：[业务基线](docs/BUSINESS_BASELINE.md) · [云端开发说明](docs/CLOUD_DEVELOPMENT.md) · [开发约束](AGENTS.md)。
