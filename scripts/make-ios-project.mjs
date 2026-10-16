// Deterministic Xcode project generator. Run from the repository root with Node 24.
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
const objects = {};
const id = name => createHash('sha1').update(name).digest('hex').slice(0,24).toUpperCase();
function add(name, object) { const key = id(name); objects[key] = object; return key; }
function serialize(value, indent = 0) {
  const pad = '\t'.repeat(indent);
  if (Array.isArray(value)) return `(\n${value.map(v=>pad+'\t'+serialize(v,indent+1)+',').join('\n')}\n${pad})`;
  if (value && typeof value === 'object') return `{\n${Object.entries(value).map(([k,v])=>`${pad}\t${JSON.stringify(k)} = ${serialize(v,indent+1)};`).join('\n')}\n${pad}}`;
  return JSON.stringify(String(value));
}
const swift = ['Models.swift','SecureStore.swift','FinanceClient.swift','Views.swift','EntryView.swift','YuantuoFinanceApp.swift'];
const resources = [['Assets.xcassets','folder.assetcatalog'],['PrivacyInfo.xcprivacy','text.xml']];
const sourceRefs = swift.map(name=>add(name,{isa:'PBXFileReference',lastKnownFileType:'sourcecode.swift',path:name,sourceTree:'<group>'}));
const resourceRefs = resources.map(([name,type])=>add(name,{isa:'PBXFileReference',lastKnownFileType:type,path:name,sourceTree:'<group>'}));
const infoRefs = ['Info.plist','Info-Debug.plist'].map(name=>add(name,{isa:'PBXFileReference',lastKnownFileType:'text.plist.xml',path:name,sourceTree:'<group>'}));
const product = add('product',{isa:'PBXFileReference',explicitFileType:'wrapper.application',includeInIndex:0,path:'YuantuoFinance.app',sourceTree:'BUILT_PRODUCTS_DIR'});
const sourcesPhase = add('sources',{isa:'PBXSourcesBuildPhase',buildActionMask:2147483647,files:sourceRefs.map(ref=>add('build-'+ref,{isa:'PBXBuildFile',fileRef:ref})),runOnlyForDeploymentPostprocessing:0});
const resourcesPhase = add('resources',{isa:'PBXResourcesBuildPhase',buildActionMask:2147483647,files:resourceRefs.map(ref=>add('build-'+ref,{isa:'PBXBuildFile',fileRef:ref})),runOnlyForDeploymentPostprocessing:0});
const frameworks = add('frameworks',{isa:'PBXFrameworksBuildPhase',buildActionMask:2147483647,files:[],runOnlyForDeploymentPostprocessing:0});
const validate = add('validate',{isa:'PBXShellScriptBuildPhase',buildActionMask:2147483647,files:[],inputPaths:[],outputPaths:[],runOnlyForDeploymentPostprocessing:0,shellPath:'/bin/sh',shellScript:'if [ "$CONFIGURATION" = "Release" ]; then\n case "$FINANCE_SERVER_URL" in https://*) ;; *) echo "error: Configure a real HTTPS server in Release.xcconfig"; exit 1;; esac\n case "$FINANCE_SERVER_URL" in *localhost*|*127.0.0.1*|*example.com*|*\'$\'*) echo "error: Invalid production server"; exit 1;; esac\n [ -n "$DEVELOPMENT_TEAM" ] || { echo "error: Configure Apple DEVELOPMENT_TEAM"; exit 1; }\nfi\n'});
const configs = ['Debug','Release'];
const xcconfig = configs.map(name=>add(name+'-xcconfig',{isa:'PBXFileReference',lastKnownFileType:'text.xcconfig',path:name==='Debug'?'Debug.xcconfig':'Production.xcconfig',sourceTree:'<group>'}));
const projectConfig = add('project-config',{isa:'XCConfigurationList',buildConfigurations:configs.map(name=>add('project-'+name,{isa:'XCBuildConfiguration',name,buildSettings:{CLANG_ENABLE_MODULES:'YES',SWIFT_VERSION:'5.0',IPHONEOS_DEPLOYMENT_TARGET:'17.0',SDKROOT:'iphoneos',DEBUG_INFORMATION_FORMAT:name==='Release'?'dwarf-with-dsym':'dwarf'}})),defaultConfigurationIsVisible:0,defaultConfigurationName:'Release'});
const targetConfig = add('target-config',{isa:'XCConfigurationList',buildConfigurations:configs.map((name,i)=>add('target-'+name,{isa:'XCBuildConfiguration',name,baseConfigurationReference:xcconfig[i],buildSettings:{PRODUCT_NAME:'YuantuoFinance',PRODUCT_BUNDLE_IDENTIFIER:'com.luxinghe.yuantuofinance',MARKETING_VERSION:'0.3.0',CURRENT_PROJECT_VERSION:'3',TARGETED_DEVICE_FAMILY:'1',SUPPORTED_PLATFORMS:'iphoneos iphonesimulator',SUPPORTS_MACCATALYST:'NO',SUPPORTS_MAC_DESIGNED_FOR_IPHONE_IPAD:'NO',CODE_SIGN_STYLE:'Automatic',GENERATE_INFOPLIST_FILE:'NO',ASSETCATALOG_COMPILER_APPICON_NAME:'AppIcon',SWIFT_EMIT_LOC_STRINGS:'YES',ENABLE_USER_SCRIPT_SANDBOXING:'YES',LD_RUNPATH_SEARCH_PATHS:['$(inherited)','@executable_path/Frameworks']}})),defaultConfigurationIsVisible:0,defaultConfigurationName:'Release'});
const target = add('target',{isa:'PBXNativeTarget',name:'YuantuoFinance',productName:'YuantuoFinance',productType:'com.apple.product-type.application',productReference:product,buildConfigurationList:targetConfig,buildPhases:[validate,sourcesPhase,frameworks,resourcesPhase],buildRules:[],dependencies:[]});
const sourceGroup = add('source-group',{isa:'PBXGroup',children:[...sourceRefs,...resourceRefs,...infoRefs],path:'YuantuoFinance',sourceTree:'<group>'});
const productGroup = add('products-group',{isa:'PBXGroup',children:[product],name:'Products',sourceTree:'<group>'});
const group = add('root-group',{isa:'PBXGroup',children:[sourceGroup,...xcconfig,productGroup],sourceTree:'<group>'});
const project = add('project',{isa:'PBXProject',attributes:{BuildIndependentTargetsInParallel:'YES',LastUpgradeCheck:'2710'},buildConfigurationList:projectConfig,compatibilityVersion:'Xcode 14.0',developmentRegion:'zh-Hans',knownRegions:['zh-Hans','en','Base'],mainGroup:group,productRefGroup:productGroup,projectDirPath:'',projectRoot:'',targets:[target]});
await mkdir('ios/YuantuoFinance.xcodeproj/xcshareddata/xcschemes',{recursive:true});
await writeFile('ios/YuantuoFinance.xcodeproj/project.pbxproj','// !$*UTF8*$!\n'+serialize({archiveVersion:1,classes:{},objectVersion:56,objects,rootObject:project})+'\n');
const ref=`<BuildableReference BuildableIdentifier="primary" BlueprintIdentifier="${target}" BuildableName="YuantuoFinance.app" BlueprintName="YuantuoFinance" ReferencedContainer="container:YuantuoFinance.xcodeproj"/>`;
await writeFile('ios/YuantuoFinance.xcodeproj/xcshareddata/xcschemes/YuantuoFinance.xcscheme',`<?xml version="1.0" encoding="UTF-8"?><Scheme LastUpgradeVersion="2710" version="1.3"><BuildAction parallelizeBuildables="YES" buildImplicitDependencies="YES"><BuildActionEntries><BuildActionEntry buildForTesting="YES" buildForRunning="YES" buildForProfiling="YES" buildForArchiving="YES" buildForAnalyzing="YES">${ref}</BuildActionEntry></BuildActionEntries></BuildAction><TestAction buildConfiguration="Debug" selectedDebuggerIdentifier="Xcode.DebuggerFoundation.Debugger.LLDB" selectedLauncherIdentifier="Xcode.IDEFoundation.Launcher.LLDB"/><LaunchAction buildConfiguration="Debug" selectedDebuggerIdentifier="Xcode.DebuggerFoundation.Debugger.LLDB" selectedLauncherIdentifier="Xcode.IDEFoundation.Launcher.LLDB" launchStyle="0" useCustomWorkingDirectory="NO" ignoresPersistentStateOnLaunch="NO" debugDocumentVersioning="YES" debugServiceExtension="internal" allowLocationSimulation="YES"><BuildableProductRunnable runnableDebuggingMode="0">${ref}</BuildableProductRunnable></LaunchAction><ProfileAction buildConfiguration="Release" shouldUseLaunchSchemeArgsEnv="YES" savedToolIdentifier="" useCustomWorkingDirectory="NO" debugDocumentVersioning="YES"><BuildableProductRunnable runnableDebuggingMode="0">${ref}</BuildableProductRunnable></ProfileAction><AnalyzeAction buildConfiguration="Debug"/><ArchiveAction buildConfiguration="Release" revealArchiveInOrganizer="YES"/></Scheme>\n`);
const info = await readFile('ios/YuantuoFinance/Info.plist','utf8');
await writeFile('ios/YuantuoFinance/Info-Debug.plist',info.replace('</dict></plist>','<key>NSAppTransportSecurity</key><dict><key>NSAllowsLocalNetworking</key><true/></dict></dict></plist>'));
await mkdir('ios/YuantuoFinance/Assets.xcassets/AppIcon.appiconset',{recursive:true});
await writeFile('ios/YuantuoFinance/Assets.xcassets/Contents.json',JSON.stringify({info:{author:'xcode',version:1}},null,2)+'\n');
await writeFile('ios/YuantuoFinance/Assets.xcassets/AppIcon.appiconset/Contents.json',JSON.stringify({images:[{filename:'AppIcon.png',idiom:'universal',platform:'ios',size:'1024x1024'}],info:{author:'xcode',version:1}},null,2)+'\n');
console.log('Generated iPhone Xcode project; signing and server configuration remain required.');
