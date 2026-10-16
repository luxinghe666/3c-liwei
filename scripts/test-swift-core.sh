#!/bin/sh
set -eu
cd "$(dirname "$0")/.."
mkdir -p .build/tmp .build/module-cache
export TMPDIR="$PWD/.build/tmp"
NODE="${NODE_BINARY:-node}"
SWIFTC="${SWIFT_COMPILER:-$(xcrun --find swiftc)}"
"$NODE" --input-type=module -e 'import {writeFileSync} from "node:fs"; import {newBook} from "./server/book.mjs"; import {summary} from "./dist/model.js"; const state=newBook("demo"); writeFileSync(".build/swift-fixture.json",JSON.stringify({revision:0,state,month:"2026-10",report:summary(state,"2026-10")}));'
SDK="${SWIFT_SDK:-$(xcrun --sdk macosx --show-sdk-path)}"
"$SWIFTC" -sdk "$SDK" -target "$(uname -m)-apple-macosx14.0" -module-cache-path .build/module-cache ios/YuantuoFinance/Models.swift ios/Tests/CoreTests.swift -o .build/swift-core-tests
.build/swift-core-tests .build/swift-fixture.json
