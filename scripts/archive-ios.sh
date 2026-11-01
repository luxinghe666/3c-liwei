#!/bin/sh
set -eu
cd "$(dirname "$0")/.."
test -f ios/Release.xcconfig || { echo '请先填写 ios/Release.xcconfig 的 Apple Team 和 HTTPS 后台地址'; exit 1; }
# Select a full Xcode for this command without changing global xcode-select.
if [ -z "${DEVELOPER_DIR:-}" ]; then
  archive_selected_developer=$(/usr/bin/xcode-select -p 2>/dev/null || true)
  for archive_developer in "$archive_selected_developer" /Applications/Xcode.app/Contents/Developer "$HOME/Downloads/Xcode.app/Contents/Developer"; do
    if [ -d "$archive_developer/Platforms/iPhoneOS.platform" ]; then
      DEVELOPER_DIR="$archive_developer"
      export DEVELOPER_DIR
      break
    fi
  done
fi
[ -d "${DEVELOPER_DIR:-}/Platforms/iPhoneOS.platform" ] || { echo '请安装完整 Xcode，或用 DEVELOPER_DIR 指定其 Contents/Developer 路径'; exit 1; }
/usr/bin/xcodebuild -version
/usr/bin/xcodebuild -project ios/YuantuoFinance.xcodeproj -scheme YuantuoFinance -configuration Release -destination 'generic/platform=iOS' -archivePath "$PWD/.build/YuantuoFinance.xcarchive" -derivedDataPath "$PWD/.build/DerivedData" archive
echo '归档完成。请在 Xcode Organizer 验证后选择 App Store Connect 分发；这条命令不会上传。'
