# ShipSwift vendored components

These files come from the official [SignerLabs/ShipSwift repository](https://github.com/signerlabs/ShipSwift), pinned to commit `f71ada2ea5187c316a3e67a37a6c8f5932ca13b2`.

License: MIT, Copyright (c) 2026 SignerLabs. The complete unmodified upstream license is retained in [LICENSE.txt](LICENSE.txt). Original source headers and author credits are preserved.

| Local file | Upstream path | Upstream Git blob |
| --- | --- | --- |
| SWKPICard.swift | ShipSwift/SWPackage/SWComponent/Display/SWKPICard.swift | `0679ae742a8066603bb412aa195bb7d069c43370` |
| SWStatusBadge.swift | ShipSwift/SWPackage/SWComponent/Display/SWStatusBadge.swift | `01794187d622a1d424daf1430daa5dd762b0a33b` |
| SWSearchBar.swift | ShipSwift/SWPackage/SWComponent/Input/SWSearchBar.swift | `e21aad6371d1d67b06ae828a37be0b9a37e9c092` |
| LICENSE.txt | LICENSE | `54e95cc8d1188045cd6f0954afdf2f1b685d47f9` |

## Local adaptations

- Removed demo `#Preview` blocks; production components do not require preview macros, sample data, or external assets.
- Kept existing initializer call sites and style cases compatible; no package manager or additional dependency is used.
- KPI card: preserve semantic Dynamic Type fonts; use monospaced digits and allow the value to grow vertically; combine card text for VoiceOver and hide decorative symbols.
- The upstream `SWKPIDeltaTag` is retained as source but is not a source of financial calculations or invented comparison data. Its decorative arrow is hidden from VoiceOver.
- Status badge: preserve semantic caption font and allow vertically expanding text.
- Search bar: replace fixed 14-point font with semantic body font; set at least a 44-point field/clear-button target; add a Chinese clear-action accessibility label; hide the decorative search symbol. Disable iOS automatic capitalization behind an `os(iOS)` guard so the source can also be type-checked against macOS SwiftUI.
- The KPI value remains a preformatted `String`. The application formats its integer-cent money separately.

## APIs used by 龍成ERP

```swift
SWKPICard(title: "账户资金", value: amountText, icon: "creditcard", tint: .teal)
SWStatusBadge(text: "部分收款", style: .warning)
SWSearchBar(text: $query, placeholder: "日期、账户、备注")
```

`SWKPICard` also accepts an optional trailing `@ViewBuilder` closure.
`SWStatusBadgeStyle` provides `info`, `success`, `warning`, `error`, and `neutral`.

The ShipSwift Skills repository is a separate optional authoring aid; this integration copies actual official component source and does not install or execute a Skills package.

The app's `Interactions.swift` and `InteractionModels.swift` are original app code, not ShipSwift exports. They implement save feedback, linked account selection, an expandable profit-card stack, snapping account cards, a transfer-direction line, and the native month wheel. The search bar also has a documented local `autoFocus: Bool = false` option: expanding the search wrapper focuses its actual TextField; collapse retains the query and dismisses the field. The other two vendored components are unchanged by this interaction batch. `PresentationInteractions.swift` and `AccountDetailInteraction.swift` are also app-owned components, not official ShipSwift component names.
