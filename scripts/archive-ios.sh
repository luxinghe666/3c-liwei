#!/bin/sh
set -eu
cd "$(dirname "$0")/.."
test -f ios/Release.xcconfig || { echo '请先填写 ios/Release.xcconfig 的 Apple Team 和 HTTPS 后台地址'; exit 1; }
xcodebuild -version
xcodebuild -project ios/YuantuoFinance.xcodeproj -scheme YuantuoFinance -configuration Release -destination 'generic/platform=iOS' -archivePath "$PWD/.build/YuantuoFinance.xcarchive" -derivedDataPath "$PWD/.build/DerivedData" archive
echo '归档完成。请在 Xcode Organizer 验证后选择 App Store Connect 分发；这条命令不会上传。'
