import SwiftUI

enum FinanceStyle {
    static var accent:Color { UserDefaults.standard.string(forKey:"accentColor")=="teal" ? .teal : .blue }
    static let spacing: CGFloat = 16
}

struct MoneyText: View {
    @ObservedObject private var amountPreferences = AppPreferences.shared
    let amount: Int64
    var body: some View {
        Text(Money.display(amount)).monospacedDigit()
            .minimumScaleFactor(0.7).lineLimit(1)
    }
}

struct FinanceEmpty: View {
    @ObservedObject private var amountPreferences = AppPreferences.shared
    let title: String
    let symbol: String
    let detail: String
    var body: some View {
        ContentUnavailableView(title, systemImage: symbol, description: Text(detail))
            .listRowBackground(Color.clear)
    }
}
