//
//  SWStatusBadge.swift
//  ShipSwift
//
//  Capsule-shaped status badge with five preset semantic styles. Designed for
//  list rows, headers, and detail screens where a short status label needs to
//  pop visually without dominating the layout.
//
//  Each style renders as a translucent background (color × 0.18 / .20 for the
//  brighter `success` case), the same color used for the foreground text, and
//  a faint matching stroke (color × 0.35) on the capsule border. The result is
//  legible in both light and dark mode without per-style overrides.
//
//  Usage:
//    // Preset style with LocalizedStringKey (recommended for static text)
//    SWStatusBadge(text: "In Stock", style: .success)
//    SWStatusBadge(text: "Pending Review", style: .warning)
//
//    // Dynamic String (e.g. server-driven label)
//    SWStatusBadge(text: order.statusName, style: .info)
//
//    // Combine with your own enum by mapping to SWStatusBadgeStyle
//    SWStatusBadge(text: order.status.displayName, style: order.status.badgeStyle)
//
//  Style cases:
//    .info     -- blue
//    .success  -- green
//    .warning  -- orange
//    .error    -- red
//    .neutral  -- gray / secondary
//
//  Created by Wei Zhong on 5/11/26.
//

// Vendored under the MIT License; see LICENSE.txt and SOURCE.md.

import SwiftUI

// MARK: - SWStatusBadgeStyle

/// Semantic style preset for `SWStatusBadge`.
///
/// Each case maps to a single tint color that drives the background fill,
/// the foreground text color, and the capsule stroke.
enum SWStatusBadgeStyle: CaseIterable {
    case info
    case success
    case warning
    case error
    case neutral

    /// Foreground color (text + stroke base).
    var tint: Color {
        switch self {
        case .info:    .blue
        case .success: .green
        case .warning: .orange
        case .error:   .red
        case .neutral: .secondary
        }
    }

    /// Background tint opacity. `success` is bumped slightly to compensate
    /// for green appearing visually lighter at the same alpha.
    var backgroundOpacity: Double {
        switch self {
        case .success: 0.20
        default:       0.18
        }
    }
}

// MARK: - SWStatusBadge

struct SWStatusBadge: View {
    // MARK: - Properties

    let text: LocalizedStringKey
    let style: SWStatusBadgeStyle

    // MARK: - Initializers

    /// Create a status badge with a `LocalizedStringKey` label.
    /// Recommended for static text that should be localized via `Localizable.xcstrings`.
    init(text: LocalizedStringKey, style: SWStatusBadgeStyle) {
        self.text = text
        self.style = style
    }

    /// Create a status badge with a dynamic `String` label.
    /// Use this for server-driven or runtime-formatted text where localization
    /// keys are not available.
    init(text: String, style: SWStatusBadgeStyle) {
        self.text = LocalizedStringKey(text)
        self.style = style
    }

    // MARK: - Body

    var body: some View {
        Text(text)
            .font(.caption)
            .fontWeight(.semibold)
            .fixedSize(horizontal: false, vertical: true)
            .padding(.horizontal, 10)
            .padding(.vertical, 4)
            .foregroundStyle(style.tint)
            .background(
                Capsule().fill(style.tint.opacity(style.backgroundOpacity))
            )
            .overlay(
                Capsule().stroke(style.tint.opacity(0.35), lineWidth: 0.5)
            )
    }
}
