#!/usr/bin/env node
// Read-only, offline source checks. Never builds, signs, contacts a server, or opens a keychain.
import { readFileSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, resolve, relative, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';

const repository = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const expected = { bundle: 'com.luxinghe.yuantuofinance', team: 'Z8BM943XG8', host: 'finance.yuantuo.vip' };

// Respect xcconfig's // comments: a URL must use https:/$()/host in the source file.
export function stripConfigComment(line) {
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    if (line[i] === '"' && line[i - 1] !== '\\') quoted = !quoted;
    if (!quoted && line.slice(i, i + 2) === '//') return line.slice(0, i);
  }
  return line;
}

export function resolveBuildValue(value, settings, seen = new Set()) {
  return String(value ?? '').replace(/\$\(([^)]*)\)|\$\{([^}]*)\}/g, (match, round, curly) => {
    const key = round ?? curly;
    if (key === '') return '';
    if (seen.has(key) || !(key in settings)) return match;
    return resolveBuildValue(settings[key], settings, new Set([...seen, key]));
  });
}

export function releaseURLProblem(value, allowedHost = expected.host) {
  if (!value) return 'Release 后台地址尚未填写；等待备案通过及真实 HTTPS 验证。';
  if (/\$|[\s]/.test(value)) return 'Release 后台地址含未解析变量或空白。';
  let url;
  try { url = new URL(value); } catch { return 'Release 后台地址不是完整 URL；检查 xcconfig 的 // 注释。'; }
  if (url.protocol !== 'https:') return 'Release 后台必须使用 HTTPS。';
  if (url.username || url.password || url.search || url.hash) return '后台地址不能带账号、密码、查询参数或片段。';
  if (url.hostname !== allowedHost || (url.port && url.port !== '443') || url.pathname !== '/') {
    return `Release 后台应为 https://${allowedHost}，请核对域名、端口和路径。`;
  }
  return null;
}

export function inspectPNG(buffer) {
  if (buffer.length < 33 || !buffer.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) {
    throw new Error('图标不是有效的 PNG。');
  }
  let width, height, colorType, transparency = false, end = false;
  for (let offset = 8; offset + 12 <= buffer.length;) {
    const length = buffer.readUInt32BE(offset);
    if (offset + 12 + length > buffer.length) throw new Error('PNG 数据不完整。');
    const type = buffer.toString('ascii', offset + 4, offset + 8);
    if (offset === 8 && (type !== 'IHDR' || length !== 13)) throw new Error('PNG 缺少 IHDR。');
    if (type === 'IHDR') {
      width = buffer.readUInt32BE(offset + 8); height = buffer.readUInt32BE(offset + 12);
      colorType = buffer[offset + 17];
    }
    if (type === 'tRNS') transparency = true;
    if (type === 'IEND') { end = true; break; }
    offset += length + 12;
  }
  if (!end) throw new Error('PNG 缺少结束块。');
  return { width, height, alpha: [4, 6].includes(colorType) || transparency };
}

function within(root, path) {
  const delta = relative(root, path);
  if (delta.startsWith('..') || isAbsolute(delta)) throw new Error('配置引用了 iOS 工程目录之外的文件。');
  return path;
}

export function readConfig(path, root, stack = new Set()) {
  within(root, path);
  if (stack.has(path)) throw new Error('xcconfig 出现循环 include。');
  const result = {};
  for (const original of readFileSync(path, 'utf8').split(/\r?\n/)) {
    const line = stripConfigComment(original).trim();
    if (!line) continue;
    const include = line.match(/^#include(\?)?\s+"([^"]+)"$/);
    if (include) {
      const next = within(root, resolve(dirname(path), include[2]));
      if (include[1] && !existsSync(next)) continue;
      Object.assign(result, readConfig(next, root, new Set([...stack, path])));
      continue;
    }
    const assignment = line.match(/^([A-Z_][A-Z_0-9]*)\s*=\s*(.*?)\s*$/);
    if (!assignment) throw new Error('xcconfig 含检查器尚不支持的语法；需要人工核对。');
    result[assignment[1]] = assignment[2].replace(/^"(.*)"$/, '$1');
  }
  return result;
}

function plist(path) {
  const result = spawnSync('/usr/bin/plutil', ['-convert', 'json', '-o', '-', path], { encoding: 'utf8' });
  if (result.error || result.status !== 0) throw new Error(`无法解析 ${relative(repository, path)}；此检查需要 macOS plutil。`);
  return JSON.parse(result.stdout);
}

export function runPreflight(root = repository) {
  const checks = [];
  const add = (id, status, message) => checks.push({ id, status, message });
  const check = (id, passed, message, failure) => add(id, passed ? 'pass' : 'fail', passed ? message : failure);
  const ios = resolve(root, 'ios');
  try {
    const project = plist(resolve(ios, 'YuantuoFinance.xcodeproj/project.pbxproj'));
    const objects = project.objects;
    const targets = Object.values(objects).filter(o => o.isa === 'PBXNativeTarget' && o.name === 'YuantuoFinance');
    if (targets.length !== 1) throw new Error('找不到唯一 YuantuoFinance App target。');
    const target = targets[0];
    const release = objects[objects[target.buildConfigurationList].buildConfigurations.find(id => objects[id].name === 'Release')];
    const projectRoot = objects[project.rootObject];
    const projectRelease = objects[objects[projectRoot.buildConfigurationList].buildConfigurations.find(id => objects[id].name === 'Release')];
    if (!release || !projectRelease) throw new Error('工程缺少 Release 配置。');
    const baseFile = objects[release.baseConfigurationReference]?.path;
    if (!baseFile) throw new Error('Release 没有关联 xcconfig。');
    const config = readConfig(within(ios, resolve(ios, baseFile)), ios);
    const settings = { ...projectRelease.buildSettings, ...config, ...release.buildSettings };
    const value = key => resolveBuildValue(settings[key], settings);
    check('release-config', baseFile === 'Production.xcconfig' && value('INFOPLIST_FILE') === 'YuantuoFinance/Info.plist',
      'Release 使用 Production.xcconfig 和正式 Info.plist。', 'Release 关联了错误的配置或 Debug Info.plist。');
    check('bundle-id', value('PRODUCT_BUNDLE_IDENTIFIER') === expected.bundle, `Bundle ID：${expected.bundle}`, 'Bundle ID 与现有 App 记录不一致。');
    if (!value('DEVELOPMENT_TEAM')) add('team', 'blocked', 'Apple Team 尚未填写。');
    else check('team', value('DEVELOPMENT_TEAM') === expected.team, `Team：${expected.team}；未查询证书或描述文件。`, 'Apple Team 与已确认团队不一致。');
    const marketing = value('MARKETING_VERSION'), build = value('CURRENT_PROJECT_VERSION');
    const packageVersion = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8')).version;
    check('version', /^\d+\.\d+\.\d+$/.test(marketing) && /^[1-9]\d*$/.test(build) && marketing === packageVersion,
      `版本 ${marketing} (${build})，与 package.json 一致；未查询 App Store Connect 是否已使用此构建号。`, '版本格式无效，或与 package.json 不一致。');
    const urlProblem = releaseURLProblem(value('FINANCE_SERVER_URL'));
    add('release-url', urlProblem ? 'blocked' : 'pass', urlProblem ?? 'Release URL 格式和目标域名正确；在线可达性未验证。');

    const info = plist(within(ios, resolve(ios, value('INFOPLIST_FILE'))));
    const mappings = { CFBundleIdentifier: 'PRODUCT_BUNDLE_IDENTIFIER', CFBundleShortVersionString: 'MARKETING_VERSION', CFBundleVersion: 'CURRENT_PROJECT_VERSION', FinanceServerURL: 'FINANCE_SERVER_URL' };
    check('info-bindings', Object.entries(mappings).every(([k, v]) => info[k] === `$(${v})`), 'Info.plist 使用工程版本、Bundle ID 和后台地址。', 'Info.plist 有硬编码或缺少必要构建变量。');
    check('app-info', info.CFBundleDisplayName === '龍成ERP' && info.CFBundlePackageType === 'APPL' && info.LSRequiresIPhoneOS === true,
      'App 名称和 iOS 应用类型正确。', 'App 名称或 iOS 应用类型不正确。');
    check('face-id-purpose', typeof info.NSFaceIDUsageDescription === 'string' && info.NSFaceIDUsageDescription.trim().length > 0,
      'Face ID 使用说明已填写。', '缺少 Face ID 使用说明。');
    check('transport-security', !info.NSAppTransportSecurity || Object.keys(info.NSAppTransportSecurity).length === 0,
      'Release 未放宽 App Transport Security。', 'Release 存在 ATS 例外，需要人工复核。');
    check('encryption-declaration', info.ITSAppUsesNonExemptEncryption === false,
      '已声明不使用非豁免加密；仍须确认发行代码的实际加密用途。', '加密声明缺失或已变化，需要重新核对。');
    check('signing-config', value('CODE_SIGN_STYLE') === 'Automatic' && value('ENABLE_USER_SCRIPT_SANDBOXING') === 'YES',
      '自动签名及构建脚本沙盒保持开启。', '自动签名或构建脚本沙盒配置异常。');
    const entitlementsPath = value('CODE_SIGN_ENTITLEMENTS[sdk=iphoneos*]') || value('CODE_SIGN_ENTITLEMENTS');
    if (!entitlementsPath) throw new Error('Release 真机签名未关联推送 entitlements。');
    const entitlements = plist(within(ios, resolve(ios, entitlementsPath)));
    check('push-entitlements', resolveBuildValue(entitlements['aps-environment'], settings) === 'production',
      'Release APNs entitlement 为 production；服务器推送凭据及真机投递仍需验证。', 'Release APNs entitlement 不是 production。');

    const resources = target.buildPhases.flatMap(id => objects[id].isa === 'PBXResourcesBuildPhase' ? objects[id].files : []).map(id => objects[objects[id].fileRef]?.path);
    check('bundled-resources', ['Assets.xcassets', 'PrivacyInfo.xcprivacy', 'ThirdParty/ShipSwift/LICENSE.txt'].every(path => resources.includes(path)),
      '图标资源、隐私清单及 ShipSwift 许可证已关联 App 资源。', 'App target 缺少图标、隐私清单或组件许可证资源。');
    const privacy = plist(resolve(ios, 'YuantuoFinance/PrivacyInfo.xcprivacy'));
    check('privacy-tracking', privacy.NSPrivacyTracking === false && Array.isArray(privacy.NSPrivacyTrackingDomains) && privacy.NSPrivacyTrackingDomains.length === 0,
      '隐私清单声明无跟踪及跟踪域名。', '跟踪声明缺失或已变化，需要复核。');
    const defaults = privacy.NSPrivacyAccessedAPITypes?.find(item => item.NSPrivacyAccessedAPIType === 'NSPrivacyAccessedAPICategoryUserDefaults');
    check('privacy-user-defaults', defaults?.NSPrivacyAccessedAPITypeReasons?.includes('CA92.1'), 'UserDefaults 必需原因 CA92.1 已声明。', 'UserDefaults 必需原因声明缺失。');
    const collected = privacy.NSPrivacyCollectedDataTypes;
    const expectedTypes = ['Name', 'UserID', 'OtherFinancialInfo', 'OtherUserContent', 'ProductInteraction', 'DeviceID'];
    check('privacy-data', Array.isArray(collected) && expectedTypes.every(type => collected.some(item => item.NSPrivacyCollectedDataType === `NSPrivacyCollectedDataType${type}` && item.NSPrivacyCollectedDataTypeLinked === true && item.NSPrivacyCollectedDataTypeTracking === false && item.NSPrivacyCollectedDataTypePurposes?.includes('NSPrivacyCollectedDataTypePurposeAppFunctionality'))),
      '已声明当前账本、账号、操作与设备标识数据用途；本检查不代替 App 隐私问卷核对。', '隐私清单的数据类型或用途与当前基线不一致。');

    const catalogName = value('ASSETCATALOG_COMPILER_APPICON_NAME');
    const iconFolder = within(ios, resolve(ios, `YuantuoFinance/Assets.xcassets/${catalogName}.appiconset`));
    const catalog = JSON.parse(readFileSync(resolve(iconFolder, 'Contents.json'), 'utf8'));
    const images = catalog.images?.filter(image => image.filename && image.size === '1024x1024' && image.idiom === 'universal' && image.platform === 'ios') ?? [];
    if (!images.length) throw new Error('图标目录缺少 1024×1024 iOS 通用图标。');
    for (const [i, icon] of images.entries()) {
      const png = inspectPNG(readFileSync(within(iconFolder, resolve(iconFolder, icon.filename))));
      check(`app-icon-${i + 1}`, png.width === 1024 && png.height === 1024 && !png.alpha,
        '1024×1024 PNG 图标无 alpha 通道或透明块。', 'App 图标尺寸不正确或包含透明信息。');
    }
    const scheme = readFileSync(resolve(ios, 'YuantuoFinance.xcodeproj/xcshareddata/xcschemes/YuantuoFinance.xcscheme'), 'utf8');
    check('archive-scheme', /<ArchiveAction\s[^>]*buildConfiguration="Release"/.test(scheme), '共享 Scheme 的 Archive 使用 Release。', '共享 Scheme 的 Archive 不是 Release。');
    const validation = target.buildPhases.map(id => objects[id]).find(phase => phase.isa === 'PBXShellScriptBuildPhase' && phase.name === 'Validate Release Configuration');
    check('release-build-guard', validation?.shellScript?.includes('FINANCE_SERVER_URL') && validation.shellScript.includes('DEVELOPMENT_TEAM') && validation.shellScript.includes('exit 1'),
      '工程保留 Release 地址及 Team 的构建阻断检查。', '工程缺少 Release 构建阻断检查。');
  } catch (error) { add('source-read', 'fail', error.message); }
  add('live-verification', 'pending', '离线未验证：备案通过、公网 HTTPS、真实登录、正式账本备份恢复、APNs 投递。');
  add('distribution-verification', 'pending', '离线未验证：签名证书和描述文件、完整 Archive、Organizer 验证、构建号未被使用、上传及 Apple 处理结果。');
  return {
    mode: 'offline-read-only',
    preparationPassed: !checks.some(c => c.status === 'fail'),
    configurationReady: !checks.some(c => ['fail', 'blocked'].includes(c.status)),
    uploadReadiness: 'not_verified_offline',
    checks,
  };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const flags = process.argv.slice(2);
  if (flags.some(flag => !['--json', '--require-release', '--help'].includes(flag))) {
    console.error('用法：node scripts/preflight-ios.mjs [--json] [--require-release]'); process.exit(1);
  }
  if (flags.includes('--help')) {
    console.log('只读离线检查，无网络、不编译、不签名、不安装依赖、不写数据。\n默认：源文件检查失败退出 1，尚缺发布配置列为阻塞但退出 0。\n--require-release：源文件通过但发布配置缺失退出 2。\n--json：输出机器可读报告。检查通过不代表已验证上线或可以上传。');
  } else {
    const report = runPreflight();
    if (flags.includes('--json')) console.log(JSON.stringify(report, null, 2));
    else {
      const labels = { pass: '通过', fail: '失败', blocked: '阻塞', pending: '待验证' };
      console.log('iOS 上传前离线检查（未编译、未连接服务器、未签名）');
      for (const item of report.checks) console.log(`[${labels[item.status]}] ${item.message}`);
      console.log(`离线准备：${report.preparationPassed ? '通过' : '未通过'}；发布配置：${report.configurationReady ? '就绪' : '未就绪'}；实际上传条件：仍需在线与归档验证。`);
    }
    process.exitCode = !report.preparationPassed ? 1 : flags.includes('--require-release') && !report.configurationReady ? 2 : 0;
  }
}
