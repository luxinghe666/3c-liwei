# 云端 UI 开发与本地验证

## 1. 本次准备范围

本分支用于读取现有 ERP 源码并开展后续独立 UI 开发。网页、后端、SwiftUI 工程、资源、单元测试及经销商 OpenAPI 规范均保留。生产数据库、客户/财务数据、私有密钥、证书、完整联调回执和本机运维记录不作为开发依赖。

当前为本地准备状态，尚未推送或上线。是否允许 GitHub 推送由用户单独确认；不得以本说明作为部署授权。

## 2. 依赖与准备

- Node.js 24，最低 24.13.0；需要该版本的内置 SQLite API。
- 现有 Web 和服务端无需第三方 npm 包，无额外安装步骤。
- 浏览器用于网页预览；运行 HTTP 测试需要本机监听端口权限。
- SwiftUI 的编译、运行和视觉验收需要 Mac 上的 Xcode 与 iOS 模拟器组件。通用 Linux 环境不包含 Apple 的 SwiftUI/UIKit SDK。
- 不向云端注入生产 Secret、APNs 私钥、企业微信 Secret、爱签私钥、SSH 密钥或真实数据库。

## 3. 安全启动现有网页

```sh
node --version
npm run dev:cloud
```

该包装入口专供源码预览：监听 `127.0.0.1:4318`，每次启动都在仓库内 `.local/` 目录新建隔离测试账本；显式禁用企业微信登录/通知、爱签、经销商真实集成和订单同步，不启动 APNs 或同步后台线程。它不会自动加载 `.env`。若只有 Node 没有 npm，可直接运行 `node scripts/start-cloud-dev.mjs`。若端口冲突，可运行：

```sh
CLOUD_UI_PORT=4381 npm run dev:cloud
```

打开对应本机地址的 `/login.html`，按页面创建**虚构测试账号**。测试密码仅用于这个空白账本，不复用公司账号密码。界面操作只使用模拟客户、商品和金额。

若云端预览工具需要端口转发，使用该环境提供的受控预览机制；不要把生产服务器或生产域名指向测试容器。默认启动只绑定回环地址，不擅自修改防火墙或开放公网端口。

`server/start.mjs` 是原有通用启动器，其默认 `DB_PATH` 为 `data/finance.sqlite`，并可能从进程环境启用外部配置。UI 开发不使用带有真实环境变量的 `npm start`。以下变量均不得填入真实值：

| 集成 | 原有配置或启用方式 | UI 开发要求 |
| --- | --- | --- |
| 企业微信 | `WECOM_CORP_ID`、`WECOM_AGENT_ID`、`WECOM_SECRET`、`WECOM_REDIRECT_URI`、`WECOM_CALLBACK_HOSTS` | 不配置真实账号；预览入口显式禁用 |
| 小程序同步 | `LONGCHENG_SYNC_SECRET`、`LONGCHENG_EVENT_URL` | 不配置，不启动同步线程 |
| iOS 推送 | `APNS_KEY_PATH`、`APNS_KEY_ID`、`APNS_TEAM_ID`、`APNS_TOPIC` | 不提供密钥，不启动推送线程 |
| 经销商 API | `createApplication` 中显式传入 `dealerConfig`，要求隔离标记 | 普通 UI 预览不启用 |
| 爱签 | `asignConfig` 及测试应用、模板、签署人和密钥 | 普通 UI 预览不启用；保留适配器源码供理解 |

## 4. 验证清单

### 单仓库可执行

```sh
npm run check
npm test
npm run test:offline
node --test dealer-api.test.mjs dealer-multi-api.test.mjs scripts/api-contract/*.test.mjs
npm run test:wecom:orders
```

测试使用独立临时目录或 `.test-data/` 中新建的测试 SQLite 文件。企业微信单元/HTTP 路由测试使用注入的模拟接口，不需要真实企业账号。

`test:offline` 是现有脚本名，不等于所有用例都不监听端口；若执行环境禁止本机监听，应如实报告该限制。`npm test` 也不是自动涵盖仓库里每个 `*.test.mjs` 的全量命令，应根据修改补充相关测试。

不要执行无筛选的 `node --test` 并默认所有测试都可在单仓库通过。

### 依赖另一个仓库的测试

`dealer-http.test.mjs`、`dealer-multi-http.test.mjs`、`asign-http.test.mjs` 通过 `scripts/run-dealer-local.mjs` 启动 ERP 与小程序两个 HTTP 服务，需要另一份经销商小程序源码，至少包括：

- `backend/service.mjs`
- `backend/server.mjs`
- `backend/erp-purchase-client.mjs`
- `backend/contracts/erp-dealer-v1.openapi.json`

既有测试包含原开发机的默认路径及契约文件绝对路径断言。仅上传本 ERP 仓库不会使这些跨仓库测试自动可移植。本轮不为通过测试改写业务逻辑，也不获取另一仓库的真实数据；需要单独授权准备脱敏的小程序源码及测试路径适配后，再运行这些测试。

爱签 HTTP 测试中的提供方可通过模拟接口注入；它不代表完成了一次真实签署。真实授权、真实通知与真人签署始终另行安排。

### Mac 上的 SwiftUI 验证

```sh
npm run test:swift
xcodebuild -project ios/YuantuoFinance.xcodeproj \
  -scheme YuantuoFinance -configuration Debug \
  -sdk iphonesimulator -destination 'generic/platform=iOS Simulator' \
  -derivedDataPath .build/ui2-source-simulator \
  CODE_SIGNING_ALLOWED=NO build
```

`test:swift` 当前脚本编译 macOS 上的模型契约测试，不等同于完整 iPhone UI 编译。无签名模拟器构建无需发布证书。`ios/Production.xcconfig` 可选引用未入库的 `Release.xcconfig`；发布预检缺失真实配置时失败是预期保护，不能填造参数绕过。

## 5. UI 2.0 后续实施

1. 从经批准的源码分支创建独立 UI 工作分支。
2. 建立 `ui-demo/web/` 与 `ui-demo/ios/`，所有数据明确标识模拟。
3. 复用现有页面信息结构、字段和组件风格；不调用生产业务接口。
4. 五岗位展示与当前四角色差异只在演示层表达；不改变服务端角色权限。
5. 交付可运行预览、截图、覆盖清单和实际测试结果，等待老板验收。
6. 只有另获授权后才制定分模块迁移方案；不在本轮覆盖既有 ERP。

## 6. 提交前检查

检查待提交清单与 Git 历史，禁止 `git add -f` 强制纳入被忽略的数据。确保新增资源来自模拟界面，截图不含真实个人资料、金融数据或授权链接。源码中的已有域名、产品名称和公开支持信息并不是可使用的访问凭证，也不授权云端访问真实系统。
