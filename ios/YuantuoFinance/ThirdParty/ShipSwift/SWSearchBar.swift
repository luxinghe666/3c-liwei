//
//  SWSearchBar.swift
//  ShipSwift
//
//  Capsule-shaped search bar with a magnifying-glass icon, an inline text
//  field, and an auto-appearing clear button. Uses `.ultraThinMaterial` as
//  its background for a frosted look that sits nicely on top of gradients
//  or glassy surfaces.
//
//  The component does NOT apply any outer horizontal padding — the caller
//  is expected to wrap it with `.padding(.horizontal)` (or similar) so the
//  bar can be reused in different layouts without fighting the caller's
//  spacing rules.
//
//  Usage:
//    @State private var query = ""
//
//    SWSearchBar(text: $query)
//        .padding(.horizontal)
//
//    // With a custom placeholder:
//    SWSearchBar(text: $query, placeholder: "Search contacts")
//        .padding(.horizontal)
//
//  Parameters:
//    text        — two-way binding to the current search string
//    placeholder — prompt shown when the field is empty (default: "Search")
//

// Vendored under the MIT License; see LICENSE.txt and SOURCE.md.
// Local accessibility adaptations are documented in SOURCE.md.

import SwiftUI

struct SWSearchBar: View {
    /// Two-way binding to the current search text.
    @Binding var text: String
    /// Placeholder shown when the field is empty.
    var placeholder: String = "Search"
    // Local opt-in for the app's expanding search presentation.
    var autoFocus: Bool = false
    @FocusState private var fieldFocused: Bool

    var body: some View {
        HStack(spacing: 8) {
            Image(systemName: "magnifyingglass")
                .foregroundStyle(.secondary)
                .accessibilityHidden(true)

            TextField(placeholder, text: $text)
                .focused($fieldFocused)
                .autocorrectionDisabled()
                #if os(iOS)
                .textInputAutocapitalization(.never)
                #endif
                .accessibilityLabel(Text(placeholder))

            if !text.isEmpty {
                Button {
                    text = ""
                } label: {
                    Image(systemName: "xmark.circle.fill")
                        .foregroundStyle(.secondary)
                        .frame(minWidth: 44, minHeight: 44)
                        .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .accessibilityLabel("清除搜索")
            }
        }
        .font(.body)
        .frame(minHeight: 44)
        .padding(.horizontal, 12)
        .padding(.vertical, 4)
        .background(.ultraThinMaterial, in: .capsule)
        .onAppear { if autoFocus { fieldFocused = true } }
    }
}
